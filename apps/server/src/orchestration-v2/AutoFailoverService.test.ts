// @effect-diagnostics nodeBuiltinImport:off -- Exercises the routing state file through a real temp directory.
import {
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  autoTurnsToday,
  clearAutoCooldowns,
  configureAutoRoutingState,
  isAutoCoolingDown,
  markAutoCooldown,
  recordAutoTurn,
  withAutoBudgetWindows,
} from "./AutoCooldown.ts";
import { admitFailover, autoFailoverPlan, MAX_FAILOVERS_PER_HOUR } from "./AutoFailoverService.ts";

const now = Date.parse("2026-11-14T20:00:00.000Z");
const runId = RunId.make("run:thread:t1:ordinal:3");

function shell(overrides: Partial<Record<string, unknown>> = {}): OrchestrationV2ThreadShell {
  return {
    id: ThreadId.make("t1"),
    providerInstanceId: ProviderInstanceId.make("claudeAuto"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAuto"),
      model: "claude-opus-5-5",
      options: [
        { id: "effort", value: "medium" },
        { id: "auto", value: "medium" },
      ],
    },
    latestRunId: runId,
    lineage: {
      rootThreadId: ThreadId.make("t1"),
      parentThreadId: null,
      relationshipToParent: null,
    },
    creationSource: "user",
    status: "failed",
    lastErrorClass: "usage_limit",
    lastErrorCode: "api_error_429",
    usageLimitResetAt: null,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    ...overrides,
  } as unknown as OrchestrationV2ThreadShell;
}

const plan = (s: OrchestrationV2ThreadShell) =>
  autoFailoverPlan({ shell: s, runId, failedInstanceId: "claudeAuto", nowMs: now });

describe("autoFailoverPlan", () => {
  it("sends a limited Auto thread back through Auto at its level", () => {
    const result = plan(shell());
    expect(result?.command).toMatchObject({
      type: "message.dispatch",
      threadId: "t1",
      modelSelection: { instanceId: "claudeAuto", model: "auto-medium" },
      dispatchMode: { type: "start_immediately" },
      createdBy: "agent",
      creationSource: "server",
    });
    expect(result?.command.commandId).toBe(`server:auto-failover:t1:${runId}`);
    // No reported reset: a 30 minute bench.
    expect(result?.cooldownUntilMs).toBe(now + 30 * 60_000);
  });

  it("benches the instance until the reported reset", () => {
    const resetAt = "2026-11-14T23:00:00.000Z";
    expect(plan(shell({ usageLimitResetAt: resetAt }))?.cooldownUntilMs).toBe(Date.parse(resetAt));
  });

  it("fails over on no-capacity errors for a short bench", () => {
    const result = plan(shell({ lastErrorClass: "provider_error", lastErrorCode: "UNAVAILABLE" }));
    expect(result?.cooldownUntilMs).toBe(now + 5 * 60_000);
  });

  it("benches a lapsed Claude plan like a limit without a reset", () => {
    // A cancelled plan's token still says "pro", so Auto kept picking it and every turn failed.
    const lapsed = shell({
      lastErrorClass: "provider_error",
      lastErrorCode: "api_error_403",
      lastError:
        "Claude Code can't use your Claude subscription, usually because a payment is past due · Pay or renew at https://claude.ai/settings/billing (if you just paid, try again shortly), or use an Anthropic API key instead",
    });
    expect(plan(lapsed)?.cooldownUntilMs).toBe(now + 30 * 60_000);
    // A lapsed plan covers the whole account, not one model's quota.
    expect(plan(lapsed)?.modelLimit).toBe(false);
  });

  it("marks only a usage limit as a per-model limit", () => {
    expect(plan(shell())?.modelLimit).toBe(true);
    expect(
      plan(shell({ lastErrorClass: "provider_error", lastErrorCode: "UNAVAILABLE" }))?.modelLimit,
    ).toBe(false);
  });

  it("moves a hand-picked thread to Auto at the level its model implies", () => {
    const picked = (model: string) =>
      shell({ modelSelection: { instanceId: ProviderInstanceId.make("grok"), model } });
    expect(plan(picked("grok-4.7"))?.command.modelSelection).toEqual({
      instanceId: "grok",
      model: "auto-medium",
    });
    expect(plan(picked("gpt-6.1-sol"))?.command.modelSelection?.model).toBe("auto-medium");
    expect(plan(picked("gpt-6.2-sol"))?.command.modelSelection?.model).toBe("auto-medium");
    expect(plan(picked("gpt-6.2-astra"))?.command.modelSelection?.model).toBe("auto-high");
    expect(plan(picked("gpt-6.1-terra"))?.command.modelSelection?.model).toBe("auto-low");
    expect(plan(picked("claude-haiku-5-5"))?.command.modelSelection?.model).toBe("auto-low");
    // A delegated thread keeps the model its parent chose.
    const delegated = {
      rootThreadId: ThreadId.make("t0"),
      parentThreadId: ThreadId.make("t0"),
      relationshipToParent: "subagent",
    };
    expect(plan(shell({ ...picked("grok-4.7"), lineage: delegated }))).toBeNull();
  });

  it("leaves other failures, stale runs and workflow steps alone", () => {
    expect(
      plan(shell({ lastErrorClass: "provider_error", lastErrorCode: "api_error_404" })),
    ).toBeNull();
    expect(
      plan(
        shell({
          lastErrorClass: "provider_error",
          lastErrorCode: "api_error_403",
          lastError: "Request not allowed",
        }),
      ),
    ).toBeNull();
    expect(plan(shell({ latestRunId: RunId.make("run:newer") }))).toBeNull();
    expect(plan(shell({ status: "idle" }))).toBeNull();
    expect(plan(shell({ settledOverride: "settled" }))).toBeNull();
    // The workflow retries a step whose turn died.
    const step = {
      rootThreadId: ThreadId.make("t1"),
      parentThreadId: null,
      relationshipToParent: null,
      workflowStep: true,
    };
    expect(plan(shell({ lineage: step }))).toBeNull();
  });
});

describe("admitFailover", () => {
  it("leaves a provider's own subagent alone, which cannot receive messages", () => {
    const lineage = {
      rootThreadId: ThreadId.make("t0"),
      parentThreadId: ThreadId.make("t0"),
      relationshipToParent: "subagent",
    };
    expect(plan(shell({ lineage, creationSource: "provider" }))).toBeNull();
    // A delegate_task child takes messages like any thread.
    expect(plan(shell({ lineage, creationSource: "agent" }))).not.toBeNull();
  });

  it("caps failovers per thread per hour", () => {
    const history: Array<number> = [];
    for (let i = 0; i < MAX_FAILOVERS_PER_HOUR; i++)
      expect(admitFailover(history, now + i)).toBe(true);
    expect(admitFailover(history, now + 10)).toBe(false);
    expect(admitFailover(history, now + 61 * 60_000)).toBe(true);
  });
});

describe("AutoCooldown", () => {
  it("benches an instance until the time passes", () => {
    clearAutoCooldowns();
    markAutoCooldown("claudeAuto", now + 1000);
    markAutoCooldown("claudeAuto", now + 500);
    expect(isAutoCoolingDown("claudeAuto", "*", now + 999)).toBe(true);
    expect(isAutoCoolingDown("claudeAuto", "*", now + 1000)).toBe(false);
    expect(isAutoCoolingDown("claudeAutoB", "*", now)).toBe(false);
  });

  it("benches only the Antigravity quota pool that ran out", () => {
    clearAutoCooldowns();
    markAutoCooldown("antigravity_2", now + 60_000, "gemini-pro");
    expect(isAutoCoolingDown("antigravity_2", "gemini-pro", now)).toBe(true);
    expect(isAutoCoolingDown("antigravity_2", "claude-4-6", now)).toBe(false);
    expect(isAutoCoolingDown("antigravity_2", "gemini-flash", now)).toBe(false);
    expect(isAutoCoolingDown("antigravity", "gemini-pro", now)).toBe(false);
    // The whole-instance pool benches every pool of that instance.
    markAutoCooldown("antigravity", now + 60_000);
    expect(isAutoCoolingDown("antigravity", "gemini-flash", now)).toBe(true);
  });

  it("counts today's turns per instance and pool", () => {
    clearAutoCooldowns();
    const yesterday = now - 24 * 60 * 60_000;
    recordAutoTurn("antigravity", "gemini-pro", yesterday);
    recordAutoTurn("antigravity", "gemini-pro", now);
    recordAutoTurn("antigravity", "gemini-pro", now);
    recordAutoTurn("antigravity", "claude-4-6", now);
    expect(autoTurnsToday("antigravity", "gemini-pro", now)).toBe(2);
    expect(autoTurnsToday("antigravity", "claude-4-6", now)).toBe(1);
    expect(autoTurnsToday("antigravity_2", "gemini-pro", now)).toBe(0);
  });

  it("keeps cooldowns and turns across a server restart", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "auto-routing-"));
    const file = NodePath.join(dir, "auto-routing.json");
    try {
      clearAutoCooldowns();
      configureAutoRoutingState(file, now);
      markAutoCooldown("antigravity_2", now + 60_000, "gemini-pro");
      recordAutoTurn("antigravity", "gemini-pro", now);
      // A restart forgets memory; the file brings both back.
      clearAutoCooldowns();
      configureAutoRoutingState(file, now + 1000);
      expect(isAutoCoolingDown("antigravity_2", "gemini-pro", now + 1000)).toBe(true);
      expect(autoTurnsToday("antigravity", "gemini-pro", now + 1000)).toBe(1);
      // Loading the same file again does not count its turns twice.
      configureAutoRoutingState(file, now + 2000);
      expect(autoTurnsToday("antigravity", "gemini-pro", now + 2000)).toBe(1);
    } finally {
      clearAutoCooldowns();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shows Antigravity quota state as Limits windows, and leaves other providers alone", () => {
    clearAutoCooldowns();
    const agy = (id: string) =>
      ({
        instanceId: id,
        driver: "antigravity",
        models: [{ slug: "gemini-4-hydrogen" }, { slug: "claude-opus-4-6-thinking" }],
        usageLimits: undefined,
      }) as unknown as Parameters<typeof withAutoBudgetWindows>[0][number];
    const claudeA = {
      instanceId: "claudeAuto",
      driver: "claudeAgent",
      models: [{ slug: "claude-opus-5-5" }],
    } as unknown as Parameters<typeof withAutoBudgetWindows>[0][number];
    markAutoCooldown("agyB", now + 3_600_000, "gemini");
    recordAutoTurn("agyA", "gemini", now);
    recordAutoTurn("agyA", "gemini", now);

    const [a, b, c] = withAutoBudgetWindows([agy("agyA"), agy("agyB"), claudeA], now);
    const byId = (p: typeof a) =>
      Object.fromEntries((p!.usageLimits?.windows ?? []).map((w) => [w.id, w]));
    expect(byId(a)["auto-budget-gemini"]).toMatchObject({
      usedPercent: 20,
      label: "Gemini (Hydrogen, Flash) · Auto budget today (2/10 turns)",
      modelIds: ["gemini-4-hydrogen"],
    });
    expect(byId(b)["auto-quota-gemini"]).toMatchObject({
      usedPercent: 100,
      label: "Gemini (Hydrogen, Flash) · out of quota",
      resetsAt: DateTime.formatIso(DateTime.makeUnsafe(now + 3_600_000)),
    });
    expect(byId(b)["auto-budget-third-party"]?.usedPercent).toBe(0);
    expect(c).toBe(claudeA);
    // Applying it twice replaces the Auto windows instead of stacking them.
    const again = withAutoBudgetWindows(withAutoBudgetWindows([agy("agyA")], now), now);
    expect(again[0]!.usageLimits?.windows).toHaveLength(2);
  });
});

// @effect-diagnostics nodeBuiltinImport:off -- Auto routing state is read and saved synchronously from plain functions called inside the router.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ServerProvider, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  AUTO_DAILY_TURN_CAPS,
  AUTO_WINDOW_ID_PREFIX,
  autoQuotaPool,
  localDayStartMs,
} from "@t3tools/shared/autoModel";
import * as DateTime from "effect/DateTime";

/**
 * What usage reports cannot tell Auto: pools that just hit a limit (cooldowns) and today's turns
 * per instance and pool (Antigravity balancing and daily budget). Saved to a JSON file so a
 * restart does not route straight back into an account that is out for the week.
 */
const cooldowns = new Map<string, number>();
/** Sorted by time; only turns since local midnight are kept, as only those are read. */
let turns: Array<{ readonly key: string; readonly at: number }> = [];
let statePath: string | undefined;

/** `instance|pool`; pool "*" is the whole account (see `autoQuotaPool`). */
function key(instanceId: string, pool: string): string {
  return `${instanceId}|${pool}`;
}

function dropOldTurns(nowMs: number): void {
  const dayStart = localDayStartMs(nowMs);
  if (turns.length > 0 && turns[0]!.at < dayStart) turns = turns.filter((t) => t.at >= dayStart);
}

function save(): void {
  if (statePath === undefined) return;
  try {
    NodeFS.mkdirSync(NodePath.dirname(statePath), { recursive: true });
    const tmp = `${statePath}.tmp`;
    NodeFS.writeFileSync(
      tmp,
      JSON.stringify({ version: 1, cooldowns: Object.fromEntries(cooldowns), turns }),
    );
    NodeFS.renameSync(tmp, statePath);
  } catch {
    // Routing still works from memory; the file only carries state across restarts.
  }
}

/** Merges saved state from `path` into memory and saves there from now on. */
export function configureAutoRoutingState(path: string, nowMs: number): void {
  if (statePath === path) return;
  statePath = path;
  try {
    const data = JSON.parse(NodeFS.readFileSync(path, "utf8")) as {
      cooldowns?: Record<string, unknown>;
      turns?: Array<{ key?: unknown; at?: unknown }>;
    };
    for (const [k, until] of Object.entries(data.cooldowns ?? {})) {
      if (typeof until === "number" && until > nowMs && until > (cooldowns.get(k) ?? 0)) {
        cooldowns.set(k, until);
      }
    }
    const seen = new Set(turns.map((t) => `${t.key}@${t.at}`));
    for (const turn of data.turns ?? []) {
      if (typeof turn?.key !== "string" || typeof turn.at !== "number") continue;
      if (!seen.has(`${turn.key}@${turn.at}`)) turns.push({ key: turn.key, at: turn.at });
    }
    turns.sort((a, b) => a.at - b.at);
    dropOldTurns(nowMs);
  } catch {
    // No saved state yet.
  }
}

/** Benches `pool` of `instanceId` until `untilMs`; "*" benches the whole instance. */
export function markAutoCooldown(instanceId: string, untilMs: number, pool = "*"): void {
  const k = key(instanceId, pool);
  if (untilMs > (cooldowns.get(k) ?? 0)) {
    cooldowns.set(k, untilMs);
    save();
  }
}

export function isAutoCoolingDown(instanceId: string, pool: string, nowMs: number): boolean {
  let expired = false;
  let cooling = false;
  for (const k of new Set([key(instanceId, "*"), key(instanceId, pool)])) {
    const until = cooldowns.get(k);
    if (until === undefined) continue;
    if (until > nowMs) cooling = true;
    else {
      cooldowns.delete(k);
      expired = true;
    }
  }
  if (expired) save();
  return cooling;
}

/** Records one Auto turn sent to `pool` of `instanceId`. */
export function recordAutoTurn(instanceId: string, pool: string, nowMs: number): void {
  dropOldTurns(nowMs);
  turns.push({ key: key(instanceId, pool), at: nowMs });
  save();
}

/** Auto turns sent to `pool` of `instanceId` since local midnight. */
export function autoTurnsToday(instanceId: string, pool: string, nowMs: number): number {
  const dayStart = localDayStartMs(nowMs);
  const k = key(instanceId, pool);
  let count = 0;
  for (const turn of turns) if (turn.key === k && turn.at >= dayStart) count += 1;
  return count;
}

const POOL_LABELS: Readonly<Record<string, string>> = {
  "gemini-pro": "Hydrogen",
  "claude-4-6": "Claude 4.6",
  "gemini-flash": "Flash",
  "gpt-oss": "GPT-OSS",
};

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Until when `pool` of `instanceId` is benched, or undefined. */
function cooldownUntil(instanceId: string, pool: string, nowMs: number): number | undefined {
  const until = Math.max(
    cooldowns.get(key(instanceId, pool)) ?? 0,
    cooldowns.get(key(instanceId, "*")) ?? 0,
  );
  return until > nowMs ? until : undefined;
}

/**
 * Antigravity reports no usage, so the Limits tab showed nothing for it. These windows show
 * what Auto knows instead: a pool out of quota until its reset, or today's turns against the
 * daily budget. Informational only: ids start with `AUTO_WINDOW_ID_PREFIX`, which routing skips.
 */
function autoBudgetWindows(provider: ServerProvider, nowMs: number): ServerProviderUsageWindow[] {
  const tomorrow = localDayStartMs(nowMs) + 24 * 60 * 60_000;
  return Object.entries(AUTO_DAILY_TURN_CAPS).flatMap(([pool, cap]) => {
    const modelIds = provider.models
      .map((model) => model.slug)
      .filter((slug) => autoQuotaPool(provider.driver, slug) === pool);
    if (modelIds.length === 0) return [];
    const label = POOL_LABELS[pool] ?? pool;
    const out = cooldownUntil(provider.instanceId, pool, nowMs);
    if (out !== undefined) {
      return [
        {
          id: `${AUTO_WINDOW_ID_PREFIX}quota-${pool}`,
          kind: "other" as const,
          label: `${label} · out of quota`,
          modelIds,
          usedPercent: 100,
          resetsAt: iso(out),
        },
      ];
    }
    const turns = autoTurnsToday(provider.instanceId, pool, nowMs);
    return [
      {
        id: `${AUTO_WINDOW_ID_PREFIX}budget-${pool}`,
        kind: "other" as const,
        label: `${label} · Auto budget today (${turns}/${cap} turns)`,
        modelIds,
        usedPercent: Math.min(100, Math.round((turns / cap) * 100)),
        resetsAt: iso(tomorrow),
      },
    ];
  });
}

/** Adds the Auto windows to Antigravity providers for clients (the Limits tab). */
export function withAutoBudgetWindows(
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): ReadonlyArray<ServerProvider> {
  return providers.map((provider) => {
    if (provider.driver !== "antigravity") return provider;
    const windows = autoBudgetWindows(provider, nowMs);
    if (windows.length === 0) return provider;
    const own = (provider.usageLimits?.windows ?? []).filter(
      (w) => !w.id.startsWith(AUTO_WINDOW_ID_PREFIX),
    );
    return {
      ...provider,
      usageLimits: {
        ...provider.usageLimits,
        checkedAt: provider.usageLimits?.checkedAt ?? iso(nowMs),
        windows: [...own, ...windows],
      },
    };
  });
}

/** Tests only. */
export function clearAutoCooldowns(): void {
  cooldowns.clear();
  turns = [];
  statePath = undefined;
}

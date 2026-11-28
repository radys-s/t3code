import {
  isProviderAvailable,
  type ModelSelection,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { exhaustedUsageWindow, usageWindowLimitsModel } from "./usageLimits.ts";

/**
 * "Auto" is a custom model (slug `auto`) on any provider instance. Picking it never reaches
 * a provider: the server replaces it with a concrete model chosen here, from the providers'
 * live usage limits. The level (`low` | `medium` | `high`) rides in the `effort` option.
 */
const AUTO_MODEL_SLUG = "auto";
/** Stamped on the model Auto picks, holding the level, so the thread stays on Auto. */
const AUTO_OPTION_ID = "auto";
const AUTO_LEVELS = ["low", "medium", "high"] as const;
type AutoLevel = (typeof AUTO_LEVELS)[number];
const DEFAULT_LEVEL: AutoLevel = "medium";
/** At this peak usage an account counts as nearly out: a sticky model gives way and routing
 * moves to an account with room. */
const STICKY_MAX_USED_PERCENT = 90;

interface AutoCandidate {
  readonly driver: string;
  readonly model: string;
  /** The candidate's own reasoning effort for this level. */
  readonly effort: string;
}

const claude = (model: string, effort: string): AutoCandidate => ({
  driver: "claudeAgent",
  model,
  effort,
});
const codex = (model: string, effort: string): AutoCandidate => ({
  driver: "codex",
  model,
  effort,
});
const grok = (effort: string): AutoCandidate => ({ driver: "grok", model: "grok-4.7", effort });
/** Claude models on the Antigravity (Google) subscription: a third Claude pool. */
const antigravity = (model: string, effort: string): AutoCandidate => ({
  driver: "antigravity",
  model,
  effort,
});
const opencode = (model: string, effort: string): AutoCandidate => ({
  driver: "opencode",
  model,
  effort,
});

/**
 * Tiers of similar strength per level: Auto takes the first tier with a usable model, and in it
 * the subscription furthest under budget, so quota that would expire unused goes first. High:
 * Opus 5.5 max first. Medium: Opus 5.5, Sol and Hydrogen share a tier. Low: Sonnet or Luna first.
 */
const AUTO_TIERS: Readonly<Record<AutoLevel, ReadonlyArray<ReadonlyArray<AutoCandidate>>>> = {
  high: [
    [claude("claude-opus-5-5", "max")],
    [
      codex("gpt-6.2-astra", "high"),
      codex("gpt-6-astra", "high"),
      antigravity("gemini-4-hydrogen", "xhigh"),
    ],
    [
      codex("gpt-6.2-sol", "high"),
      antigravity("claude-opus-4-6-thinking", "high"),
      claude("claude-sonnet-5-5", "high"),
    ],
    [antigravity("gemini-3.8-flash", "high"), opencode("opencode/beam-free", "high")],
    [
      opencode("opencode/big-pickle", ""),
      opencode("opencode/mimo-v2.6-flash-free", ""),
      grok("high"),
    ],
  ],
  medium: [
    [
      claude("claude-opus-5-5", "medium"),
      codex("gpt-6.2-sol", "medium"),
      antigravity("gemini-4-hydrogen", "high"),
    ],
    [
      // Fable shares the Claude account with Opus; it covers an Opus-only weekly window.
      claude("claude-fable-5-2", "medium"),
      claude("claude-sonnet-5-5", "medium"),
      codex("gpt-6.1-sol", "medium"),
      antigravity("claude-opus-4-6-thinking", "medium"),
      antigravity("claude-sonnet-4-6", "medium"),
    ],
    [codex("gpt-6-luna", "medium")],
    [antigravity("gemini-3.8-flash", "high"), opencode("opencode/beam-free", "medium")],
    [
      opencode("opencode/big-pickle", ""),
      opencode("opencode/mimo-v2.6-flash-free", ""),
      grok("medium"),
    ],
  ],
  low: [
    [claude("claude-sonnet-5-5", "low"), codex("gpt-6-luna", "low")],
    [codex("gpt-6.1-terra", "low")],
    [
      opencode("opencode/beam-free", "low"),
      opencode("opencode/big-pickle", ""),
      opencode("opencode/mimo-v2.6-flash-free", ""),
    ],
    [
      antigravity("gemini-4-hydrogen", "low"),
      antigravity("gemini-3.8-flash", "low"),
      antigravity("claude-sonnet-4-6", "low"),
    ],
    [claude("claude-haiku-5-5", "low"), grok("low")],
  ],
};

/**
 * Antigravity meters each model family separately ("Individual quota reached" on Hydrogen
 * leaves its Claude and Flash models working), and reports no usage to T3. Other providers
 * meter the whole account; their pool is "*".
 */
export function autoQuotaPool(driver: string, model: string): string {
  // Claude Agent also lists claude-*-4-6, and its limits cover the whole account.
  if (driver !== "antigravity") return "*";
  if (/^gemini-[\d.]+-flash/.test(model)) return "gemini-flash";
  if (/^gemini-/.test(model)) return "gemini-pro";
  if (/^claude-.*-4-6/.test(model)) return "claude-4-6";
  if (/^gpt-oss/.test(model)) return "gpt-oss";
  return "*";
}

/** Windows the server derives from Auto's own state for display; routing skips them. */
export const AUTO_WINDOW_ID_PREFIX = "auto-";

function withoutAutoWindows(provider: ServerProvider): ServerProvider {
  const windows = provider.usageLimits?.windows;
  if (!windows?.some((w) => w.id.startsWith(AUTO_WINDOW_ID_PREFIX))) return provider;
  return {
    ...provider,
    usageLimits: {
      ...provider.usageLimits!,
      windows: windows.filter((w) => !w.id.startsWith(AUTO_WINDOW_ID_PREFIX)),
    },
  };
}

/**
 * Turns per Antigravity account per day before Auto prefers other subscriptions. Antigravity
 * shows no usage, and the same accounts are used on other machines, so this keeps one session
 * from emptying a weekly pool (Hydrogen on account B ran out after two long turns). Past the cap
 * the account is still used when nothing else is left.
 */
export const AUTO_DAILY_TURN_CAPS: Readonly<Record<string, number>> = {
  "gemini-pro": 8,
  "claude-4-6": 4,
  "gemini-flash": 30,
  "gpt-oss": 30,
};

/** The option IDs each driver uses for reasoning effort (first matching descriptor wins). */
const EFFORT_OPTION_IDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  claudeAgent: ["effort"],
  codex: ["reasoningEffort"],
  grok: ["reasoningEffort"],
  opencode: ["variant"],
  antigravity: ["thought_level", "thinking_level"],
};

/**
 * `auto` takes its level from the `effort` option; `auto-low`, `auto-medium` and `auto-high`
 * fix it in the slug, so a picker can list one row per level.
 */
export function isAutoModelSlug(slug: string | null | undefined): boolean {
  return (
    slug === AUTO_MODEL_SLUG || AUTO_LEVELS.some((level) => slug === `${AUTO_MODEL_SLUG}-${level}`)
  );
}

/** One picker row per level; every Claude provider lists them, so Auto needs no settings. */
export const AUTO_LEVEL_MODELS: ReadonlyArray<{ readonly slug: string; readonly name: string }> =
  AUTO_LEVELS.map((level) => ({
    slug: `${AUTO_MODEL_SLUG}-${level}`,
    name: `Auto ${level[0]!.toUpperCase()}${level.slice(1)}`,
  }));

function stampedLevel(selection: ModelSelection | null | undefined): AutoLevel | undefined {
  const value = selection?.options?.find((option) => option.id === AUTO_OPTION_ID)?.value;
  return AUTO_LEVELS.find((level) => level === value);
}

export function isAutoModelSelection(selection: ModelSelection | null | undefined): boolean {
  return isAutoModelSlug(selection?.model) || stampedLevel(selection) !== undefined;
}

/** The Auto level a routed thread runs at, or undefined for a thread not on Auto. */
export function routedAutoLevel(selection: ModelSelection | null | undefined) {
  return stampedLevel(selection);
}

/** A routed thread's model as the Auto level it came from, for pickers; others unchanged. */
export function autoLevelSelection<T extends ModelSelection | null | undefined>(
  selection: T,
): T | ModelSelection {
  const level = stampedLevel(selection);
  return selection && level
    ? { instanceId: selection.instanceId, model: `${AUTO_MODEL_SLUG}-${level}` }
    : selection;
}

function autoLevelOf(selection: ModelSelection): AutoLevel {
  const stamped = stampedLevel(selection);
  if (stamped) return stamped;
  const fixed = AUTO_LEVELS.find((level) => selection.model === `${AUTO_MODEL_SLUG}-${level}`);
  if (fixed) return fixed;
  const value = selection.options?.find((option) => option.id === "effort")?.value;
  return AUTO_LEVELS.find((level) => level === value) ?? DEFAULT_LEVEL;
}

/** Accounts whose 5-hour use differs by less than this many points count as equally far along. */
const SESSION_BAND_PERCENT = 10;
/** Weekly paces within this share of each other count as equal. */
const PACE_BAND = 0.15;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Used % of each window that limits `model` and has not reset yet. */
function roomPercents(provider: ServerProvider, model: string, now: number, kind?: string) {
  return (provider.usageLimits?.windows ?? []).flatMap((w) =>
    usageWindowLimitsModel(provider, w, model) &&
    (kind === undefined || w.kind === kind) &&
    !(w.resetsAt && Date.parse(w.resetsAt) <= now)
      ? [w.usedPercent]
      : [],
  );
}

function sessionUsedPercent(provider: ServerProvider, model: string, now: number) {
  const percents = roomPercents(provider, model, now, "session");
  return percents.length > 0 ? Math.max(...percents) : undefined;
}

/**
 * Weekly windows that limit `model` (a one-model window counts only for it) and when each
 * resets. A window with no reported reset, such as one that has not started, counts as a full
 * window from now.
 */
function weeklyWindows(provider: ServerProvider, model: string, now: number) {
  return (provider.usageLimits?.windows ?? []).flatMap((w) => {
    if (w.kind !== "weekly" || !usageWindowLimitsModel(provider, w, model)) return [];
    const resetsAt =
      w.resetsAt === undefined
        ? now + (w.windowDurationMins ?? Number.NaN) * MINUTE
        : Date.parse(w.resetsAt);
    return Number.isFinite(resetsAt) ? [{ usedPercent: w.usedPercent, resetsAt }] : [];
  });
}

/**
 * Weekly % left per hour until that window resets: the burn rate that spends the quota exactly
 * at its reset, when whatever is left is lost. The tightest window decides; undefined without
 * weekly data.
 */
function weeklyPace(provider: ServerProvider, model: string, now: number): number | undefined {
  const paces = weeklyWindows(provider, model, now).map(
    (w) => (100 - w.usedPercent) / (Math.max(w.resetsAt - now, MINUTE) / HOUR),
  );
  return paces.length > 0 ? Math.min(...paces) : undefined;
}

/** When the soonest weekly window resets; unused weekly quota is lost then. */
function weeklyResetAt(provider: ServerProvider, model: string, now: number): number {
  return Math.min(...weeklyWindows(provider, model, now).map((w) => w.resetsAt));
}

/** The higher pace first; paces within 15% tie, and an account without weekly data goes last. */
function comparePace(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return Number(a === undefined) - Number(b === undefined);
  return Math.abs(a - b) > PACE_BAND * Math.max(a, b) ? b - a : 0;
}

/** The further along session first; sessions within 10 points tie, and an account without a session window goes last. */
function compareSession(a: number | undefined, b: number | undefined): number {
  if (a === undefined || b === undefined) return Number(a === undefined) - Number(b === undefined);
  return Math.abs(b - a) >= SESSION_BAND_PERCENT ? b - a : 0;
}

function roomRank(provider: ServerProvider, model: string, now: number): number {
  const peak = peakUsedPercent(provider, model, now);
  if (peak === undefined) return 1;
  return peak < STICKY_MAX_USED_PERCENT ? 0 : 2;
}

/**
 * Auto-aware first, then room under 90% everywhere; unknown usage ranks after known accounts with room.
 * Higher weekly pace first, then further-along session (no session window goes last), then sooner weekly reset.
 * Past 90% everywhere, the most left.
 */
function compareInstances(a: ServerProvider, b: ServerProvider, model: string, now: number) {
  const aware = Number(isAutoAware(b)) - Number(isAutoAware(a));
  if (aware !== 0) return aware;
  const room = roomRank(a, model, now) - roomRank(b, model, now);
  if (room !== 0) return room;
  if (roomRank(a, model, now) === 2) {
    return (peakUsedPercent(a, model, now) ?? 0) - (peakUsedPercent(b, model, now) ?? 0);
  }
  const pace = comparePace(weeklyPace(a, model, now), weeklyPace(b, model, now));
  if (pace !== 0) return pace;
  const sessionA = sessionUsedPercent(a, model, now);
  const sessionB = sessionUsedPercent(b, model, now);
  const session = compareSession(sessionA, sessionB);
  if (session !== 0) return session;
  const weekly = weeklyResetAt(a, model, now) - weeklyResetAt(b, model, now);
  if (Number.isFinite(weekly) && weekly !== 0) return weekly;
  const rawSession = sessionA !== undefined && sessionB !== undefined ? sessionB - sessionA : 0;
  return (
    rawSession || (peakUsedPercent(a, model, now) ?? 0) - (peakUsedPercent(b, model, now) ?? 0)
  );
}

/** Undefined when no window that limits `model` reports usage: unknown, not empty. */
function peakUsedPercent(provider: ServerProvider, model: string, now: number) {
  const percents = roomPercents(provider, model, now);
  return percents.length > 0 ? Math.max(...percents) : undefined;
}

/**
 * Instances named "Auto…" carry the Auto-mode prompt (their launch args), so they win ties. Every
 * Claude provider lists the Auto levels, so listing them says nothing about the prompt.
 */
function isAutoAware(provider: ServerProvider): boolean {
  return /^auto\b/i.test(provider.displayName ?? "");
}

function usable(provider: ServerProvider, model: string, now: number): boolean {
  return (
    provider.enabled &&
    provider.installed &&
    provider.auth.status !== "unauthenticated" &&
    isProviderAvailable(provider) &&
    // The server refuses every session on a runtime the manifest rates broken.
    provider.compatibilityAdvisory?.status !== "broken" &&
    provider.models.some((entry) => entry.slug === model) &&
    exhaustedUsageWindow(provider, now, model) === undefined
  );
}

function effortOptions(provider: ServerProvider, candidate: AutoCandidate) {
  const ids = EFFORT_OPTION_IDS[candidate.driver] ?? [];
  const descriptors =
    provider.models.find((entry) => entry.slug === candidate.model)?.capabilities
      ?.optionDescriptors ?? [];
  for (const id of ids) {
    const descriptor = descriptors.find((entry) => entry.id === id);
    if (
      descriptor?.type === "select" &&
      descriptor.options.some((choice) => choice.id === candidate.effort)
    ) {
      return [{ id, value: candidate.effort }];
    }
  }
  return undefined;
}

function toSelection(
  provider: ServerProvider,
  candidate: AutoCandidate,
  level: AutoLevel,
): ModelSelection {
  return {
    instanceId: provider.instanceId,
    model: candidate.model,
    options: [...(effortOptions(provider, candidate) ?? []), { id: AUTO_OPTION_ID, value: level }],
  };
}

interface AutoResolution {
  readonly selection: ModelSelection;
  readonly level: AutoLevel;
  /** True when the thread's current model was kept. */
  readonly sticky: boolean;
  /** The quota pool the turn draws from, for cooldowns and the daily ledger. */
  readonly pool: string;
}

/** Weekly quota spent at an even pace: 100% over 168 hours. */
const NEUTRAL_WEEKLY_PACE = 100 / 168;
/** Budget ratios fall into buckets this many times apart; within a bucket, tier order decides. */
const RATIO_BUCKET = 1.15;

export interface AutoBudgetInput {
  /** Auto turns this instance spent on quota `pool` (see `autoQuotaPool`) since local midnight. */
  readonly turnsToday?: (instanceId: string, pool: string) => number;
}

function turnsOf(provider: ServerProvider, model: string, budget: AutoBudgetInput): number {
  return budget.turnsToday?.(provider.instanceId, autoQuotaPool(provider.driver, model)) ?? 0;
}

/** Start of the local calendar day containing `now`: daily budgets reset at local midnight. */
export function localDayStartMs(now: number): number {
  return Option.match(DateTime.makeZoned(now, { timeZone: DateTime.zoneMakeLocal() }), {
    onNone: () => now - (now % (24 * HOUR)),
    onSome: (zoned) => DateTime.toEpochMillis(DateTime.startOf(zoned, "day")),
  });
}

function hoursLeftToday(now: number): number {
  return Math.max((localDayStartMs(now) + 24 * HOUR - now) / HOUR, 1);
}

function dailyCap(provider: ServerProvider, model: string): number | undefined {
  return AUTO_DAILY_TURN_CAPS[autoQuotaPool(provider.driver, model)];
}

function overDailyCap(provider: ServerProvider, model: string, budget: AutoBudgetInput): boolean {
  const cap = dailyCap(provider, model);
  return cap !== undefined && turnsOf(provider, model, budget) >= cap;
}

/**
 * How far under its budget an account is, 1 = exactly on schedule. A weekly window compares
 * what is left per hour until the reset with an even pace (quota left at the reset is lost); an
 * Antigravity pool compares its unused daily turns with the share of the day still ahead. Unknown
 * usage counts as on schedule.
 */
function budgetRatio(
  provider: ServerProvider,
  model: string,
  now: number,
  budget: AutoBudgetInput,
): number {
  const pace = weeklyPace(provider, model, now);
  if (pace !== undefined) return pace / NEUTRAL_WEEKLY_PACE;
  const cap = dailyCap(provider, model);
  if (cap !== undefined) {
    const used = turnsOf(provider, model, budget);
    return Math.max(0, 1 - used / cap) / Math.max(hoursLeftToday(now) / 24, 1 / 24);
  }
  return 1;
}

/** 0 = room (under 90%, or an Antigravity pool under its daily cap), 1 = unknown, 2 = nearly out. */
function budgetRank(provider: ServerProvider, model: string, now: number): number {
  if (
    dailyCap(provider, model) !== undefined &&
    peakUsedPercent(provider, model, now) === undefined
  ) {
    return 0;
  }
  return roomRank(provider, model, now);
}

interface AutoOption {
  readonly provider: ServerProvider;
  readonly candidate: AutoCandidate;
  /** Position in its tier: the earlier, the more preferred when budgets tie. */
  readonly order: number;
}

/** Instances of one model (Claude A and B, Antigravity A and B): the account rules decide,
 * with an Antigravity pool's daily budget first since it reports no usage. */
function compareSameModel(a: AutoOption, b: AutoOption, now: number, budget: AutoBudgetInput) {
  if (dailyCap(a.provider, a.candidate.model) !== undefined) {
    const ra = budgetRatio(a.provider, a.candidate.model, now, budget);
    const rb = budgetRatio(b.provider, b.candidate.model, now, budget);
    if (ra !== rb) return rb - ra;
  }
  return compareInstances(a.provider, b.provider, a.candidate.model, now);
}

/** A total order across models: room rank, then budget bucket (higher first), then tier order. */
function optionKey(option: AutoOption, now: number, budget: AutoBudgetInput) {
  const ratio = budgetRatio(option.provider, option.candidate.model, now, budget);
  const bucket = ratio > 0 ? Math.floor(Math.log(ratio) / Math.log(RATIO_BUCKET)) : -Infinity;
  return [budgetRank(option.provider, option.candidate.model, now), -bucket, option.order];
}

function lexicallyBefore(a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean {
  const i = a.findIndex((value, j) => value !== b[j]);
  return i !== -1 && a[i]! < b[i]!;
}

/** The best account per model first, then the best model, so provider order cannot matter. */
function bestOption(
  options: ReadonlyArray<AutoOption>,
  now: number,
  budget: AutoBudgetInput,
): AutoOption | undefined {
  const perModel = new Map<AutoCandidate, AutoOption>();
  for (const option of options) {
    const held = perModel.get(option.candidate);
    if (!held || compareSameModel(option, held, now, budget) < 0) {
      perModel.set(option.candidate, option);
    }
  }
  let best: { option: AutoOption; key: ReadonlyArray<number> } | undefined;
  for (const option of perModel.values()) {
    const key = optionKey(option, now, budget);
    if (!best || lexicallyBefore(key, best.key)) best = { option, key };
  }
  return best?.option;
}

/**
 * Keeps the thread's model while it is usable, has room, and no tier above it has a usable
 * model (no account hop, no lost prompt cache). Otherwise the first tier with a usable model,
 * and in it the account furthest under budget (see `bestOption`). Antigravity pools past
 * their daily cap are used only when nothing else is left. Null when nothing is usable.
 */
export function resolveAutoModelSelection(
  input: {
    readonly selection: ModelSelection;
    readonly providers: ReadonlyArray<ServerProvider>;
    readonly now: number;
    readonly current?: ModelSelection | null;
    /**
     * Instances (and models) that just failed with a usage limit or no capacity, which the usage
     * report may not show yet. Auto skips them, the thread's current model included.
     */
    readonly blocked?: (instanceId: string, model: string, pool: string) => boolean;
  } & AutoBudgetInput,
): AutoResolution | null {
  const level = autoLevelOf(input.selection);
  const tiers = AUTO_TIERS[level];
  // Display-only windows come from Auto's own state, which `blocked` and `turnsToday` carry.
  const providers = input.providers.map(withoutAutoWindows);
  const open = (provider: ServerProvider, model: string) =>
    usable(provider, model, input.now) &&
    !input.blocked?.(provider.instanceId, model, autoQuotaPool(provider.driver, model));
  const optionsIn = (tier: ReadonlyArray<AutoCandidate>, allowOverCap: boolean) =>
    tier.flatMap((candidate, order) =>
      providers
        .filter(
          (provider) =>
            provider.driver === (candidate.driver as ProviderDriverKind) &&
            open(provider, candidate.model) &&
            (allowOverCap || !overDailyCap(provider, candidate.model, input)),
        )
        .map((provider) => ({ provider, candidate, order })),
    );

  const current = input.current;
  if (current && !isAutoModelSlug(current.model)) {
    const provider = providers.find((entry) => entry.instanceId === current.instanceId);
    const tierIndex = tiers.findIndex((tier) =>
      tier.some((entry) => entry.driver === provider?.driver && entry.model === current.model),
    );
    const candidate = tiers[tierIndex]?.find(
      (entry) => entry.driver === provider?.driver && entry.model === current.model,
    );
    // A thread that fell back to a weaker tier returns once a better one has room again.
    const betterHasRoom = tiers
      .slice(0, Math.max(tierIndex, 0))
      .some((tier) =>
        optionsIn(tier, false).some(
          (o) => budgetRank(o.provider, o.candidate.model, input.now) === 0,
        ),
      );
    if (
      provider &&
      candidate &&
      open(provider, candidate.model) &&
      !overDailyCap(provider, candidate.model, input) &&
      budgetRank(provider, candidate.model, input.now) < 2 &&
      !betterHasRoom
    ) {
      return {
        selection: toSelection(provider, candidate, level),
        level,
        sticky: true,
        pool: autoQuotaPool(provider.driver, candidate.model),
      };
    }
  }

  for (const allowOverCap of [false, true]) {
    for (const tier of tiers) {
      const best = bestOption(optionsIn(tier, allowOverCap), input.now, input);
      if (best) {
        return {
          selection: toSelection(best.provider, best.candidate, level),
          level,
          sticky: false,
          pool: autoQuotaPool(best.provider.driver, best.candidate.model),
        };
      }
    }
  }
  return null;
}

import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { localDayStartMs } from "@t3tools/shared/autoModel";

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

/** Tests only. */
export function clearAutoCooldowns(): void {
  cooldowns.clear();
  turns = [];
  statePath = undefined;
}

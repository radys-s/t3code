/**
 * Provider instances that just failed an Auto thread with a usage limit or no capacity. The
 * usage report can lag behind (or never show a gateway's 429), so Auto routing skips these until
 * the cooldown ends. Lives in memory: a server restart forgets it, and the usage report takes over.
 */
const cooldowns = new Map<string, number>();
const modelCooldowns = new Map<string, number>();

const modelKey = (instanceId: string, model: string) => `${instanceId}\0${model}`;

/** Per instance; a model-scoped limit (Antigravity pools) still benches the whole instance. */
export function markAutoCooldown(instanceId: string, untilMs: number): void {
  const current = cooldowns.get(instanceId) ?? 0;
  if (untilMs > current) cooldowns.set(instanceId, untilMs);
}

export function isAutoCoolingDown(instanceId: string, nowMs: number): boolean {
  const until = cooldowns.get(instanceId);
  if (until === undefined) return false;
  if (until > nowMs) return true;
  cooldowns.delete(instanceId);
  return false;
}

/**
 * A model the account cannot run at all benches only that model, so Auto can try the next one
 * without giving up on the rest of the instance's models.
 */
export function markAutoModelUnavailable(instanceId: string, model: string, untilMs: number): void {
  const key = modelKey(instanceId, model);
  const current = modelCooldowns.get(key) ?? 0;
  if (untilMs > current) modelCooldowns.set(key, untilMs);
}

export function isAutoModelUnavailable(instanceId: string, model: string, nowMs: number): boolean {
  const key = modelKey(instanceId, model);
  const until = modelCooldowns.get(key);
  if (until === undefined) return false;
  if (until > nowMs) return true;
  modelCooldowns.delete(key);
  return false;
}

/** Tests only. */
export function clearAutoCooldowns(): void {
  cooldowns.clear();
  modelCooldowns.clear();
}

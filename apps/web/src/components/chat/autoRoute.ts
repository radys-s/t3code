import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderDriverKind,
} from "@t3tools/contracts";
import { resolveAutoModelSelection } from "@t3tools/shared/autoModel";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { getTriggerDisplayModelName } from "./providerIconUtils";

/** What the `auto` model would run as right now, for labels such as "Auto · Opus 5.5 (B)". */
export interface AutoRoute {
  readonly driverKind: ProviderDriverKind;
  /** The concrete model and its account, such as "Opus 5.5 (B)". */
  readonly label: string;
}

/** Claude instances are named "Auto" (account A) and "Auto B"; other providers keep their name. */
export function claudeAccountLetter(displayName: string): "A" | "B" {
  return /\bB$/.test(displayName) ? "B" : "A";
}

/**
 * Estimates a route from client-visible usage. The server decides per message, using
 * additional state such as Antigravity quota-pool cooldowns and daily turn budgets.
 */
export function describeAutoRoute(input: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  /** `auto`, or a fixed-level `auto-low` / `auto-medium` / `auto-high`. */
  readonly model?: string;
  readonly options?: ModelSelection["options"];
  readonly now: number;
}): AutoRoute | null {
  const resolution = resolveAutoModelSelection({
    selection: {
      instanceId: ProviderInstanceId.make("auto"),
      model: input.model ?? "auto",
      ...(input.options ? { options: input.options } : {}),
    },
    providers: input.entries.map((entry) => entry.snapshot),
    now: input.now,
  });
  if (!resolution) return null;
  const entry = input.entries.find(
    (candidate) => candidate.instanceId === resolution.selection.instanceId,
  );
  const model = entry?.models.find((candidate) => candidate.slug === resolution.selection.model);
  if (!entry || !model || entry.driverKind === "antigravity") return null;
  const account =
    entry.driverKind === "claudeAgent" ? claudeAccountLetter(entry.displayName) : entry.displayName;
  return {
    driverKind: entry.driverKind,
    label: `${getTriggerDisplayModelName(model, entry.driverKind)} (${account})`,
  };
}

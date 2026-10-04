import {
  isFullAbCapabilityEnabled,
  type AbRolloutScope,
} from "./capabilities";

/**
 * Product-surface gate for the fresh-native T3 cleanup. Runtime resolution
 * stays in runtimeMode.ts — this only interprets an already-resolved
 * snapshot so UI components never re-derive origin/mode/scope themselves.
 */
export type FreshSurfaceRuntimeInput = {
  origin?: string | null;
  mode?: string | null;
  rolloutScope?: AbRolloutScope | null;
};

/**
 * True only for a trusted fresh data origin running the full A+B rollout.
 * A migrated instance at full scope keeps its compatibility surfaces, and
 * LEGACY_ONLY / BLOCKED never reach this gate.
 */
export function isFreshNativeFullSurface(
  input: FreshSurfaceRuntimeInput,
): boolean {
  return (
    input.origin === "fresh" &&
    isFullAbCapabilityEnabled(input.mode ?? "", input.rolloutScope ?? "none")
  );
}

/**
 * Primary-navigation routes with no canonical fresh-native implementation.
 * Checked by route prefix so nested pages inherit the same hiding.
 */
const FRESH_FULL_HIDDEN_NAV_ROUTE_PREFIXES = ["/dashboard/automations"] as const;

export function isFreshFullHiddenNavRoute(route: string): boolean {
  return FRESH_FULL_HIDDEN_NAV_ROUTE_PREFIXES.some(
    (prefix) => route === prefix || route.startsWith(`${prefix}/`),
  );
}

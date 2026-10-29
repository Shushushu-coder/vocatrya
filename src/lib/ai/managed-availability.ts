import "server-only";

export type ManagedAiAvailability = "COMING_SOON" | "ENABLED";

export const MANAGED_NOT_LAUNCHED = "MANAGED_NOT_LAUNCHED";

// Release-owned, like TRUSTED_HOSTED_MANAGED_ENDPOINT: beta.2 does not offer Managed AI subscriptions or
// inference to ordinary users. While this is not ENABLED the Hosted service is never contacted and no
// Managed connection is created. Changing it requires a reviewed release build.
const RELEASE_AVAILABILITY: ManagedAiAvailability = "COMING_SOON";

/**
 * Development-only escape hatch for local verification of the Managed chain
 * (e.g. VOCATRYA_DEV_HOSTED_ENDPOINT pointed at a locally hosted service) —
 * without it the release gate makes that dev override unreachable. A
 * production build ignores this variable entirely; only the exact value
 * "ENABLED" lifts the gate, and only outside production.
 */
export function managedAiAvailability(): ManagedAiAvailability {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.VOCATRYA_DEV_MANAGED_AVAILABILITY === "ENABLED"
  ) {
    return "ENABLED";
  }
  return RELEASE_AVAILABILITY;
}

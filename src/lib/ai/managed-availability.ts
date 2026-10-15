import "server-only";

export type ManagedAiAvailability = "COMING_SOON" | "ENABLED";

export const MANAGED_NOT_LAUNCHED = "MANAGED_NOT_LAUNCHED";

// Release-owned, like TRUSTED_HOSTED_MANAGED_ENDPOINT: beta.2 does not offer Managed AI subscriptions or
// inference to ordinary users. While this is not ENABLED the Hosted service is never contacted and no
// Managed connection is created. Changing it requires a reviewed release build.
const RELEASE_AVAILABILITY: ManagedAiAvailability = "COMING_SOON";

export function managedAiAvailability(): ManagedAiAvailability {
  return RELEASE_AVAILABILITY;
}

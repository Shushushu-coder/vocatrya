import "server-only";

export type ManagedAiAvailability = "COMING_SOON" | "ENABLED";

export const MANAGED_NOT_LAUNCHED = "MANAGED_NOT_LAUNCHED";

// Release-owned, like TRUSTED_HOSTED_MANAGED_ENDPOINT: beta.2 does not offer Managed AI subscriptions or
// inference to ordinary users. While this is not ENABLED the Hosted service is never contacted and no
// Managed connection is created. Changing it requires a reviewed release build.
const RELEASE_AVAILABILITY: ManagedAiAvailability = "COMING_SOON";

/**
 * A loopback http URL marks an operator-run Hosted service on this machine
 * (the beta broker). Only whoever controls the device can configure it, and
 * managed traffic can never leave it — so it is the one endpoint override a
 * production build honors. Shared by the availability gate and the client
 * endpoint resolver: a non-loopback override lifts neither.
 */
export function isLoopbackHostedEndpoint(
  candidate: string | null | undefined,
): boolean {
  if (!candidate) return false;
  try {
    const url = new URL(candidate);
    return (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

/**
 * Development-only escape hatch for local verification of the Managed chain
 * (e.g. VOCATRYA_DEV_HOSTED_ENDPOINT pointed at a locally hosted service) —
 * without it the release gate makes that dev override unreachable. A
 * production build ignores this variable entirely; only the exact value
 * "ENABLED" lifts the gate, and only outside production.
 *
 * Operator beta channel: a loopback VOCATRYA_HOSTED_ENDPOINT marks a local
 * Hosted broker, so the Managed chain lights up even in production builds —
 * this is what the Windows Electron acceptance uses. The public release
 * gate is unchanged: without an operator-configured loopback endpoint the
 * release still never contacts Hosted and stays COMING_SOON.
 */
export function managedAiAvailability(): ManagedAiAvailability {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.VOCATRYA_DEV_MANAGED_AVAILABILITY === "ENABLED"
  ) {
    return "ENABLED";
  }
  if (isLoopbackHostedEndpoint(process.env.VOCATRYA_HOSTED_ENDPOINT)) {
    return "ENABLED";
  }
  return RELEASE_AVAILABILITY;
}

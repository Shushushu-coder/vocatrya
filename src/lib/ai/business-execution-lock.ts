/**
 * Shared business lock primitive (M4).
 *
 * A business resource binds its Managed AI assignment exactly once: the
 * creation flow resolves the assignment, first-binds the resource's stable
 * identity through the Hosted authority, and persists the returned provenance
 * next to the resolved connection/model. Every later model call for that
 * resource replays the stored provenance — it never re-resolves the
 * assignment, never re-binds, and never falls back to an account or legacy
 * path. First-bind failures are Hosted/managed failures surfaced verbatim.
 */
import "server-only";
import { AIBusinessError } from "./connections";
import { HostedManagedClient } from "./managed-client";
import { managedBusinessError } from "./managed-dispatch";
import { encodeManagedAiProvenance, type ManagedAiProvenanceV1 } from "./managed-provenance";

export interface ManagedBusinessLock {
  connectionId: string;
  /** Locked model key — always equals provenance.requestedModelKey. */
  model: string;
  provenance: ManagedAiProvenanceV1;
  /** Encoded payload for the resource row's managedAiProvenance column. */
  managedAiProvenance: string;
}

export function isManagedResolution(
  value: { provider?: string | null; backendKind?: string | null } | null | undefined,
): boolean {
  return value?.provider === "VOCATRYA" && value?.backendKind === "MANAGED_GATEWAY";
}

/**
 * First-bind a business resource to its Managed assignment. `resourceKey`
 * must be stable across retries of the same resource (derived from the
 * resource's durable id, never re-randomized). A new version/run/resource
 * uses a new resourceKey and therefore a new binding.
 */
export async function bindManagedBusinessLock(input: {
  userId: string;
  connectionId: string;
  model: string;
  business: string;
  resourceKey: string;
  client?: HostedManagedClient;
}): Promise<ManagedBusinessLock> {
  const model = input.model?.trim();
  const resourceKey = input.resourceKey?.trim();
  if (!input.connectionId?.trim() || !model || !resourceKey || resourceKey.length > 256) {
    throw new AIBusinessError(
      "MANAGED_BINDING_UNAVAILABLE",
      "Managed business resources require a stable resource identity",
    );
  }
  const client = input.client ?? new HostedManagedClient();
  try {
    const provenance = await client.bind(input.userId, {
      modelKey: model,
      business: input.business,
      resourceKey,
    });
    if (provenance.requestedModelKey !== model) {
      throw new AIBusinessError("MANAGED_PROVENANCE_INVALID", "Managed binding model does not match the assignment");
    }
    return {
      connectionId: input.connectionId,
      model,
      provenance,
      managedAiProvenance: encodeManagedAiProvenance(provenance),
    };
  } catch (error) {
    throw managedBusinessError(error);
  }
}

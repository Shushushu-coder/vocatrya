import { z } from "zod";
import { AIBusinessError, classifyAIConnection, type AIConnectionIdentity } from "./connections";

const required = z.string().refine((value) => value.trim().length > 0);

/** Immutable historical binding reference, never a local authority or credential. */
export const managedAiProvenanceV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  managedBindingId: required,
  requestedModelKey: required,
  upstreamModelId: required,
  mappingRevision: required,
  adapterContractRevision: required,
});
export type ManagedAiProvenanceV1 = z.infer<typeof managedAiProvenanceV1Schema>;

export function decodeManagedAiProvenance(raw: string | null): ManagedAiProvenanceV1 | null {
  if (raw === null) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return managedAiProvenanceV1Schema.parse(parsed);
  } catch {
    throw new AIBusinessError("MANAGED_PROVENANCE_INVALID", "Invalid or unsupported Managed AI provenance");
  }
}

export function encodeManagedAiProvenance(value: ManagedAiProvenanceV1): string {
  return JSON.stringify(managedAiProvenanceV1Schema.parse(value));
}

export const managedAiProvenanceStringSchema = z.string().refine((raw) => {
  try { decodeManagedAiProvenance(raw); return true; } catch { return false; }
}, "Invalid or unsupported Managed AI provenance").nullable();

export type HistoricalAIContract = {
  managedAiProvenance?: string | null;
  resolvedConnectionId: string | null;
} & ({ resolvedModel: string | null } | { model: string | null });
export interface ManagedHistoricalLock {
  kind: "managed";
  connectionId: string | null;
  model: string;
  provenance: ManagedAiProvenanceV1;
}

/** Must run before ordinary connection or legacy decoding, including after restore. */
export function managedLockFromRow(row: HistoricalAIContract): ManagedHistoricalLock | null {
  const provenance = decodeManagedAiProvenance(row.managedAiProvenance ?? null);
  if (!provenance) return null;
  const storedModel = "resolvedModel" in row ? row.resolvedModel : row.model;
  if (storedModel !== provenance.requestedModelKey) {
    throw new AIBusinessError("MANAGED_PROVENANCE_INVALID", "Managed resolvedModel must equal its historical modelKey");
  }
  return { kind: "managed", connectionId: row.resolvedConnectionId, model: provenance.requestedModelKey, provenance };
}

/**
 * M4: historical Managed locks are executable. Asserts the lock still points
 * at the same live Managed connection for this user, then returns the binding
 * details callers pass to the execution seam (managedAiProvenance +
 * managedResource keep every invocation on the original binding). No
 * legacy/default fallback: binding drift or a missing/degraded connection
 * fails closed, never re-resolves the assignment.
 */
export function assertManagedHistoricalExecution(
  lock: ManagedHistoricalLock,
  connection: (AIConnectionIdentity & { id: string; userId: string; archivedAt: Date | null }) | null,
  userId: string,
): void {
  if (!lock.connectionId || !connection || connection.id !== lock.connectionId ||
    connection.userId !== userId || connection.archivedAt !== null ||
    classifyAIConnection(connection) !== "MANAGED") {
    throw new AIBusinessError("MANAGED_BINDING_UNAVAILABLE", "The historical Managed AI connection is unavailable");
  }
}

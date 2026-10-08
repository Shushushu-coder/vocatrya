import "server-only";
import { randomUUID } from "node:crypto";
import { AIBusinessError } from "./connections";
import { ManagedError } from "./managed-contract";
import { HostedManagedClient } from "./managed-client";
import { managedAiProvenanceV1Schema, type ManagedAiProvenanceV1 } from "./managed-provenance";

export interface ManagedDispatchInput {
  userId: string; model: string; prompt: string; signal?: AbortSignal; timeoutMs?: number;
  managedAiProvenance?: ManagedAiProvenanceV1;
  managedResource?: { business: string; resourceKey: string };
  structuredOutput?: { schema: Record<string, unknown>; schemaName: string };
}
export async function prepareManagedInvocation(input: ManagedDispatchInput, client: HostedManagedClient) {
  let snapshot: ManagedAiProvenanceV1;
  if (input.managedAiProvenance !== undefined) {
    const parsed = managedAiProvenanceV1Schema.safeParse(input.managedAiProvenance);
    if (!parsed.success || parsed.data.requestedModelKey !== input.model.trim()) throw new AIBusinessError("MANAGED_PROVENANCE_INVALID", "Invalid Managed provenance");
    snapshot = parsed.data;
  } else {
    snapshot = await client.bind(input.userId, { modelKey: input.model.trim(), business: input.managedResource?.business ?? "TEXT_EXECUTION", resourceKey: input.managedResource?.resourceKey ?? randomUUID() }, input.signal);
  }
  return { bindingId: snapshot.managedBindingId, modelKey: input.model.trim(), prompt: input.prompt, ...(input.structuredOutput ? { structuredOutput: input.structuredOutput } : {}) };
}
export function managedBusinessError(error: unknown): AIBusinessError {
  if (error instanceof AIBusinessError) return error;
  const code = error instanceof ManagedError ? error.code : "MANAGED_RUNTIME_UNAVAILABLE";
  return new AIBusinessError(code, code);
}
export async function executeManagedText(input: ManagedDispatchInput, client = new HostedManagedClient()) {
  const signal = AbortSignal.any([AbortSignal.timeout(Math.min(Math.max(input.timeoutMs ?? 120_000, 1000), 300_000)), ...(input.signal ? [input.signal] : [])]);
  try {
    const invocation = await prepareManagedInvocation({ ...input, signal }, client);
    const result = await client.generateText(input.userId, invocation, signal);
    if (input.managedAiProvenance && JSON.stringify(result.provenance) !== JSON.stringify(managedAiProvenanceV1Schema.parse(input.managedAiProvenance))) throw new AIBusinessError("MANAGED_PROVENANCE_INVALID", "Managed provenance does not match hosted authority");
    return result;
  }
  catch (error) { throw managedBusinessError(error); }
}
export async function* executeManagedStream(input: ManagedDispatchInput, client = new HostedManagedClient()) {
  const signal = AbortSignal.any([AbortSignal.timeout(Math.min(Math.max(input.timeoutMs ?? 120_000, 1000), 300_000)), ...(input.signal ? [input.signal] : [])]);
  try {
    const invocation = await prepareManagedInvocation({ ...input, signal }, client);
    for await (const event of client.streamText(input.userId, invocation, signal)) {
      if (event.type === "completed" && input.managedAiProvenance && JSON.stringify(event.provenance) !== JSON.stringify(managedAiProvenanceV1Schema.parse(input.managedAiProvenance))) throw new AIBusinessError("MANAGED_PROVENANCE_INVALID", "Managed provenance does not match hosted authority");
      yield event;
    }
  }
  catch (error) { throw managedBusinessError(error); }
}

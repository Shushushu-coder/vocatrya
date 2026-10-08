/** Public wire contract. Contains no deployment configuration or credentials. */
export const MANAGED_ADAPTER_REVISION = "managed-gateway-v1";
export const MANAGED_ERROR_CODES = [
  "MANAGED_AI_DISABLED", "MANAGED_AUTH_REQUIRED", "MANAGED_BINDING_UNAVAILABLE",
  "MANAGED_RUNTIME_UNAVAILABLE", "MODEL_DISABLED", "CAPABILITY_UNSUPPORTED",
  "GATEWAY_AUTH", "GATEWAY_RATE_LIMIT", "GATEWAY_TIMEOUT", "GATEWAY_NETWORK", "GATEWAY_RESPONSE",
] as const;
export type ManagedErrorCode = typeof MANAGED_ERROR_CODES[number];
export class ManagedError extends Error {
  constructor(public readonly code: ManagedErrorCode) { super(code); this.name = "ManagedError"; }
}
export interface ManagedCapabilities {
  text: boolean; streaming: boolean; structuredOutput: boolean; tools: boolean;
}
export interface ManagedModelDTO {
  modelKey: string; displayName: string; enabled: boolean; available: boolean;
  capabilities: ManagedCapabilities;
}
export interface ManagedProvenance {
  schemaVersion: 1; managedBindingId: string; requestedModelKey: string;
  upstreamModelId: string; mappingRevision: string; adapterContractRevision: string;
}
export interface ManagedInvocation {
  bindingId: string; modelKey: string; prompt: string;
  structuredOutput?: { schema: Record<string, unknown>; schemaName: string };
}
export interface ManagedTextResult {
  text: string; model: string; provenance: ManagedProvenance;
  structuredStrategy: "PROMPT_AND_VALIDATE" | null; stopReason: string | null;
  inputTokens?: number; outputTokens?: number;
}
export type ManagedStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "completed"; model: string; provenance: ManagedProvenance }
  | { type: "error"; code: ManagedErrorCode };

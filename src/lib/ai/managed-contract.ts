/** Public wire contract. Contains no deployment configuration or credentials. */
export const MANAGED_ADAPTER_REVISION = "managed-gateway-v1";
export const MANAGED_ERROR_CODES = [
  "MANAGED_AI_DISABLED", "MANAGED_AUTH_REQUIRED", "MANAGED_BINDING_UNAVAILABLE",
  "MANAGED_RUNTIME_UNAVAILABLE", "MODEL_DISABLED", "CAPABILITY_UNSUPPORTED",
  "GATEWAY_AUTH", "GATEWAY_RATE_LIMIT", "GATEWAY_TIMEOUT", "GATEWAY_NETWORK", "GATEWAY_RESPONSE",
  "NOT_ENTITLED", "QUOTA_EXCEEDED", "MODEL_NOT_ALLOWED",
  "INVOCATION_ID_REQUIRED", "INVOCATION_CONFLICT", "INVOCATION_STATUS_UNKNOWN",
  "INVOCATION_REPLAYED", "INVOCATION_IN_PROGRESS",
] as const;
export type ManagedErrorCode = typeof MANAGED_ERROR_CODES[number];
export class ManagedError extends Error {
  constructor(public readonly code: ManagedErrorCode, public readonly receipt?: ManagedInvocationReceipt) { super(code); this.name = "ManagedError"; }
}
/** Receipts contain no model output. Callers retain identity and must not retry a new key. */
export interface ManagedInvocationReceipt {
  executionState: "REPLAYED" | "IN_PROGRESS" | "UNKNOWN";
  invocationKey: string;
  status: "RESERVED" | "RUNNING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";
  settlement: "RESERVED" | "COMMITTED" | "RELEASED";
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
  /** Durable business operation identity — Hosted validates it, never trusts client cost data. */
  operationId: string;
  /** One concrete model attempt within `operationId`; stable across transport retries. */
  invocationKey: string;
  /** 0 = primary, 1 = first repair, and so on. */
  attemptIndex: number;
  structuredOutput?: { schema: Record<string, unknown>; schemaName: string };
}
export interface ManagedTextResult {
  executionState?: "EXECUTED";
  text: string; model: string; provenance: ManagedProvenance;
  structuredStrategy: "PROMPT_AND_VALIDATE" | null; stopReason: string | null;
  inputTokens?: number; outputTokens?: number;
}
export type ManagedStreamEvent =
  | { type: "text-delta"; delta: string }
  | { type: "completed"; model: string; provenance: ManagedProvenance; executionState?: "EXECUTED"; stopReason?: string; inputTokens?: number; outputTokens?: number }
  | { type: "error"; code: ManagedErrorCode };

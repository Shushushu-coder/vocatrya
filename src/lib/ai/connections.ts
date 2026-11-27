import type { ManagedInvocationReceipt } from "./managed-contract";
/**
 * Phase B account-login foundation — minimal registry seam for
 * AIConnection / AIBusinessAssignment.
 *
 * These sets are deliberately NOT enforced by SQLite CHECK constraints:
 * providers and runtime backends evolve, and CHECK changes require a table
 * rebuild. Validation lives here and in the service/runtime layer instead.
 *
 * This module is constants, types, and pure helpers only. No database
 * access, no provider login, no runtime calls — those land in later phases.
 */

// Connection identity providers. Open-ended on purpose: new providers
// are added here, not by schema change. The BYOK set is the ApiKey
// registry's provider ids uppercased — the same user-keyed product under
// a different credential surface.
export const AI_CONNECTION_PROVIDERS = [
  "OPENAI",
  "ANTHROPIC",
  "XAI",
  "OPENCODE",
  // OpenCode's own account products — distinct credentials under the
  // opencode / opencode-go auth.json entries.
  "OPENCODE_ZEN",
  "OPENCODE_GO",
  "CURSOR",
  "GITHUB_COPILOT",
  "DEVIN",
  "ANTIGRAVITY",
  "VOCATRYA",
  // BYOK providers (authType=API_KEY, backendKind=LOCAL_BYOK).
  "DEEPSEEK",
  "OPENROUTER",
  "GEMINI",
  "OLLAMA",
] as const;
export type AIConnectionProvider = (typeof AI_CONNECTION_PROVIDERS)[number];

// Connection backends; registry membership alone never authorizes execution.
export const AI_BACKEND_KINDS = [
  "CODEX_RUNTIME",
  "CLAUDE_RUNTIME",
  "GROK_RUNTIME",
  "OPENCODE_RUNTIME",
  "CURSOR_RUNTIME",
  "COPILOT_RUNTIME",
  "DEVIN_RUNTIME",
  "ANTIGRAVITY_RUNTIME",
  "MANAGED_GATEWAY",
  // The user's own API key executed in-process through the AI SDK —
  // no desktop runtime, no ticket, no profile. Membership here only
  // names the identity; the LOCAL_BYOK backend is refused everywhere a
  // runtime operation is required.
  "LOCAL_BYOK",
] as const;
export type AIBackendKind = (typeof AI_BACKEND_KINDS)[number];

export const BYOK_BACKEND_KIND = "LOCAL_BYOK" as const;

// ACCOUNT_LOGIN is the only implemented flow this phase; API_KEY is reserved
// for the future ApiKey seam (AIConnection.credentialRef). MANAGED is identity only.
export const AI_AUTH_TYPES = ["ACCOUNT_LOGIN", "API_KEY", "MANAGED"] as const;
export type AIAuthType = (typeof AI_AUTH_TYPES)[number];

export const AI_CONNECTION_STATUSES = [
  "CONNECTED",
  "REAUTH_REQUIRED",
  "DISCONNECTED",
  "ERROR",
] as const;
export type AIConnectionStatus = (typeof AI_CONNECTION_STATUSES)[number];

// GLOBAL_DEFAULT is the fallback purpose resolved when no business-specific
// assignment exists. AGENT_ROUTER + AGENT_PILOT/INSIGHT/REFLECT power the
// unified multi-agent chat (D01/D07/D08) without requiring a schema change.
export const AI_ASSIGNMENT_PURPOSES = [
  "GLOBAL_DEFAULT",
  "AGENT_ROUTER",
  "AGENT_PILOT",
  "AGENT_INSIGHT",
  "AGENT_REFLECT",
  "INTERVIEW",
  "RESUME",
  "MATCH_ANALYSIS",
  "CAREER_REFLECTION",
  "CAREER_DIALOGUE",
] as const;
export type AIAssignmentPurpose = (typeof AI_ASSIGNMENT_PURPOSES)[number];

export const AGENT_ROLE_ASSIGNMENT_PURPOSES = [
  "AGENT_PILOT",
  "AGENT_INSIGHT",
  "AGENT_REFLECT",
] as const;
export type AgentRoleAssignmentPurpose =
  (typeof AGENT_ROLE_ASSIGNMENT_PURPOSES)[number];

export function agentRoleAssignmentPurpose(
  role: "pilot" | "insight" | "reflect",
): AgentRoleAssignmentPurpose {
  if (role === "insight") return "AGENT_INSIGHT";
  if (role === "reflect") return "AGENT_REFLECT";
  return "AGENT_PILOT";
}

export function isUnifiedAgentPurpose(value: string): boolean {
  return (
    value === "AGENT_ROUTER" ||
    (AGENT_ROLE_ASSIGNMENT_PURPOSES as readonly string[]).includes(value)
  );
}

/**
 * Purposes whose execution path streams assistant text token-by-token to
 * the user (Career Dialogue renders deltas as they arrive — a buffered
 * one-shot would be fake streaming). Assignments for these purposes gate
 * on verified incremental output, at save time and at turn time alike.
 * GLOBAL_DEFAULT is deliberately absent — it also serves non-streaming
 * purposes, so it stays assignable to any runtime; a streaming resolution
 * that lands on a non-streaming GLOBAL_DEFAULT fails at preflight/turn time
 * instead. AGENT_ROUTER is a lightweight one-shot classifier, not streaming.
 */
export const AI_STREAMING_PURPOSES = [
  "CAREER_DIALOGUE",
  "AGENT_PILOT",
  "AGENT_INSIGHT",
  "AGENT_REFLECT",
] as const;

export function isStreamingPurpose(
  value: string,
): value is (typeof AI_STREAMING_PURPOSES)[number] {
  return (AI_STREAMING_PURPOSES as readonly string[]).includes(value);
}

export function isAIConnectionProvider(
  value: string,
): value is AIConnectionProvider {
  return (AI_CONNECTION_PROVIDERS as readonly string[]).includes(value);
}
export function isAIBackendKind(value: string): value is AIBackendKind {
  return (AI_BACKEND_KINDS as readonly string[]).includes(value);
}
export function isAIAuthType(value: string): value is AIAuthType {
  return (AI_AUTH_TYPES as readonly string[]).includes(value);
}
export function isAIConnectionStatus(
  value: string,
): value is AIConnectionStatus {
  return (AI_CONNECTION_STATUSES as readonly string[]).includes(value);
}
export function isAIAssignmentPurpose(
  value: string,
): value is AIAssignmentPurpose {
  return (AI_ASSIGNMENT_PURPOSES as readonly string[]).includes(value);
}

/**
 * AIConnection.providerMetadata is a non-secret JSON string. A provider row
 * must never become a credential store: reject obvious secret key names at
 * the top level (exact or suffix match on the lowercased key, so
 * "oauthAccessToken" and "access_token" are both caught) before the service
 * layer persists it. Values are never inspected — key names only.
 */
const PROVIDER_METADATA_FORBIDDEN_KEYS = [
  "accesstoken",
  "access_token",
  "refreshtoken",
  "refresh_token",
  "apikey",
  "api_key",
  "token",
  "secret",
  "password",
  "credential",
  "credentials",
  "privatekey",
  "private_key",
] as const;

export function assertProviderMetadataSafe(
  metadata: Record<string, unknown> | string | null | undefined,
): void {
  if (metadata === null || metadata === undefined) return;
  let parsed: unknown = metadata;
  if (typeof metadata === "string") {
    try {
      parsed = JSON.parse(metadata) as unknown;
    } catch {
      throw new Error("providerMetadata must be valid JSON");
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("providerMetadata must be a JSON object");
  }
  for (const key of Object.keys(parsed)) {
    const normalized = key.toLowerCase();
    const forbidden = PROVIDER_METADATA_FORBIDDEN_KEYS.some(
      (name) => normalized === name || normalized.endsWith(name),
    );
    if (forbidden) {
      throw new Error(
        `providerMetadata must not contain credential field: ${key}`,
      );
    }
  }
}

/**
 * Which account providers a runtime backend can authenticate for.
 * provider (account/subscription ownership) and backendKind (execution
 * runtime) are independent axes: the same OpenAI account can authenticate
 * through CODEX_RUNTIME or OPENCODE_RUNTIME, and a multi-provider runtime
 * like OpenCode can host several account providers. This matrix only bounds
 * which pairings are eligible — the persisted provider is always the
 * adapter-verified one, never derived from backendKind alone.
 */
// Account-login pairings only — LOCAL_BYOK has no account surface: its
// "provider" names which user-held ApiKey row the connection binds.
export const AI_BACKEND_SUPPORTED_ACCOUNT_PROVIDERS: Record<
  Exclude<AIBackendKind, "MANAGED_GATEWAY" | "LOCAL_BYOK">,
  readonly AIConnectionProvider[]
> = {
  CODEX_RUNTIME: ["OPENAI"],
  CLAUDE_RUNTIME: ["ANTHROPIC"],
  GROK_RUNTIME: ["XAI"],
  // OpenCode is its own account ecosystem — Zen (pay-as-you-go gateway)
  // and Go (flat-rate subscription), each a distinct vendor credential.
  // GITHUB_COPILOT stays a declared-but-unimplemented matrix entry
  // (registry intent); the desktop adapter refuses it until its phase.
  OPENCODE_RUNTIME: ["OPENCODE_ZEN", "OPENCODE_GO", "GITHUB_COPILOT"],
  CURSOR_RUNTIME: ["CURSOR"],
  COPILOT_RUNTIME: ["GITHUB_COPILOT"],
  DEVIN_RUNTIME: ["DEVIN"],
  ANTIGRAVITY_RUNTIME: ["ANTIGRAVITY"],
};

export function supportedAccountProvidersForBackend(
  backendKind: string,
): readonly AIConnectionProvider[] {
  return (
    (AI_BACKEND_SUPPORTED_ACCOUNT_PROVIDERS as Record<
      string,
      readonly AIConnectionProvider[]
    >)[backendKind] ?? []
  );
}

export function isSupportedAccountProviderForBackend(
  backendKind: string,
  provider: string,
): boolean {
  return supportedAccountProvidersForBackend(backendKind).includes(
    provider as AIConnectionProvider,
  );
}

// ---------------------------------------------------------------------------
// BYOK (Custom API Key) identity — authType=API_KEY + backendKind=LOCAL_BYOK.
// credentialRef is the bound ApiKey row id; the actual key material never
// enters AIConnection (see src/lib/ai/byok.ts).
// ---------------------------------------------------------------------------

/** AIConnection.provider → ApiKey.provider (the registry's lowercase ids). */
export const BYOK_API_KEY_PROVIDERS = {
  OPENAI: "openai",
  DEEPSEEK: "deepseek",
  OPENROUTER: "openrouter",
  GEMINI: "gemini",
  OLLAMA: "ollama",
} as const;
export type ByokConnectionProvider = keyof typeof BYOK_API_KEY_PROVIDERS;
export type ByokApiKeyProvider =
  (typeof BYOK_API_KEY_PROVIDERS)[ByokConnectionProvider];

export function byokApiKeyProviderFor(
  provider: string,
): ByokApiKeyProvider | null {
  return (
    (BYOK_API_KEY_PROVIDERS as Record<string, ByokApiKeyProvider>)[provider] ??
    null
  );
}

export function apiKeyProviderToByokProvider(
  provider: string,
): ByokConnectionProvider | null {
  for (const [connectionProvider, apiKeyProvider] of Object.entries(
    BYOK_API_KEY_PROVIDERS,
  )) {
    if (apiKeyProvider === provider) {
      return connectionProvider as ByokConnectionProvider;
    }
  }
  return null;
}

// credentialRef points at an ApiKey row id (uuid) — an opaque reference,
// never a path or the key material itself.
const API_KEY_CREDENTIAL_REF_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isApiKeyCredentialRef(
  value: string | null | undefined,
): value is string {
  return (
    typeof value === "string" && API_KEY_CREDENTIAL_REF_PATTERN.test(value)
  );
}

export function hasByokIdentityMarker(
  connection: ExecutionConnectionIdentity,
): boolean {
  return (
    connection.backendKind === BYOK_BACKEND_KIND ||
    connection.authType === "API_KEY"
  );
}

export interface AIConnectionIdentity {
  provider: string;
  backendKind: string;
  authType: string;
  credentialRef: string | null;
  runtimeProfileRef: string | null;
  accountIdentity: string | null;
}

type ExecutionConnectionIdentity = Pick<AIConnectionIdentity, "provider" | "backendKind"> &
  Partial<Omit<AIConnectionIdentity, "provider" | "backendKind">>;

export function hasManagedIdentityMarker(connection: ExecutionConnectionIdentity): boolean {
  return connection.provider === "VOCATRYA" || connection.backendKind === "MANAGED_GATEWAY" || connection.authType === "MANAGED";
}

/**
 * Identity only: MANAGED never proves hosted auth, entitlement or
 * capability; BYOK never proves a usable key — it only asserts the row
 * is a well-formed API-key binding (provider maps to the ApiKey
 * registry, credentialRef is an ApiKey row id, no runtime profile or
 * account identity can exist on this surface).
 */
export function classifyAIConnection(
  connection: ExecutionConnectionIdentity,
): "ACCOUNT_LOGIN" | "MANAGED" | "BYOK" | "INVALID" {
  if (hasManagedIdentityMarker(connection)) {
    return connection.provider === "VOCATRYA" &&
      connection.backendKind === "MANAGED_GATEWAY" &&
      connection.authType === "MANAGED" &&
      connection.credentialRef === null &&
      connection.runtimeProfileRef === null &&
      connection.accountIdentity === null
      ? "MANAGED"
      : "INVALID";
  }
  if (hasByokIdentityMarker(connection)) {
    return connection.backendKind === BYOK_BACKEND_KIND &&
      connection.authType === "API_KEY" &&
      byokApiKeyProviderFor(connection.provider) !== null &&
      isApiKeyCredentialRef(connection.credentialRef) &&
      connection.runtimeProfileRef === null &&
      connection.accountIdentity === null
      ? "BYOK"
      : "INVALID";
  }
  return connection.authType === "ACCOUNT_LOGIN" &&
    isSupportedAccountProviderForBackend(connection.backendKind, connection.provider)
    ? "ACCOUNT_LOGIN"
    : "INVALID";
}

/** Fail before minting any desktop ticket or probing a runtime. */
export function assertAccountExecutionIdentity(connection: ExecutionConnectionIdentity): void {
  // Existing account projections retain their existing status/matrix gates.
  if (!hasManagedIdentityMarker(connection) && !hasByokIdentityMarker(connection)) return;
  const classification = classifyAIConnection(connection);
  if (classification === "MANAGED") {
    throw new AIBusinessError("MANAGED_EXECUTION_NOT_IMPLEMENTED", "Managed AI connections execute through the business path only, never the desktop runtime");
  }
  if (classification === "BYOK") {
    throw new AIBusinessError("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION", "BYOK API-key connections execute in-process, never through the desktop runtime");
  }
  if (classification === "INVALID") {
    throw new AIBusinessError("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION", "Invalid AI connection identity");
  }
}

/**
 * Operations a desktop runtime may perform against a connection. Tickets
 * minted for these operations are the renderer's proof of user intent;
 * the Electron main process redeems them through the internal API.
 */
export const AI_CONNECTION_OPERATIONS = [
  "login",
  "reconnect",
  "disconnect",
  "verify",
  "listModels",
  "smoke",
  // Minted server-side only by the business execution seam — the renderer
  // ticket action refuses it (see aiConnection.actions.ts).
  "executeText",
] as const;
export type AIConnectionOperation = (typeof AI_CONNECTION_OPERATIONS)[number];
export function isAIConnectionOperation(
  value: string,
): value is AIConnectionOperation {
  return (AI_CONNECTION_OPERATIONS as readonly string[]).includes(value);
}

// The consolidated ACCOUNT_LOGIN error taxonomy — exact parity with
// CONNECTION_OP_CODES in desktop/main/runtime/connection-service.js
// (pinned by __tests__/aiConnectionConsolidation.spec.ts). Provider-
// specific detail belongs in diagnostic metadata, not new codes.
export const AI_CONNECTION_OP_ERROR_CODES = {
  RUNTIME_NOT_INSTALLED: "RUNTIME_NOT_INSTALLED",
  RUNTIME_BROKEN: "RUNTIME_BROKEN",
  RUNTIME_UPDATE_REQUIRED: "RUNTIME_UPDATE_REQUIRED",
  LOGIN_ALREADY_IN_PROGRESS: "LOGIN_ALREADY_IN_PROGRESS",
  LOGIN_CANCELLED: "LOGIN_CANCELLED",
  LOGIN_TIMEOUT: "LOGIN_TIMEOUT",
  LOGIN_FAILED: "LOGIN_FAILED",
  AUTH_NOT_CONFIRMED: "AUTH_NOT_CONFIRMED",
  AUTH_METHOD_UNVERIFIED: "AUTH_METHOD_UNVERIFIED",
  UNSUPPORTED_AUTH_METHOD: "UNSUPPORTED_AUTH_METHOD",
  PROVIDER_POLICY_RESTRICTED: "PROVIDER_POLICY_RESTRICTED",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
  ACCOUNT_IDENTITY_CONFLICT: "ACCOUNT_IDENTITY_CONFLICT",
  CONNECTION_NOT_FOUND: "CONNECTION_NOT_FOUND",
  CONNECTION_ARCHIVED: "CONNECTION_ARCHIVED",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  MODEL_DISCOVERY_UNAVAILABLE: "MODEL_DISCOVERY_UNAVAILABLE",
  PERMISSION_BOUNDARY_NOT_READY: "PERMISSION_BOUNDARY_NOT_READY",
  INFERENCE_FAILED: "INFERENCE_FAILED",
  UNSUPPORTED_BACKEND: "UNSUPPORTED_BACKEND",
  UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION:
    "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  INVALID_TICKET: "INVALID_TICKET",
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE",
  // Business TEXT_ONLY execution: connection-state gate outcomes observed
  // at execution time (the resolve ticket already proves ownership).
  CONNECTION_DISCONNECTED: "CONNECTION_DISCONNECTED",
  CONNECTION_ERROR: "CONNECTION_ERROR",
  AI_EXECUTION_TIMEOUT: "AI_EXECUTION_TIMEOUT",
  // A structuredOutput probe payload could not be carried by the runtime's
  // invocation (e.g. an inline schema over the command-line budget).
  STRUCTURED_OUTPUT_UNSUPPORTED: "STRUCTURED_OUTPUT_UNSUPPORTED",
  // The runtime's structured-output mechanism has not completed real
  // managed verification, or the installed version no longer matches the
  // verifiedRuntimeVersion that passed. Structured business consumers
  // fail closed — PENDING is not permission.
  STRUCTURED_OUTPUT_NOT_VERIFIED: "STRUCTURED_OUTPUT_NOT_VERIFIED",
} as const;
export type AIConnectionOpErrorCode =
  (typeof AI_CONNECTION_OP_ERROR_CODES)[keyof typeof AI_CONNECTION_OP_ERROR_CODES];

export const AI_RESOLUTION_ERROR_CODES = {
  AI_NOT_CONFIGURED: "AI_NOT_CONFIGURED",
  CONNECTION_ARCHIVED: "CONNECTION_ARCHIVED",
  CONNECTION_REAUTH_REQUIRED: "CONNECTION_REAUTH_REQUIRED",
  RUNTIME_NOT_AVAILABLE: "RUNTIME_NOT_AVAILABLE",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
} as const;
export type AIResolutionErrorCode =
  (typeof AI_RESOLUTION_ERROR_CODES)[keyof typeof AI_RESOLUTION_ERROR_CODES];

export class AIResolutionError extends Error {
  readonly code: AIResolutionErrorCode;

  constructor(code: AIResolutionErrorCode, message: string) {
    super(message);
    this.name = "AIResolutionError";
    this.code = code;
  }
}

// Stable business-layer error taxonomy for assignment resolution and
// TEXT_ONLY execution. Values that already exist in the op/resolution
// taxonomies reuse the same string — a code means one thing everywhere.
export const AI_BUSINESS_ERROR_CODES = {
  MANAGED_AI_DISABLED: "MANAGED_AI_DISABLED",
  MANAGED_AUTH_REQUIRED: "MANAGED_AUTH_REQUIRED",
  MANAGED_RUNTIME_UNAVAILABLE: "MANAGED_RUNTIME_UNAVAILABLE",
  MODEL_DISABLED: "MODEL_DISABLED",
  CAPABILITY_UNSUPPORTED: "CAPABILITY_UNSUPPORTED",
  GATEWAY_AUTH: "GATEWAY_AUTH",
  GATEWAY_RATE_LIMIT: "GATEWAY_RATE_LIMIT",
  GATEWAY_TIMEOUT: "GATEWAY_TIMEOUT",
  GATEWAY_NETWORK: "GATEWAY_NETWORK",
  GATEWAY_RESPONSE: "GATEWAY_RESPONSE",
  MANAGED_BINDING_UNAVAILABLE: "MANAGED_BINDING_UNAVAILABLE",
  MANAGED_PROVENANCE_INVALID: "MANAGED_PROVENANCE_INVALID",
  MANAGED_EXECUTION_NOT_IMPLEMENTED: "MANAGED_EXECUTION_NOT_IMPLEMENTED",
  NOT_ENTITLED: "NOT_ENTITLED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  MODEL_NOT_ALLOWED: "MODEL_NOT_ALLOWED",
  INVOCATION_ID_REQUIRED: "INVOCATION_ID_REQUIRED",
  INVOCATION_CONFLICT: "INVOCATION_CONFLICT",
  INVOCATION_STATUS_UNKNOWN: "INVOCATION_STATUS_UNKNOWN",
  INVOCATION_REPLAYED: "INVOCATION_REPLAYED",
  INVOCATION_IN_PROGRESS: "INVOCATION_IN_PROGRESS",
  // Resolution outcomes.
  AI_NOT_CONFIGURED: "AI_NOT_CONFIGURED",
  // Explicitly assigned connection is gone, archived, or foreign-owned —
  // never falls back to another account or to GLOBAL_DEFAULT.
  ASSIGNED_CONNECTION_UNAVAILABLE: "ASSIGNED_CONNECTION_UNAVAILABLE",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
  CONNECTION_DISCONNECTED: "CONNECTION_DISCONNECTED",
  CONNECTION_ERROR: "CONNECTION_ERROR",
  RUNTIME_NOT_AVAILABLE: "RUNTIME_NOT_AVAILABLE",
  UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION:
    "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  // Execution-time outcomes (mapped from the runtime op taxonomy).
  RUNTIME_NOT_INSTALLED: "RUNTIME_NOT_INSTALLED",
  RUNTIME_BROKEN: "RUNTIME_BROKEN",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  PERMISSION_BOUNDARY_NOT_READY: "PERMISSION_BOUNDARY_NOT_READY",
  AI_EXECUTION_TIMEOUT: "AI_EXECUTION_TIMEOUT",
  AI_EXECUTION_FAILED: "AI_EXECUTION_FAILED",
  NATIVE_SESSION_UNAVAILABLE: "NATIVE_SESSION_UNAVAILABLE",
  NATIVE_CONTEXT_LOST: "NATIVE_CONTEXT_LOST",
  NATIVE_TEXT_ONLY: "NATIVE_TEXT_ONLY",
  // BYOK credential surface: the bound ApiKey row is gone or undecryptable.
  // Distinct from env-var/legacy resolution — an explicit BYOK connection
  // never falls through to another credential.
  BYOK_CREDENTIAL_UNAVAILABLE: "BYOK_CREDENTIAL_UNAVAILABLE",
  // A streaming consumer (Career Dialogue) resolved to a runtime without
  // verified incremental output — explicit failure, never a buffered
  // one-shot masquerading as a stream.
  STREAMING_NOT_SUPPORTED: "STREAMING_NOT_SUPPORTED",
  // The runtime exposes a streaming mechanism but it has not been verified
  // against the installed runtime version (PENDING, or version drift after
  // a runtime update). Explicit failure — never silently unverified.
  STREAMING_NOT_VERIFIED: "STREAMING_NOT_VERIFIED",
  AI_REQUEST_TOO_LARGE: "AI_REQUEST_TOO_LARGE",
  // The desktop could not reach the backend to redeem the ticket — a
  // transport failure, distinct from runtime/connection failures.
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE",
  // Structured-execution outcomes. NOT_VERIFIED travels up from the
  // desktop gate (runtime eligibility/version); the rest are produced by
  // the strict validation state machine (parse → schema → ≤1 retry).
  STRUCTURED_OUTPUT_NOT_VERIFIED: "STRUCTURED_OUTPUT_NOT_VERIFIED",
  STRUCTURED_OUTPUT_UNSUPPORTED: "STRUCTURED_OUTPUT_UNSUPPORTED",
  STRUCTURED_OUTPUT_PARSE_FAILED: "STRUCTURED_OUTPUT_PARSE_FAILED",
  STRUCTURED_OUTPUT_SCHEMA_FAILED: "STRUCTURED_OUTPUT_SCHEMA_FAILED",
  STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION:
    "STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION",
  STRUCTURED_OUTPUT_TRUNCATED: "STRUCTURED_OUTPUT_TRUNCATED",
  STRUCTURED_OUTPUT_RETRY_EXHAUSTED: "STRUCTURED_OUTPUT_RETRY_EXHAUSTED",
  // Agent-orchestration outcomes (Career Dialogue account path): the model
  // produced something the Vocatrya tool protocol cannot act on. Codes
  // only — raw model output never reaches the client.
  AGENT_TOOL_PROTOCOL_FAILED: "AGENT_TOOL_PROTOCOL_FAILED",
  AGENT_TOOL_NOT_ALLOWED: "AGENT_TOOL_NOT_ALLOWED",
  AGENT_TOOL_ARGUMENT_INVALID: "AGENT_TOOL_ARGUMENT_INVALID",
  AGENT_STEP_LIMIT_REACHED: "AGENT_STEP_LIMIT_REACHED",
} as const;
export type AIBusinessErrorCode =
  (typeof AI_BUSINESS_ERROR_CODES)[keyof typeof AI_BUSINESS_ERROR_CODES];

export class AIBusinessError extends Error {
  readonly code: AIBusinessErrorCode;

  constructor(code: AIBusinessErrorCode, message: string, public readonly receipt?: ManagedInvocationReceipt, public readonly details?: unknown) {
    super(message);
    this.name = "AIBusinessError";
    this.code = code;
  }
}

/** What a resolved business surface locks onto: connection + model. */
export interface ResolvedBusinessAI {
  connectionId: string;
  model: string;
  source: "BUSINESS" | "GLOBAL_DEFAULT";
}

/**
 * Resolver contract for later phases: userId + purpose -> the connection and
 * model the surface must run with. No implementation is wired here — business
 * flows keep their existing resolution paths until a future phase swaps in a
 * conforming resolver.
 */
export type ResolveBusinessAI = (
  userId: string,
  purpose: string,
) => Promise<ResolvedBusinessAI>;

export interface BusinessAIResolver {
  resolve(userId: string, purpose: string): Promise<ResolvedBusinessAI>;
}

/** Minimal row shape the pure resolution helper needs. */
export interface AssignmentResolutionRow {
  purpose: string;
  connectionId: string;
  model: string;
  connection: { status: string; archivedAt: Date | string | null };
}

/**
 * Pure resolution rule shared by any future resolver implementation:
 * business assignment wins, GLOBAL_DEFAULT falls back, nothing found is
 * AI_NOT_CONFIGURED. A picked connection that is archived or needs re-auth
 * is an error, never silently skipped — a fallback that ignores the user's
 * explicit assignment would surprise them.
 */
export function resolveBusinessAIAssignment(
  purpose: string,
  assignments: readonly AssignmentResolutionRow[],
): ResolvedBusinessAI {
  const business = assignments.find((a) => a.purpose === purpose);
  const chosen = business ?? assignments.find((a) => a.purpose === "GLOBAL_DEFAULT");
  if (!chosen) {
    throw new AIResolutionError(
      AI_RESOLUTION_ERROR_CODES.AI_NOT_CONFIGURED,
      `No AI connection is assigned for purpose "${purpose}".`,
    );
  }
  if (chosen.connection.archivedAt !== null && chosen.connection.archivedAt !== undefined) {
    throw new AIResolutionError(
      AI_RESOLUTION_ERROR_CODES.CONNECTION_ARCHIVED,
      `The AI connection assigned to "${chosen.purpose}" is archived.`,
    );
  }
  if (chosen.connection.status === "REAUTH_REQUIRED") {
    throw new AIResolutionError(
      AI_RESOLUTION_ERROR_CODES.CONNECTION_REAUTH_REQUIRED,
      `The AI connection assigned to "${chosen.purpose}" needs re-authentication.`,
    );
  }
  return {
    connectionId: chosen.connectionId,
    model: chosen.model,
    source: business ? "BUSINESS" : "GLOBAL_DEFAULT",
  };
}

/** Managed metadata is portable identity only. Reject credential-shaped keys
 * recursively; ordinary account metadata keeps its existing backup contract.
 */
export function assertManagedConnectionMetadataSafe(
  connection: AIConnectionIdentity & { providerMetadata: string | null },
): void {
  if (!hasManagedIdentityMarker(connection)) return;
  if (classifyAIConnection(connection) !== "MANAGED") {
    throw new Error("Invalid Managed identity");
  }
  if (connection.providerMetadata === null) return;
  assertProviderMetadataSafe(connection.providerMetadata);
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (value !== null && typeof value === "object") {
      assertProviderMetadataSafe(value as Record<string, unknown>);
      Object.values(value).forEach(inspect);
    }
  };
  const metadata: unknown = JSON.parse(connection.providerMetadata);
  inspect(metadata);
}

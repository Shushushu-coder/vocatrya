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

// First-wave ACCOUNT_LOGIN providers. Open-ended on purpose: new providers
// are added here, not by schema change.
export const AI_CONNECTION_PROVIDERS = [
  "OPENAI",
  "ANTHROPIC",
  "XAI",
  "OPENCODE",
  "CURSOR",
  "GITHUB_COPILOT",
  "DEVIN",
] as const;
export type AIConnectionProvider = (typeof AI_CONNECTION_PROVIDERS)[number];

// Runtime backends a connection can bind to. Same open-registry rule.
export const AI_BACKEND_KINDS = [
  "CODEX_RUNTIME",
  "CLAUDE_RUNTIME",
  "GROK_RUNTIME",
  "OPENCODE_RUNTIME",
  "CURSOR_RUNTIME",
  "COPILOT_RUNTIME",
  "DEVIN_RUNTIME",
] as const;
export type AIBackendKind = (typeof AI_BACKEND_KINDS)[number];

// ACCOUNT_LOGIN is the only implemented flow this phase; API_KEY is reserved
// for the future ApiKey seam (AIConnection.credentialRef).
export const AI_AUTH_TYPES = ["ACCOUNT_LOGIN", "API_KEY"] as const;
export type AIAuthType = (typeof AI_AUTH_TYPES)[number];

export const AI_CONNECTION_STATUSES = [
  "CONNECTED",
  "REAUTH_REQUIRED",
  "DISCONNECTED",
  "ERROR",
] as const;
export type AIConnectionStatus = (typeof AI_CONNECTION_STATUSES)[number];

// GLOBAL_DEFAULT is the fallback purpose resolved when no business-specific
// assignment exists.
export const AI_ASSIGNMENT_PURPOSES = [
  "GLOBAL_DEFAULT",
  "INTERVIEW",
  "RESUME",
  "MATCH_ANALYSIS",
  "CAREER_REFLECTION",
  "CAREER_DIALOGUE",
] as const;
export type AIAssignmentPurpose = (typeof AI_ASSIGNMENT_PURPOSES)[number];

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

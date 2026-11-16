/**
 * Shared match-surface helpers: error-code → i18n bucket and verdict
 * badge/label mapping used by the fast-screening panel, the deep-match
 * section and the agent result card.
 */

const CONNECTION_CODES = new Set([
  "ASSIGNED_CONNECTION_UNAVAILABLE",
  "CONNECTION_DISCONNECTED",
  "CONNECTION_ERROR",
  "REAUTH_REQUIRED",
  "CONNECTION_REAUTH_REQUIRED",
  "RUNTIME_NOT_AVAILABLE",
  "RUNTIME_NOT_INSTALLED",
  "RUNTIME_BROKEN",
  "RUNTIME_UPDATE_REQUIRED",
  "BACKEND_UNAVAILABLE",
  "AI_EXECUTION_TIMEOUT",
  "AI_EXECUTION_FAILED",
  "INFERENCE_FAILED",
  "BYOK_CREDENTIAL_UNAVAILABLE",
  "GATEWAY_AUTH",
  "GATEWAY_NETWORK",
  "GATEWAY_TIMEOUT",
  "GATEWAY_RESPONSE",
  "MANAGED_AI_DISABLED",
  "MANAGED_AUTH_REQUIRED",
  "MANAGED_RUNTIME_UNAVAILABLE",
  "MANAGED_BINDING_UNAVAILABLE",
  "MANAGED_PROVENANCE_INVALID",
  "MANAGED_EXECUTION_NOT_IMPLEMENTED",
  "INVOCATION_ID_REQUIRED",
  "INVOCATION_CONFLICT",
  "INVOCATION_STATUS_UNKNOWN",
  "INVOCATION_IN_PROGRESS",
]);

const ASSIGNMENT_CODES = new Set([
  "AI_NOT_CONFIGURED",
  "MODEL_UNAVAILABLE",
  "MODEL_DISABLED",
  "MODEL_NOT_ALLOWED",
  "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  "PERMISSION_BOUNDARY_NOT_READY",
  "ACCOUNT_IDENTITY_CONFLICT",
  "CONNECTION_ARCHIVED",
  "CONNECTION_NOT_FOUND",
  "UNSUPPORTED_BACKEND",
  "PROVIDER_POLICY_RESTRICTED",
]);

const QUOTA_CODES = new Set([
  "QUOTA_EXCEEDED",
  "NOT_ENTITLED",
  "GATEWAY_RATE_LIMIT",
  "AI_REQUEST_TOO_LARGE",
]);

export function errorMessageKey(code: string): string {
  switch (code) {
    case "MATCH_JD_MISSING":
    case "MATCH_INSUFFICIENT_MATERIAL":
    case "NOT_CONFIGURED":
    case "VERSION_NOT_SUBMITTABLE":
    case "MATCH_UNAVAILABLE":
    case "OPPORTUNITY_ARCHIVED":
      return `matchAnalysis.errors.${code}`;
    default:
      break;
  }
  if (QUOTA_CODES.has(code)) return "matchAnalysis.errors.quota";
  if (ASSIGNMENT_CODES.has(code)) return "matchAnalysis.errors.invalidAssignment";
  if (CONNECTION_CODES.has(code)) return "matchAnalysis.errors.connection";
  if (code.startsWith("STRUCTURED_OUTPUT_")) {
    return "matchAnalysis.errors.output";
  }
  return "matchAnalysis.errors.generic";
}

export function verdictVariant(verdict: string | undefined): {
  variant: "default" | "secondary" | "destructive" | "outline";
  className?: string;
} {
  switch (verdict) {
    case "PASS":
      return { variant: "secondary" };
    case "FAIL":
      return { variant: "destructive" };
    case "BORDERLINE":
      return { variant: "outline" };
    default:
      return { variant: "secondary" };
  }
}

export function verdictLabel(
  verdict: string | null | undefined,
  t: (key: string) => string,
): string {
  const key = `matchAnalysis.verdict.${verdict ?? "UNKNOWN"}`;
  const text = t(key);
  // Missing translations resolve to the key itself — fall back to the raw
  // verdict rather than showing an i18n path.
  return text === key ? (verdict ?? "—") : text;
}

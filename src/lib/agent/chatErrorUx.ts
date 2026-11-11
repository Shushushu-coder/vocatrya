export type AgentErrorCategory =
  | "recovery"
  | "conversation"
  | "saved"
  | "auth"
  | "connection"
  | "configuration"
  | "runtime-verification"
  | "capability"
  | "retryable"
  | "tool"
  | "managed-quota"
  | "managed-entitlement"
  | "managed-pending"
  | "managed-auth"
  | "managed-unavailable"
  | "generic";

const AUTH = new Set(["NOT_AUTHENTICATED", "REAUTH_REQUIRED"]);
const CONNECTION = new Set([
  "ASSIGNED_CONNECTION_UNAVAILABLE",
  "CONNECTION_DISCONNECTED",
  "CONNECTION_ERROR",
  "RUNTIME_NOT_AVAILABLE",
  "RUNTIME_NOT_INSTALLED",
  "RUNTIME_BROKEN",
  "BACKEND_UNAVAILABLE",
  "PERMISSION_BOUNDARY_NOT_READY",
]);
const CAPABILITY = new Set([
  "STREAMING_NOT_SUPPORTED",
  "STRUCTURED_OUTPUT_UNSUPPORTED",
  "STRUCTURED_OUTPUT_PARSE_FAILED",
  "STRUCTURED_OUTPUT_SCHEMA_FAILED",
  "STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION",
  "STRUCTURED_OUTPUT_TRUNCATED",
  "STRUCTURED_OUTPUT_RETRY_EXHAUSTED",
  "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  "AGENT_TOOL_NOT_ALLOWED",
]);
const RETRYABLE = new Set([
  "RATE_LIMITED",
  "AI_EXECUTION_TIMEOUT",
  "AI_REQUEST_TOO_LARGE",
  "AI_EXECUTION_FAILED",
  "GATEWAY_RATE_LIMIT",
  "GATEWAY_TIMEOUT",
]);
const TOOL = new Set([
  "AGENT_TOOL_ARGUMENT_INVALID",
  "AGENT_TOOL_PROTOCOL_FAILED",
  "AGENT_STEP_LIMIT_REACHED",
]);

export function categorizeAgentErrorCode(
  code: string | null | undefined,
): AgentErrorCategory {
  if (!code) return "generic";
  if (code === "MANAGED_AUTH_REQUIRED") return "managed-auth";
  if (["MANAGED_AI_DISABLED", "MANAGED_RUNTIME_UNAVAILABLE", "GATEWAY_AUTH", "GATEWAY_NETWORK", "GATEWAY_RESPONSE"].includes(code)) return "managed-unavailable";
  if (code === "QUOTA_EXCEEDED") return "managed-quota";
  if (["NOT_ENTITLED", "MODEL_NOT_ALLOWED", "MODEL_DISABLED"].includes(code)) return "managed-entitlement";
  if (["INVOCATION_STATUS_UNKNOWN", "INVOCATION_IN_PROGRESS", "INVOCATION_REPLAYED", "INVOCATION_CONFLICT"].includes(code)) return "managed-pending";
  if (["MANAGED_BINDING_UNAVAILABLE", "MANAGED_PROVENANCE_INVALID"].includes(code)) return "configuration";
  if (code === "CAPABILITY_UNSUPPORTED") return "capability";
  if (code === "CONVERSATION_REFRESH_FAILED" || code === "CONVERSATION_CANCEL_FAILED") return "recovery";
  if (code === "CONVERSATION_OPERATION_SAVED") return "saved";
  if (code.startsWith("CONVERSATION_")) return "conversation";
  if (code === "AI_NOT_CONFIGURED" || code === "MODEL_UNAVAILABLE") return "configuration";
  if (code === "STREAMING_NOT_VERIFIED" || code === "STRUCTURED_OUTPUT_NOT_VERIFIED") return "runtime-verification";
  if (AUTH.has(code)) return "auth";
  if (CONNECTION.has(code)) return "connection";
  if (CAPABILITY.has(code)) return "capability";
  if (RETRYABLE.has(code)) return "retryable";
  if (TOOL.has(code)) return "tool";
  return "generic";
}

export function agentErrorCopy(category: AgentErrorCategory): {
  titleKey: string;
  bodyKey: string;
  action: "retry" | "settings" | "new-model" | null;
} {
  switch (category) {
    case "managed-auth":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.managedAuth", action: "settings" };
    case "managed-unavailable":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.managedUnavailable", action: "settings" };
    case "managed-quota":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.managedQuota", action: "settings" };
    case "managed-entitlement":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.managedEntitlement", action: "settings" };
    case "managed-pending":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.managedPending", action: null };
    case "configuration":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.notConfigured", action: "settings" };
    case "runtime-verification":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.runtimeUnverified", action: "settings" };
    case "recovery":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.recoveryFailed", action: null };
    case "conversation":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.conversationChanged", action: null };
    case "saved":
      return { titleKey: "agent.errors.cannotSend", bodyKey: "agent.errors.operationSaved", action: null };
    case "auth":
      return {
        titleKey: "agent.errors.reauthTitle",
        bodyKey: "agent.errors.reauth",
        action: "settings",
      };
    case "connection":
      return {
        titleKey: "agent.errors.cannotSend",
        bodyKey: "agent.errors.connectionDown",
        action: "retry",
      };
    case "capability":
      return {
        titleKey: "agent.errors.cannotSend",
        bodyKey: "agent.errors.capability",
        action: "new-model",
      };
    case "retryable":
      return {
        titleKey: "agent.errors.cannotSend",
        bodyKey: "agent.errors.rateLimit",
        action: "retry",
      };
    case "tool":
      return {
        titleKey: "agent.errors.cannotSend",
        bodyKey: "agent.errors.toolFailed",
        action: "retry",
      };
    default:
      return {
        titleKey: "agent.errors.cannotSend",
        bodyKey: "agent.errors.generic",
        action: "retry",
      };
  }
}

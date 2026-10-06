import { ConversationRequestError } from "./conversationRequest";
import {
  InvalidToolApprovalError,
  InvalidToolInputError,
  NoSuchToolError,
  ToolCallNotFoundForApprovalError,
} from "ai";
import { AIUnavailableError } from "@/lib/ai/tools/errors";
import { AIBusinessError } from "@/lib/ai/connections";
import { log } from "@/lib/telemetry";
import { STREAM_ERROR_PREFIX } from "./streamError";

export { parseAgentStreamError } from "./streamError";

type ErrorContext = { provider?: string; model?: string };

// The single fixed fallback. Never interpolate error.message into what the
// client sees — provider SDKs leak request context into their messages.
const GENERIC = "Something went wrong on that turn. Try asking again.";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function nameOf(error: unknown): string {
  return error instanceof Error ? error.name : "";
}

/**
 * One mapping shared by the route's pre-stream catch and by
 * toUIMessageStreamResponse's onError, so the same failure reads the same on
 * either side of the 200-response boundary.
 */
export function mapAgentError(
  error: unknown,
  context: ErrorContext = {},
): string {
  if (error instanceof ConversationRequestError) return error.code === "CONVERSATION_PERSISTENCE_FAILED" ? "The conversation could not be saved. Reload before continuing." : "This conversation has changed. Reload and try your action again.";
  const provider = context.provider ?? "the AI provider";
  const model = context.model;
  const message = messageOf(error);
  const name = nameOf(error);

  // Always log the real error; only the mapped string crosses the wire.
  log.error("[agent-chat] error", {
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  if (error instanceof AIUnavailableError) return error.message;

  // Managed account-runtime failures — stable codes only, never the raw
  // message (runtime stderr and model output must not reach the client).
  if (error instanceof AIBusinessError) {
    switch (error.code) {
      case "AI_NOT_CONFIGURED":
        return "No AI connection is assigned for Career Dialogue. Pick one in Settings → AI Connections.";
      case "ASSIGNED_CONNECTION_UNAVAILABLE":
        return "The AI connection this conversation is bound to is no longer available. Clear the conversation to pick another, or fix the assignment in Settings.";
      case "REAUTH_REQUIRED":
        return "The AI connection this conversation uses needs you to sign in again. Open Settings → AI Connections.";
      case "CONNECTION_DISCONNECTED":
        return "The AI connection this conversation uses is disconnected. Reconnect it in Settings → AI Connections.";
      case "CONNECTION_ERROR":
        return "The AI connection this conversation uses is in an error state. Check it in Settings → AI Connections.";
      case "RUNTIME_NOT_AVAILABLE":
      case "RUNTIME_NOT_INSTALLED":
      case "RUNTIME_BROKEN":
        return "The managed AI runtime is not available right now. Check the connection in Settings → AI Connections.";
      case "MODEL_UNAVAILABLE":
        return "The AI assignment for this conversation has no usable model. Fix it in Settings → AI Connections.";
      case "STREAMING_NOT_SUPPORTED":
        return "The assigned AI runtime cannot stream responses, so it cannot run Career Dialogue.";
      case "STREAMING_NOT_VERIFIED":
        return "The assigned AI runtime's streaming has not been verified for the installed version. Verify or update it in Settings → AI Connections.";
      case "STRUCTURED_OUTPUT_NOT_VERIFIED":
      case "STRUCTURED_OUTPUT_UNSUPPORTED":
        return "The assigned AI runtime is not verified for the structured decisions Career Dialogue needs.";
      case "AI_EXECUTION_TIMEOUT":
        return "That response took too long. Ask again to retry.";
      case "AI_REQUEST_TOO_LARGE":
        return "That request was too large for the AI runtime. Shorten the pasted content and try again.";
      case "AGENT_TOOL_NOT_ALLOWED":
      case "AGENT_TOOL_ARGUMENT_INVALID":
      case "AGENT_TOOL_PROTOCOL_FAILED":
        return "The assistant produced something it could not act on. Try rephrasing, or Clear the conversation and ask again.";
      case "AGENT_STEP_LIMIT_REACHED":
        return "The assistant stopped after reaching its step limit for this turn.";
      default:
        return GENERIC;
    }
  }

  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /aborted|abort signal/i.test(message)
  ) {
    return "That response was stopped or took too long. Ask again to retry.";
  }

  if (
    InvalidToolApprovalError.isInstance?.(error) ||
    ToolCallNotFoundForApprovalError.isInstance?.(error) ||
    /ToolCallNotFoundForApproval|InvalidToolApproval/i.test(name)
  ) {
    return "That proposal has expired — the server no longer recognizes it. Use Clear and ask again.";
  }

  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(message)) {
    return `Cannot reach ${provider}. Make sure the service is running, or switch provider in Settings.`;
  }

  if (
    /does not support tools|tool (use|calling) (is )?not supported|no tools support/i.test(
      message,
    )
  ) {
    return `${provider}${model ? ` / ${model}` : ""} cannot use tools, so it cannot add a job. Pick a tool-capable model in Settings.`;
  }

  if (NoSuchToolError.isInstance?.(error) || /NoSuchTool/i.test(name)) {
    return "The model asked for a tool that does not exist here. It only has one: adding a job.";
  }

  if (
    InvalidToolInputError.isInstance?.(error) ||
    /InvalidToolInput/i.test(name)
  ) {
    return "The model sent arguments that did not fit the tool. Try rephrasing your request.";
  }

  if (/maximum number of steps|step limit|stopWhen/i.test(message)) {
    return "The assistant stopped after reaching its step limit for this turn.";
  }

  return GENERIC;
}

/**
 * Stable wire code. Reuses AIBusinessError codes. Request-level codes
 * (NOT_AUTHENTICATED, RATE_LIMITED, INVALID_REQUEST, GENERIC) are not a
 * second runtime taxonomy — they only label failures that are not
 * AIBusinessError.
 */
export function agentErrorCode(error: unknown): string {
  if (error instanceof ConversationRequestError) return error.code;
  if (error instanceof AIBusinessError) return error.code;
  const name = nameOf(error);
  const message = messageOf(error);
  if (name === "ChatConversationNotFoundError") return "CONVERSATION_NOT_FOUND";
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    /aborted|abort signal/i.test(message)
  ) {
    return "AI_EXECUTION_TIMEOUT";
  }
  if (/rate limit/i.test(message)) return "RATE_LIMITED";
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ECONNRESET/i.test(message)) {
    return "BACKEND_UNAVAILABLE";
  }
  if (
    /does not support tools|tool (use|calling) (is )?not supported|no tools support/i.test(
      message,
    )
  ) {
    return "AGENT_TOOL_NOT_ALLOWED";
  }
  if (
    InvalidToolApprovalError.isInstance?.(error) ||
    ToolCallNotFoundForApprovalError.isInstance?.(error) ||
    /ToolCallNotFoundForApproval|InvalidToolApproval/i.test(name) ||
    NoSuchToolError.isInstance?.(error) ||
    /NoSuchTool/i.test(name) ||
    InvalidToolInputError.isInstance?.(error) ||
    /InvalidToolInput/i.test(name)
  ) {
    return "AGENT_TOOL_ARGUMENT_INVALID";
  }
  if (/maximum number of steps|step limit|stopWhen/i.test(message)) {
    return "AGENT_STEP_LIMIT_REACHED";
  }
  if (/not authenticated/i.test(message)) return "NOT_AUTHENTICATED";
  if (/no ai model is configured/i.test(message)) return "AI_NOT_CONFIGURED";
  if (/invalid chat request/i.test(message)) return "INVALID_REQUEST";
  return "GENERIC";
}

export function agentErrorEnvelope(
  error: unknown,
  context: ErrorContext = {},
): { error: string; code: string } {
  return {
    error: mapAgentError(error, context),
    code: agentErrorCode(error),
  };
}

export function formatAgentStreamError(
  error: unknown,
  context: ErrorContext = {},
): string {
  const body = agentErrorEnvelope(error, context);
  return `${STREAM_ERROR_PREFIX}${body.code}\n${body.error}`;
}

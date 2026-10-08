/**
 * Business structured-execution seam — the single entry point for
 * consumers that need schema-shaped output from an assigned
 * ACCOUNT_LOGIN connection:
 *
 *   Business Assignment → resolve connectionId + model
 *     → structured-output readiness (capability-driven, enforced at the
 *       desktop execution boundary — never a backendKind branch here)
 *     → executeText structuredOutput payload
 *     → strict parse + schema validation (≤1 repair retry, same
 *       connection/model/schema/input)
 *     → typed value for the existing business persistence layer
 *
 * The resolver and the validator own their respective semantics: an
 * explicit-but-broken assignment fails as INVALID_ASSIGNMENT without any
 * fallback; NOT_CONFIGURED is surfaced to the caller so consumers with a
 * documented legacy path may keep it.
 */
import "server-only";
import type { ManagedAiProvenanceV1 } from "./managed-provenance";
import {
  AI_BUSINESS_ERROR_CODES,
  AIBusinessError,
  type AIBusinessErrorCode,
} from "@/lib/ai/connections";
import {
  resolveBusinessAIConfig,
  type BusinessAIResolution,
} from "@/lib/ai/assignments";
import {
  executeAIConnectionText,
  type ExecuteAIConnectionTextDeps,
} from "@/lib/ai/execution";
import {
  findUnsupportedSchemaKeys,
  runStructuredValidation,
  type StructuredOutputSchema,
  type StructuredOutputStrategy,
  type StructuredValidationAttempt,
  type StructuredValidationResult,
} from "@/lib/ai/structured-output";

export interface StructuredExecutionInput {
  userId: string;
  /** Assignment purpose — e.g. "RESUME". */
  purpose: string;
  /** The business prompt; the schema contract is appended by the validator. */
  prompt: string;
  /** Vocatrya-owned JSON schema within the conservative supported subset. */
  schema: StructuredOutputSchema;
  /** Fixed safe schema identifier — never derived from user input. */
  schemaName: string;
  /** Per-attempt timeout; the shared `signal` bounds the whole operation. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export type StructuredExecutionResult =
  | {
      status: "OK";
      /** The validated structured value (still `unknown` — cast by schema). */
      value: unknown;
      managedAiProvenance?: ManagedAiProvenanceV1;
      /** Lock fields — the resolved pair this operation ran under. */
      resolvedConnectionId: string;
      resolvedModel: string;
      provider: string;
      backendKind: string;
      assignmentSource: "BUSINESS_ASSIGNMENT" | "GLOBAL_DEFAULT";
      /** Model invocations actually issued — 1 or 2, never more. */
      attemptCount: number;
      retried: boolean;
      /** Per-attempt outcome categories — codes/paths only, never raw text. */
      attempts: StructuredValidationAttempt[];
    }
  | {
      /** Nothing is configured — the caller may use its legacy path if any. */
      status: "NOT_CONFIGURED";
    }
  | {
      status: "FAILED";
      code: AIBusinessErrorCode;
      /** Validator issue-path summary — no raw model output. */
      issueSummary: string | null;
      resolution: BusinessAIResolution | null;
      attempts: StructuredValidationAttempt[];
    };

function executionFailureCode(
  result: StructuredValidationResult,
): AIBusinessErrorCode {
  const last = result.attempts[result.attempts.length - 1];
  const code = last?.code ?? result.issueSummary;
  return code &&
    (Object.values(AI_BUSINESS_ERROR_CODES) as string[]).includes(code)
    ? (code as AIBusinessErrorCode)
    : AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED;
}

function validationFailureCode(
  status: StructuredValidationResult["status"],
): AIBusinessErrorCode {
  switch (status) {
    case "STRUCTURED_OUTPUT_UNSUPPORTED":
      return AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_UNSUPPORTED;
    case "STRUCTURED_OUTPUT_NOT_VERIFIED":
      return AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_NOT_VERIFIED;
    case "STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION":
      return AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_NATIVE_SCHEMA_VIOLATION;
    case "STRUCTURED_OUTPUT_TRUNCATED":
      return AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_TRUNCATED;
    case "STRUCTURED_OUTPUT_RETRY_EXHAUSTED":
      return AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_RETRY_EXHAUSTED;
    case "STRUCTURED_OUTPUT_PARSE_FAILED":
      return AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_PARSE_FAILED;
    case "STRUCTURED_OUTPUT_SCHEMA_FAILED":
      return AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_SCHEMA_FAILED;
    default:
      return AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED;
  }
}

export async function executeStructuredForAssignment(
  input: StructuredExecutionInput,
  deps: ExecuteAIConnectionTextDeps = {},
): Promise<StructuredExecutionResult> {
  const { userId, purpose, prompt, schema, schemaName, timeoutMs, signal } =
    input;

  // The schema is Vocatrya-owned; refuse anything outside the validator's
  // supported subset before any resolution or execution happens.
  if (findUnsupportedSchemaKeys(schema).length > 0) {
    return {
      status: "FAILED",
      code: AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_UNSUPPORTED,
      issueSummary: null,
      resolution: null,
      attempts: [],
    };
  }

  const resolution = await resolveBusinessAIConfig({ userId, purpose });
  if (resolution.status === "INVALID_ASSIGNMENT") {
    // Explicit broken assignment — fail as configured, never fall back.
    return {
      status: "FAILED",
      code: resolution.code,
      issueSummary: null,
      resolution,
      attempts: [],
    };
  }
  if (resolution.status !== "RESOLVED") {
    // NOT_CONFIGURED (and INTERVIEW's legacy coexistence) — the caller
    // decides whether a legacy path exists; we never substitute one.
    return { status: "NOT_CONFIGURED" };
  }

  const { connectionId, model } = resolution;
  let managedAiProvenance: ManagedAiProvenanceV1 | undefined;

  const result = await runStructuredValidation({
    prompt,
    schema,
    schemaName,
    signal,
    execute: async ({ prompt: attemptPrompt, signal: attemptSignal }) => {
      try {
        const outcome = await executeAIConnectionText(
          {
            userId,
            connectionId,
            model,
            managedAiProvenance,
            prompt: attemptPrompt,
            structuredOutput: { schema, schemaName },
            timeoutMs,
            signal: attemptSignal,
          },
          deps,
        );
        managedAiProvenance = outcome.managedAiProvenance;
        return {
          ok: true,
          text: outcome.text,
          structuredStrategy:
            (outcome.structuredStrategy as
              | StructuredOutputStrategy
              | null
              | undefined) ?? null,
          stopReason: outcome.stopReason ?? null,
          durationMs: outcome.durationMs,
        };
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof AIBusinessError
              ? error.code
              : AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
        };
      }
    },
  });

  if (
    result.status === "VALID" ||
    result.status === "VALID_AFTER_RETRY"
  ) {
    return {
      status: "OK",
      value: result.value,
      ...(managedAiProvenance ? { managedAiProvenance } : {}),
      resolvedConnectionId: connectionId,
      resolvedModel: model,
      provider: resolution.provider,
      backendKind: resolution.backendKind,
      assignmentSource: resolution.source,
      attemptCount: result.attempts.length,
      retried: result.retried,
      attempts: result.attempts,
    };
  }

  return {
    status: "FAILED",
    code:
      result.status === "EXECUTION_FAILED"
        ? executionFailureCode(result)
        : validationFailureCode(result.status),
    issueSummary: result.issueSummary,
    resolution,
    attempts: result.attempts,
  };
}

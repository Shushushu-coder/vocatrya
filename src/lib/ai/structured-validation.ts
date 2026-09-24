/**
 * Structured-output validation probe — the server-side binding between the
 * business TEXT_ONLY execution seam and the shared
 * parse → validate → ≤1 retry contract in structured-output.ts.
 *
 * This is a validation/diagnostic seam, not a business consumer: no
 * Resume, JobDescriptionParse, Interview, or Career Dialogue surface calls
 * it. Real trials run only against an existing CONNECTED managed
 * AIConnection — the underlying executeAIConnectionText gate enforces
 * that; this module adds nothing that bypasses it.
 */
import "server-only";
import {
  AI_BUSINESS_ERROR_CODES,
  AIBusinessError,
} from "@/lib/ai/connections";
import {
  executeAIConnectionText,
  type ExecuteAIConnectionTextDeps,
} from "@/lib/ai/execution";
import {
  findUnsupportedSchemaKeys,
  runStructuredValidation,
  runStructuredValidationSuite,
  type StructuredExecuteFn,
  type StructuredOutputSchema,
  type StructuredValidationResult,
  type StructuredValidationSuiteResult,
  type StructuredValidationTrial,
} from "@/lib/ai/structured-output";
import { STRUCTURED_VALIDATION_TRIALS } from "@/lib/ai/structured-validation-fixtures";

export interface StructuredProbeInput {
  userId: string;
  connectionId: string;
  model: string;
  /** Synthetic task text only — never user resume/JD content. */
  prompt: string;
  schema: StructuredOutputSchema;
  schemaName: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Binds the probe's execute callback to the ticketed TEXT_ONLY channel.
 * The schema always rides the `structuredOutput` payload so a runtime with
 * a native schema mechanism applies it; a prompt-only runtime ignores the
 * payload (the schema is already inside the prompt) and the desktop
 * reports which strategy actually ran.
 */
function bindProbeExecute(
  input: Pick<StructuredProbeInput, "userId" | "connectionId" | "model" | "timeoutMs">,
  signal: AbortSignal | undefined,
  deps: ExecuteAIConnectionTextDeps,
): StructuredExecuteFn {
  return async ({ prompt: attemptPrompt, schema, schemaName }) => {
    try {
      const result = await executeAIConnectionText(
        {
          userId: input.userId,
          connectionId: input.connectionId,
          model: input.model,
          prompt: attemptPrompt,
          structuredOutput: { schema, schemaName },
          timeoutMs: input.timeoutMs,
          signal,
        },
        deps,
      );
      // The desktop reports the strategy as a string over the wire —
      // re-narrow it here so an unexpected value never masquerades as a
      // known mechanism.
      const strategy = result.structuredStrategy;
      return {
        ok: true,
        text: result.text,
        structuredStrategy:
          strategy === "NATIVE_JSON_SCHEMA" ||
          strategy === "PROMPT_AND_VALIDATE" ||
          strategy === "UNSUPPORTED"
            ? strategy
            : null,
        stopReason: result.stopReason ?? null,
        durationMs: result.durationMs,
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
  };
}

/**
 * One schema probe against a managed connection.
 */
export async function executeAIConnectionStructuredProbe(
  input: StructuredProbeInput,
  deps: ExecuteAIConnectionTextDeps = {},
): Promise<StructuredValidationResult> {
  const unsupported = findUnsupportedSchemaKeys(input.schema);
  if (unsupported.length > 0) {
    return {
      status: "STRUCTURED_OUTPUT_UNSUPPORTED",
      value: null,
      attempts: [],
      firstPassValid: false,
      retried: false,
      validAfterRetry: false,
      nativeViolation: false,
      issueSummary: `unsupported schema keys: ${unsupported.join(", ")}`,
    };
  }
  return runStructuredValidation({
    prompt: input.prompt,
    schema: input.schema,
    schemaName: input.schemaName,
    signal: input.signal,
    execute: bindProbeExecute(input, input.signal, deps),
  });
}

/**
 * The full 9-trial corpus against one managed connection. Budget is fixed
 * by construction: ≤9 primary calls + ≤1 retry each — at most 18 model
 * calls, never a retry-until-green loop.
 */
export async function runStructuredValidationProbeSuite(
  input: Omit<StructuredProbeInput, "prompt" | "schema" | "schemaName"> & {
    trials?: StructuredValidationTrial[];
  },
  deps: ExecuteAIConnectionTextDeps = {},
): Promise<StructuredValidationSuiteResult> {
  const trials = input.trials ?? STRUCTURED_VALIDATION_TRIALS;
  return runStructuredValidationSuite({
    trials,
    signal: input.signal,
    execute: bindProbeExecute(input, input.signal, deps),
  });
}

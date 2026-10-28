/**
 * BYOK execution — the LOCAL_BYOK branch of the business execution seam.
 *
 * Runs the user's own provider key through the AI SDK in-process: the same
 * providers.ts factory surface the legacy path uses, but with the strict
 * credential binding of an explicit connection (resolveByokCredential —
 * no env-var or default fallback). Prompt/schema caps and the status gate
 * already ran in the caller; errors stay inside the business taxonomy —
 * never MANAGED_*, never *_RUNTIME codes.
 */
import "server-only";

import { generateText, streamText } from "ai";
import {
  AI_BUSINESS_ERROR_CODES,
  AIBusinessError,
  byokApiKeyProviderFor,
  type AIBusinessErrorCode,
} from "@/lib/ai/connections";
import {
  AI_EXECUTION_DEFAULT_TIMEOUT_MS,
  AI_EXECUTION_MAX_TIMEOUT_MS,
} from "@/lib/ai/execution";
import { PROVIDER_FACTORIES } from "@/lib/ai/provider-registry.server";
import { resolveByokCredential } from "@/lib/ai/byok";
import type { CredentialStoreDeps } from "@/lib/ai/credential-store";
import type { PrismaClient } from "@prisma/client";

interface ByokConnectionRow {
  id: string;
  provider: string;
  credentialRef: string | null;
}

export interface ByokTextInput {
  userId: string;
  connection: ByokConnectionRow;
  model: string;
  prompt: string;
  structuredOutput?: { schema: Record<string, unknown>; schemaName: string };
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ByokExecutionDeps {
  dbClient?: Pick<PrismaClient, "apiKey">;
  /** Credential-store seam (broker client overrides in tests). */
  credentialStore?: CredentialStoreDeps;
  /** Test seam for the AI SDK call. */
  generateTextImpl?: typeof generateText;
  streamTextImpl?: typeof streamText;
}

function fail(code: AIBusinessErrorCode, message: string): never {
  throw new AIBusinessError(code, message);
}

function combinedSignal(input: { timeoutMs?: number; signal?: AbortSignal }): AbortSignal {
  const timeoutMs = Math.min(
    Math.max(input.timeoutMs ?? AI_EXECUTION_DEFAULT_TIMEOUT_MS, 1_000),
    AI_EXECUTION_MAX_TIMEOUT_MS,
  );
  return AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(input.signal ? [input.signal] : []),
  ]);
}

async function byokLanguageModel(
  input: Pick<ByokTextInput, "userId" | "connection" | "model">,
  deps: ByokExecutionDeps,
) {
  const apiKeyProvider = byokApiKeyProviderFor(input.connection.provider);
  const factory = apiKeyProvider ? PROVIDER_FACTORIES[apiKeyProvider] : null;
  if (!apiKeyProvider || !factory) {
    fail(
      AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
      "The BYOK connection's provider has no execution surface",
    );
  }
  const credential = await resolveByokCredential(
    { userId: input.userId, connection: input.connection },
    deps.dbClient,
    deps.credentialStore,
  );
  return factory(credential, input.model.trim());
}

function mapByokError(error: unknown, signal: AbortSignal): AIBusinessError {
  if (error instanceof AIBusinessError) return error;
  // A real deadline expiry aborts the combined signal with a TimeoutError
  // reason — it is a timeout, not a user cancel. `signal.reason` is `any`
  // (DOMException), so read the name defensively rather than instanceof.
  const reasonName =
    typeof signal.reason === "object" && signal.reason !== null
      ? (signal.reason as { name?: unknown }).name
      : undefined;
  if (
    (error instanceof Error && error.name === "TimeoutError") ||
    reasonName === "TimeoutError"
  ) {
    return new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT,
      "AI execution timed out",
    );
  }
  if (
    signal.aborted ||
    (error instanceof Error && error.name === "AbortError")
  ) {
    return new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
      "Execution aborted",
    );
  }
  return new AIBusinessError(
    AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
    "BYOK provider request failed",
  );
}

/**
 * TEXT_ONLY one-shot through the user's own provider key. The structured
 * contract travels in the prompt (PROMPT_AND_VALIDATE) exactly like the
 * managed path — BYOK has no native schema transport to verify.
 */
export async function executeByokConnectionText(
  input: ByokTextInput,
  deps: ByokExecutionDeps = {},
): Promise<{
  text: string;
  structuredStrategy: "PROMPT_AND_VALIDATE";
  stopReason: string | null;
}> {
  const lm = await byokLanguageModel(input, deps);
  const signal = combinedSignal(input);
  const generate = deps.generateTextImpl ?? generateText;
  try {
    const result = await generate({
      model: lm,
      prompt: input.prompt,
      abortSignal: signal,
    });
    return {
      text: typeof result.text === "string" ? result.text : "",
      // The prompt already embeds the schema — same strategy the managed
      // gateway reports; there is nothing else to claim.
      structuredStrategy: "PROMPT_AND_VALIDATE",
      stopReason:
        typeof result.finishReason === "string" ? result.finishReason : null,
    };
  } catch (error) {
    throw mapByokError(error, signal);
  }
}

/**
 * Streaming variant yielding the same normalized event shape the desktop
 * seam emits: text-delta events then a completed terminal event. A BYOK
 * stream is real provider streaming — a buffered one-shot is never
 * disguised as deltas.
 */
export async function* executeByokConnectionTextStream(
  input: ByokTextInput,
  deps: ByokExecutionDeps = {},
): AsyncGenerator<
  | { type: "text-delta"; delta: string }
  | { type: "completed"; text: string; model: string }
> {
  const lm = await byokLanguageModel(input, deps);
  const signal = combinedSignal(input);
  const stream = deps.streamTextImpl ?? streamText;
  let result: ReturnType<typeof streamText>;
  try {
    result = stream({ model: lm, prompt: input.prompt, abortSignal: signal });
  } catch (error) {
    throw mapByokError(error, signal);
  }
  let text = "";
  try {
    for await (const delta of result.textStream) {
      if (typeof delta === "string" && delta.length > 0) {
        text += delta;
        yield { type: "text-delta", delta };
      }
    }
  } catch (error) {
    throw mapByokError(error, signal);
  }
  yield { type: "completed", text, model: input.model.trim() };
}

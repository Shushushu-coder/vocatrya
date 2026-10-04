import "server-only";

import type { LanguageModel } from "ai";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Prompt,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeAIConnectionTextStream } from "@/lib/ai/streaming-execution";
import { log } from "@/lib/telemetry";

/**
 * Provider-neutral LanguageModel adapter over a locked AIConnection.
 *
 * Career Dialogue's nested tools (review_resume / match_job /
 * generate_cover_letter) consume `streamText` through this adapter, so
 * their generations run on the SAME locked runtime + model as the
 * conversation itself instead of the legacy provider — without those
 * tools knowing anything about account runtimes.
 *
 * The runtime contract is text-only: prompts are flattened into a single
 * labeled transcript string, and the managed invocation's stdout is
 * adapted into AI SDK v3 stream parts (real deltas via execute-stream,
 * never a buffered fake stream).
 */

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function flattenPrompt(prompt: LanguageModelV3Prompt): string {
  const lines: string[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      lines.push(`System:\n${message.content}`);
      continue;
    }
    if (typeof message.content === "string") {
      lines.push(`${message.role}:\n${message.content}`);
      continue;
    }
    const parts = (message.content as unknown as Array<Record<string, unknown>>).map(
      (part) => {
        if (part.type === "text" && typeof part.text === "string") {
          return part.text;
        }
        if (part.type === "tool-call") {
          return `[called tool ${String(part.toolName)} with ${JSON.stringify(part.input ?? {})}]`;
        }
        if (part.type === "tool-result") {
          return `[tool ${String(part.toolName)} returned ${JSON.stringify(part.output ?? null)}]`;
        }
        // File/image/reasoning parts have no text the runtime can use.
        return "";
      },
    );
    const label = message.role === "assistant" ? "Assistant" : message.role === "tool" ? "Tool" : "User";
    lines.push(`${label}:\n${parts.filter(Boolean).join("\n")}`);
  }
  return lines.join("\n\n");
}

export type AccountRuntimeModelOptions = {
  userId: string;
  connectionId: string;
  /** The locked model id — `resolvedModel` on the conversation. */
  modelName: string;
  /** Timeout per nested one-shot call. */
  timeoutMs?: number;
};

export function createAccountRuntimeLanguageModel({
  userId,
  connectionId,
  modelName,
  timeoutMs,
}: AccountRuntimeModelOptions): LanguageModel {
  const adapter: LanguageModelV3 = {
    specificationVersion: "v3",
    provider: "vocatrya.account",
    modelId: modelName,
    supportedUrls: {},

    async doGenerate(options: LanguageModelV3CallOptions) {
      const result = await executeAIConnectionText({
        userId,
        connectionId,
        model: modelName,
        prompt: flattenPrompt(options.prompt),
        timeoutMs,
        signal: options.abortSignal,
      });
      return {
        content: [{ type: "text" as const, text: result.text }],
        finishReason: { unified: "stop" as const, raw: undefined },
        usage: EMPTY_USAGE,
        warnings: [],
      };
    },

    async doStream(options: LanguageModelV3CallOptions) {
      const prompt = flattenPrompt(options.prompt);
      const textId = "account-text-1";
      const startedAt = Date.now();
      const stream = new ReadableStream<LanguageModelV3StreamPart>({
        async start(controller) {
          // streamText settles textStream and finishReason only when this
          // ReadableStream closes. runToolsTransformation holds the finish
          // chunk until flush, and flush runs on close — enqueueing finish
          // without close leaves the nested tool pending forever.
          let terminal = false;
          let opened = false;
          let deltaCount = 0;
          const settleLog = (
            outcome: "succeeded" | "aborted" | "timed_out" | "failed",
            code?: string,
          ) => {
            log.info("[agent-chat] account stream settled", {
              provider: "vocatrya.account",
              model: modelName,
              outcome,
              // Account runtimes signal success with a completed event.
              // They do not carry an optional provider finishReason.
              finishReasonPresent: false,
              deltaCount,
              elapsedMs: Date.now() - startedAt,
              aborted: outcome === "aborted",
              timedOut: outcome === "timed_out",
              ...(code ? { code } : {}),
            });
          };
          const succeed = () => {
            if (terminal) return;
            terminal = true;
            if (opened) controller.enqueue({ type: "text-end", id: textId });
            controller.enqueue({
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage: EMPTY_USAGE,
            });
            controller.close();
            settleLog("succeeded");
          };
          const failStream = (error: unknown) => {
            if (terminal) return;
            terminal = true;
            const name = error instanceof Error ? error.name : "";
            const code =
              error && typeof error === "object" && "code" in error
                ? String((error as { code?: unknown }).code ?? "")
                : "";
            const outcome =
              options.abortSignal?.aborted || name === "AbortError"
                ? "aborted"
                : code === "AI_EXECUTION_TIMEOUT"
                  ? "timed_out"
                  : "failed";
            settleLog(outcome, code || undefined);
            try {
              controller.error(error instanceof Error ? error : new Error(String(error)));
            } catch {
              // The consumer already cancelled the stream.
            }
          };

          controller.enqueue({ type: "stream-start", warnings: [] });
          let sawCompleted = false;
          try {
            for await (const event of executeAIConnectionTextStream({
              userId,
              connectionId,
              model: modelName,
              prompt,
              timeoutMs,
              signal: options.abortSignal,
            })) {
              if (terminal) break;
              if (event.type === "text-delta") {
                if (!opened) {
                  controller.enqueue({ type: "text-start", id: textId });
                  opened = true;
                }
                deltaCount += 1;
                controller.enqueue({
                  type: "text-delta",
                  id: textId,
                  delta: event.delta,
                });
              } else if (event.type === "completed") {
                // Trusted terminal success. A missing finishReason on this
                // event is normal; EOF without this event is not success.
                sawCompleted = true;
                if (!opened) {
                  controller.enqueue({ type: "text-start", id: textId });
                  opened = true;
                  if (event.text) {
                    deltaCount += 1;
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: event.text,
                    });
                  }
                }
                break;
              } else if (event.type === "error") {
                failStream(
                  Object.assign(new Error(event.code), {
                    name: "AIBusinessError",
                    code: event.code,
                  }),
                );
                return;
              }
            }
            if (!sawCompleted) {
              failStream(
                Object.assign(new Error("stream ended without a terminal completion"), {
                  name: "AIBusinessError",
                  code: "AI_EXECUTION_FAILED",
                }),
              );
              return;
            }
            succeed();
          } catch (error) {
            failStream(error);
          }
        },
      });
      return { stream };
    },
  };

  // LanguageModel is the SDK's union across spec versions — v3 members
  // satisfy it directly.
  return adapter as LanguageModel;
}

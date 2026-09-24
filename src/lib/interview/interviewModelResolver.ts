import "server-only";

import type { LanguageModel } from "ai";
import {
  getInterviewModel,
  getInterviewModelForConfig,
  type InterviewModelHandle,
} from "./getInterviewModel";

/**
 * InterviewModelResolver boundary (Phase 2).
 *
 * Phase 1 domain/service -> InterviewModelResolver -> Vocatrya adapter
 * -> getInterviewModel(userId) -> shared getModel().
 *
 * This module owns the Phase 1 resolver shape inside Vocatrya (the port
 * workspace stays untouched). Future transplanted feedback/summary/coaching
 * services must depend on this interface, never on
 * `src/lib/ai/providers.ts` directly. Provenance exposes provider/model
 * only; credentials never leave getInterviewModel().
 */

/** Minimal Phase 1 contract: resolve a user model that emits strict JSON. */
export interface ResolvedInterviewModel {
  provider: string;
  model: string;
  generateJson(input: { system: string; prompt: string }): Promise<unknown>;
}

/** Phase 1 resolver interface (naming mirrors the port, owned here). */
export interface InterviewModelResolver {
  resolve(userId: string): Promise<ResolvedInterviewModel>;
}

/**
 * Session-aware extension: the Vocatrya model adapter also needs a
 * legacy pair pinned at session-creation time (provider/model from the
 * persisted lock, not a live settings read).
 */
export interface InterviewSessionModelResolver extends InterviewModelResolver {
  resolveForConfig(
    userId: string,
    config: { provider: string; model: string },
  ): Promise<ResolvedInterviewModel>;
}

export type ResolveInterviewHandle = (
  userId: string,
) => Promise<InterviewModelHandle>;

export type ResolveInterviewConfigHandle = (
  userId: string,
  config: { provider: string; model: string },
) => Promise<InterviewModelHandle>;

function toResolvedModel(handle: InterviewModelHandle): ResolvedInterviewModel {
  const model = handle.model as LanguageModel;
  const provider = handle.provider;
  const modelName = handle.modelName;
  return {
    provider,
    model: modelName,
    async generateJson({ system, prompt }: { system: string; prompt: string }) {
      const { generateText } = await import("ai");
      const result = await generateText({ model, system, prompt });
      const text = typeof result.text === "string" ? result.text.trim() : "";
      if (!text) {
        throw new Error("Interview model returned empty output");
      }
      try {
        return JSON.parse(text) as unknown;
      } catch {
        // Never propagate the raw parse error — its message can embed a
        // snippet of model output, which must not reach diagnostics or
        // persisted failure records.
        throw new Error("Interview model returned non-JSON output");
      }
    },
  };
}

/**
 * Vocatrya adapter resolver. Delegates credential/model work to
 * getInterviewModel() and implements generateJson() over the shared Vercel
 * AI SDK model. Raw text is parsed as JSON strictly: parse failures
 * propagate and must never relax the Phase 1 validator.
 */
export class VocatryaInterviewModelResolver
  implements InterviewSessionModelResolver
{
  constructor(
    private readonly resolveHandle: ResolveInterviewHandle = (userId) =>
      getInterviewModel(userId),
    private readonly resolveConfigHandle: ResolveInterviewConfigHandle = (
      userId,
      config,
    ) => getInterviewModelForConfig(userId, config),
  ) {}

  async resolve(userId: string): Promise<ResolvedInterviewModel> {
    return toResolvedModel(await this.resolveHandle(userId));
  }

  async resolveForConfig(
    userId: string,
    config: { provider: string; model: string },
  ): Promise<ResolvedInterviewModel> {
    return toResolvedModel(await this.resolveConfigHandle(userId, config));
  }
}

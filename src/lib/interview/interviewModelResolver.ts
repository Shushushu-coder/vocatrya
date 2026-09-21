import "server-only";

import type { LanguageModel } from "ai";
import {
  getInterviewModel,
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

export type ResolveInterviewHandle = (
  userId: string,
) => Promise<InterviewModelHandle>;

/**
 * Vocatrya adapter resolver. Delegates credential/model work to
 * getInterviewModel() and implements generateJson() over the shared Vercel
 * AI SDK model. Raw text is parsed as JSON strictly: parse failures
 * propagate and must never relax the Phase 1 validator.
 */
export class VocatryaInterviewModelResolver implements InterviewModelResolver {
  constructor(
    private readonly resolveHandle: ResolveInterviewHandle = (userId) =>
      getInterviewModel(userId),
  ) {}

  async resolve(userId: string): Promise<ResolvedInterviewModel> {
    const handle = await this.resolveHandle(userId);
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
        return JSON.parse(text) as unknown;
      },
    };
  }
}

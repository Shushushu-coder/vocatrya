import "server-only";

import db from "@/lib/db";
import { getModel } from "@/lib/ai/providers";
import { PROVIDER_REGISTRY } from "@/lib/ai/provider-registry";
import type { LanguageModel } from "ai";
import {
  INTERVIEW_ADAPTER_ERROR_CODES,
  InterviewAdapterError,
} from "./errors";
import { getInterviewConfig } from "./interviewSettings";
import { toInterviewProvenance, type InterviewModelProvenance } from "./provenance";

export { INTERVIEW_ADAPTER_ERROR_CODES, InterviewAdapterError };

/** Handle returned by getInterviewModel: SDK model + provenance only. */
export interface InterviewModelHandle {
  /** Vercel AI SDK language model, ready for generateText/streamText. */
  model: LanguageModel;
  provider: string;
  modelName: string;
  provenance: InterviewModelProvenance;
}

export type GetModelFn = (
  provider: string,
  modelName: string,
  userId?: string,
) => Promise<LanguageModel>;

export interface GetInterviewModelDeps {
  loadSettingsJson?: (userId: string) => Promise<string | null>;
  getModelFn?: GetModelFn;
}

function notConfigured(message: string): InterviewAdapterError {
  return new InterviewAdapterError(
    INTERVIEW_ADAPTER_ERROR_CODES.INTERVIEW_MODEL_NOT_CONFIGURED,
    message,
  );
}

/**
 * Resolve the per-user interview model.
 *
 * userId -> UserSettings.settings.ai.interview -> validate provider/model
 * -> existing getModel(provider, model, userId).
 *
 * Frozen rules:
 * - NO global provider/model fallback, NO Ollama fallback, NO silent default.
 * - Missing `ai.interview` / provider / model throws
 *   INTERVIEW_MODEL_NOT_CONFIGURED WITHOUT calling getModel().
 * - Unknown interview provider also throws INTERVIEW_MODEL_NOT_CONFIGURED
 *   without calling getModel().
 * - Credential errors raised by the shared getModel() propagate unchanged.
 * - The return value carries provider/model provenance only, never keys.
 */
export async function getInterviewModel(
  userId: string,
  deps: GetInterviewModelDeps = {},
): Promise<InterviewModelHandle> {
  if (!userId || typeof userId !== "string" || userId.trim().length === 0) {
    throw notConfigured("Interview model is not configured for this user.");
  }
  const loadSettingsJson =
    deps.loadSettingsJson ??
    (async (id: string): Promise<string | null> => {
      const row = await db.userSettings.findUnique({
        where: { userId: id },
        select: { settings: true },
      });
      return row?.settings ?? null;
    });

  let raw: string | null;
  try {
    raw = await loadSettingsJson(userId);
  } catch {
    throw notConfigured("Interview model is not configured for this user.");
  }
  if (!raw) {
    throw notConfigured("Interview model is not configured for this user.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw notConfigured("Interview model is not configured for this user.");
  }
  const container =
    parsed !== null && typeof parsed === "object"
      ? (parsed as { ai?: { interview?: unknown } })
      : {};
  const config = getInterviewConfig(container);
  if (!config) {
    throw notConfigured("Interview model is not configured for this user.");
  }
  if (!PROVIDER_REGISTRY[config.provider]) {
    throw notConfigured(
      `Interview provider "${config.provider}" is not a known AI provider.`,
    );
  }

  const getModelFn =
    deps.getModelFn ??
    ((provider: string, modelName: string, id?: string) =>
      getModel(
        provider as Parameters<typeof getModel>[0],
        modelName,
        id,
      ) as Promise<LanguageModel>);

  const model = await getModelFn(config.provider, config.model, userId);
  return {
    model,
    provider: config.provider,
    modelName: config.model,
    provenance: toInterviewProvenance(config.provider, config.model),
  };
}

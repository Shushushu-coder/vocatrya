import { AiProvider } from "@/models/ai.model";
import {
  defaultUserSettings,
  type InterviewAiSettings,
  type UserSettingsData,
} from "@/models/userSettings.model";

/**
 * Phase 2 settings parser / validation / backward compatibility.
 *
 * Rules (frozen):
 * - `settings.ai.interview` is optional. Legacy settings without it parse
 *   normally and yield `undefined` from getInterviewConfig().
 * - The interview config is NEVER populated from global `ai.provider` /
 *   `ai.model`, and NEVER defaults to Ollama. A missing/incomplete interview
 *   block means INTERVIEW_MODEL_NOT_CONFIGURED downstream.
 * - Provider/model are non-empty trimmed strings. Whitespace-only counts
 *   as missing.
 */

export interface InterviewContainer {
  ai?: {
    interview?: unknown;
  } | null;
}

function asTrimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseProvider(value: unknown): AiProvider | undefined {
  const trimmed = asTrimmedString(value);
  if (!trimmed) return undefined;
  const allowed: readonly string[] = Object.values(AiProvider);
  return allowed.includes(trimmed) ? (trimmed as AiProvider) : undefined;
}

/** Extract a validated interview config, or `undefined` when absent/invalid. */
export function getInterviewConfig(
  settings: InterviewContainer | undefined | null,
): InterviewAiSettings | undefined {
  const raw = settings?.ai?.interview as
    | { provider?: unknown; model?: unknown }
    | undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const provider = asTrimmedString(raw.provider);
  const model = asTrimmedString(raw.model);
  if (!provider || !model) return undefined;
  return { provider, model };
}

/** True when the settings carry a usable interview provider/model pair. */
export function hasInterviewConfig(
  settings: InterviewContainer | undefined | null,
): boolean {
  return getInterviewConfig(settings) !== undefined;
}

/**
 * Parse a raw `UserSettings.settings` JSON string into UserSettingsData.
 * Tolerant: invalid JSON yields defaults (global only, no interview).
 * Legacy payloads without `ai.interview` keep parsing; interview stays
 * `undefined`. Unknown extra keys are ignored.
 */
export function parseUserSettingsJson(raw: string | null | undefined): UserSettingsData {
  const fallback: UserSettingsData = {
    ai: { ...defaultUserSettings.ai },
    display: { ...defaultUserSettings.display },
  };
  if (typeof raw !== "string" || raw.trim().length === 0) return fallback;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return fallback;
  }
  const aiRaw = (parsed.ai ?? {}) as Record<string, unknown>;
  const provider = parseProvider(aiRaw.provider) ?? defaultUserSettings.ai.provider;
  const model =
    asTrimmedString(aiRaw.model) ?? defaultUserSettings.ai.model;
  const interview = getInterviewConfig({
    ai: { interview: aiRaw.interview },
  });
  const displayRaw = (parsed.display ?? {}) as Record<string, unknown>;
  const themeRaw = asTrimmedString(displayRaw.theme);
  const theme =
    themeRaw === "light" || themeRaw === "dark" || themeRaw === "system"
      ? themeRaw
      : defaultUserSettings.display.theme;
  return {
    ai: interview ? { provider, model, interview } : { provider, model },
    display: { theme },
  };
}

/**
 * Merge helper for UserSettings writes. Preserves an existing interview
 * config across partial global-ai updates, and applies an explicit
 * interview update when one is supplied. Passing `interview: undefined`
 * explicitly clears the interview config; omitting the key preserves it.
 */
export function mergeAiSettingsForUpdate(
  current: UserSettingsData["ai"],
  update: Partial<UserSettingsData["ai"]> & {
    interview?: InterviewAiSettings | undefined;
  },
  updateHasInterviewKey: boolean,
): UserSettingsData["ai"] {
  const base: UserSettingsData["ai"] = {
    provider: update.provider ?? current.provider,
    model: update.model !== undefined ? update.model : current.model,
  };
  if (updateHasInterviewKey) {
    const next = (update as { interview?: unknown }).interview;
    const normalized = getInterviewConfig({ ai: { interview: next } });
    // Explicit key present: a valid pair is stored, anything else clears.
    if (normalized) {
      base.interview = normalized;
    }
    return base;
  }
  if (current.interview) {
    const preserved = getInterviewConfig({
      ai: { interview: current.interview },
    });
    if (preserved) base.interview = preserved;
  }
  return base;
}

import { AiProvider } from "./ai.model";
import type { Locale } from "@/i18n/config";

/**
 * Phase 2 interview adapter contract.
 *
 * `settings.ai.interview` is independent of the global AI config.
 * There is intentionally NO fallback: global provider/model (including the
 * Ollama default) must never populate the interview config, and a missing
 * interview block must surface as INTERVIEW_MODEL_NOT_CONFIGURED downstream.
 */
export interface InterviewAiSettings {
  provider: string;
  model: string;
}

export interface AiSettings {
  provider: AiProvider;
  model: string | undefined;
  interview?: InterviewAiSettings;
}

export interface DisplaySettings {
  theme: "light" | "dark" | "system";
}

/**
 * Account-level general preferences under the `settings` document
 * namespace. `locale` is the only implemented field (SET-02 contract);
 * users with no persisted language preference simply lack the subtree.
 */
export interface GeneralSettings {
  locale?: Locale;
}

export interface UserSettingsData {
  ai: AiSettings;
  display: DisplaySettings;
  settings?: {
    general?: GeneralSettings;
  };
}

export interface UserSettings {
  userId: string;
  settings: UserSettingsData;
}

export const defaultUserSettings: UserSettingsData = {
  ai: {
    provider: AiProvider.OLLAMA,
    model: undefined,
  },
  display: {
    theme: "system",
  },
};

import { AiProvider } from "./ai.model";

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

export interface UserSettingsData {
  ai: AiSettings;
  display: DisplaySettings;
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

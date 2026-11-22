/**
 * Dictation (AWU-DICTATION) shared config — client- and server-safe.
 *
 * The transcription service is configured independently of the chat model:
 * the `dictation` top-level namespace of the user settings document carries
 * {provider, model, credentialMode}. Credentials are ApiKey rows on the
 * same protected store as BYOK keys — "shared" mode reads the provider's
 * existing row ("gemini"), "dedicated" mode a dictation-namespaced row
 * ("dictation-gemini") so a separate key never collides with chat BYOK.
 *
 * Gemini-only since N-2: a stored document naming another provider fails
 * isDictationProvider and surfaces as "not configured" — the record itself
 * is left untouched for the user to re-save.
 */

export const DICTATION_PROVIDERS = ["gemini"] as const;
export type DictationProvider = (typeof DICTATION_PROVIDERS)[number];

export const DICTATION_CREDENTIAL_MODES = ["shared", "dedicated"] as const;
export type DictationCredentialMode =
  (typeof DICTATION_CREDENTIAL_MODES)[number];

export interface DictationSettings {
  provider: DictationProvider;
  model: string;
  credentialMode: DictationCredentialMode;
}

export const DICTATION_DEFAULT_MODELS: Record<DictationProvider, string> = {
  gemini: "gemini-3.5-flash-lite",
};

// Keep legacy selections working; each model is paired with its actual API.
export const DICTATION_MODELS: Record<DictationProvider, readonly string[]> = {
  gemini: ["gemini-3.5-flash-lite", "gemini-3.5-transcribe", "gemini-2.5-flash", "gemini-2.5-pro"],
};

export function dictationProtocol(model: string) {
  return /^gemini-3\.5-transcribe(?:-\d{4}-\d{2}-\d{2})?$/.test(model.replace(/^models\//, ""))
    ? "gemini-interactions"
    : "gemini-generate-content";
}

export const DICTATION_PROVIDER_LABELS: Record<DictationProvider, string> = {
  gemini: "Google Gemini",
};

/** Where the dictation Gemini key is created — the UI links here. */
export const DICTATION_GEMINI_KEY_URL =
  "https://aistudio.google.com/api-keys";

/** ApiKey.provider value used by the dedicated-credential row. */
export function dictationApiKeyProvider(
  provider: DictationProvider,
): string {
  return `dictation-${provider}`;
}

export function isDictationApiKeyProvider(provider: string): boolean {
  return provider.startsWith("dictation-");
}

export function isDictationProvider(value: unknown): value is DictationProvider {
  return (
    typeof value === "string" &&
    (DICTATION_PROVIDERS as readonly string[]).includes(value)
  );
}

export function isDictationCredentialMode(
  value: unknown,
): value is DictationCredentialMode {
  return (
    typeof value === "string" &&
    (DICTATION_CREDENTIAL_MODES as readonly string[]).includes(value)
  );
}

const MAX_MODEL_CHARS = 128;

/**
 * Tolerant reader for the stored `dictation` namespace. Anything partial or
 * malformed yields null — a half-written config must surface as "not
 * configured", never as a silently defaulted provider.
 */
export function normalizeDictationSettings(
  value: unknown,
): DictationSettings | null {
  if (typeof value !== "object" || value === null) return null;
  const raw = value as Record<string, unknown>;
  const provider = isDictationProvider(raw.provider) ? raw.provider : null;
  const model =
    typeof raw.model === "string" && raw.model.trim().length > 0
      ? raw.model.trim()
      : null;
  const credentialMode = isDictationCredentialMode(raw.credentialMode)
    ? raw.credentialMode
    : "shared";
  if (!provider || !model || model.length > MAX_MODEL_CHARS) return null;
  return { provider, model, credentialMode };
}

/** Wire error codes shared by the route, the client transport and i18n. */
export const DICTATION_ERROR_CODES = {
  NOT_CONFIGURED: "DICTATION_NOT_CONFIGURED",
  CREDENTIAL_UNAVAILABLE: "DICTATION_CREDENTIAL_UNAVAILABLE",
  AUDIO_TOO_LARGE: "DICTATION_AUDIO_TOO_LARGE",
  INVALID_AUDIO: "DICTATION_INVALID_AUDIO",
  AUTH_FAILED: "DICTATION_AUTH_FAILED",
  MODEL_UNAVAILABLE: "DICTATION_MODEL_UNAVAILABLE",
  RATE_LIMITED: "DICTATION_RATE_LIMITED",
  TIMEOUT: "DICTATION_TIMEOUT",
  CANCELLED: "DICTATION_CANCELLED",
  NETWORK: "DICTATION_NETWORK",
  PROVIDER_ERROR: "DICTATION_PROVIDER_ERROR",
  EMPTY_RESULT: "DICTATION_EMPTY_RESULT",
  NO_SPEECH: "DICTATION_NO_SPEECH",
} as const;
export type DictationErrorCode =
  (typeof DICTATION_ERROR_CODES)[keyof typeof DICTATION_ERROR_CODES];

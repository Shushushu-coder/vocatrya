export type ApiKeyProvider = "openai" | "deepseek" | "openrouter" | "ollama" | "gemini";

export interface ApiKeyRecord {
  id: string;
  userId: string;
  provider: ApiKeyProvider;
  last4: string;
  label: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt: Date | null;
}

export interface ApiKeyClientResponse {
  id: string;
  provider: ApiKeyProvider;
  last4: string;
  // Full value for non-sensitive entries (e.g. URLs)
  displayValue?: string;
  // Storage format metadata: "os" = Windows safeStorage (DPAPI) envelope,
  // "app" = application-level AES cipher, "none" = non-sensitive plaintext.
  protection?: "os" | "app" | "none";
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

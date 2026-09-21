/**
 * Interview provider/model provenance.
 *
 * Only the actual provider + model identifiers cross the adapter boundary.
 * Credential details (API keys, base URLs, key metadata) must never be
 * included here or returned to callers.
 */
export interface InterviewModelProvenance {
  provider: string;
  model: string;
}

export function toInterviewProvenance(
  provider: string,
  model: string,
): InterviewModelProvenance {
  return { provider, model };
}

/** Guard: provenance objects must not carry credential fields. */
export function assertProvenanceHasNoCredentials(
  provenance: Record<string, unknown>,
): void {
  const forbidden = [
    "apiKey",
    "api_key",
    "credential",
    "baseUrl",
    "base_url",
    "key",
    "secret",
    "token",
    "last4",
    "iv",
  ];
  for (const field of forbidden) {
    if (field in provenance) {
      throw new Error(
        `Interview provenance must not contain credential field: ${field}`,
      );
    }
  }
}

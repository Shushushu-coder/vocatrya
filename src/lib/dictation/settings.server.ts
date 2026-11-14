/**
 * Server-side dictation settings + credential resolution.
 *
 * Reads the `dictation` namespace of the user's settings document and the
 * bound ApiKey row — "shared" resolves the provider's BYOK credential,
 * "dedicated" the `dictation-<provider>` row. Decryption goes through
 * resolveApiKeySecret, the same protected path BYOK uses; every failure
 * maps to stable DictationError codes with no key material in messages.
 */
import "server-only";

import prisma from "@/lib/db";
import { parseSettingsDocument } from "@/lib/userSettings/patch";
import { resolveApiKeySecret } from "@/lib/ai/credential-store";
import {
  DICTATION_ERROR_CODES,
  dictationApiKeyProvider,
  normalizeDictationSettings,
  type DictationSettings,
} from "@/lib/dictation/config";
import { DictationError } from "@/lib/dictation/transcribe.server";
import type { PrismaClient } from "@prisma/client";

type DbClient = Pick<PrismaClient, "userSettings" | "apiKey">;

export interface ResolvedDictationConfig {
  settings: DictationSettings;
  apiKey: string;
}

export function dictationSettingsFromDocument(
  rawSettings: string | null | undefined,
): DictationSettings | null {
  const doc = parseSettingsDocument(rawSettings);
  return normalizeDictationSettings(doc.dictation);
}

/**
 * Which ApiKey.provider value the config's credentialMode points at —
 * "shared" reuses the provider's BYOK row, "dedicated" the dictation row.
 */
export function credentialProviderFor(settings: DictationSettings): string {
  return settings.credentialMode === "dedicated"
    ? dictationApiKeyProvider(settings.provider)
    : settings.provider;
}

export async function resolveDictationConfig(
  userId: string,
  dbClient: DbClient = prisma,
): Promise<ResolvedDictationConfig> {
  const row = await dbClient.userSettings.findUnique({
    where: { userId },
    select: { settings: true },
  });
  const settings = dictationSettingsFromDocument(row?.settings);
  if (!settings) {
    throw new DictationError(
      DICTATION_ERROR_CODES.NOT_CONFIGURED,
      "Dictation is not configured. Pick a provider and model in Settings → Audio.",
    );
  }
  const credentialProvider = credentialProviderFor(settings);
  const keyRow = await dbClient.apiKey.findFirst({
    where: { userId, provider: credentialProvider },
    select: { encryptedKey: true, iv: true },
  });
  const unavailable = () =>
    new DictationError(
      DICTATION_ERROR_CODES.CREDENTIAL_UNAVAILABLE,
      "The API key configured for dictation cannot be read. Re-enter it in Settings → Audio.",
    );
  if (!keyRow) throw unavailable();
  try {
    const apiKey = await resolveApiKeySecret(keyRow);
    return { settings, apiKey };
  } catch {
    throw unavailable();
  }
}

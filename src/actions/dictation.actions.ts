"use server";

/**
 * Dictation settings actions (AWU-DICTATION).
 *
 * The `dictation` top-level namespace of the user settings document stores
 * {provider, model, credentialMode} — independent of the chat model (D6).
 * Credentials stay on the protected ApiKey store: "shared" resolves the
 * provider's BYOK row (written via the existing saveApiKey path so the
 * BYOK connection projection stays in sync), "dedicated" a
 * `dictation-<provider>` row that never collides with chat BYOK.
 * Only metadata (last4, storage format) ever leaves this surface.
 */
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import { saveApiKey } from "./apiKey.actions";
import {
  CredentialStoreError,
  isOsEnvelopeIv,
  sealApiKeySecret,
} from "@/lib/ai/credential-store";
import { getLast4 } from "@/lib/encryption";
import {
  patchUserSettings,
  SETTINGS_CONFLICT,
  type UserSettingsStore,
} from "@/lib/userSettings/patch";
import {
  DICTATION_PROVIDERS,
  dictationApiKeyProvider,
  isDictationCredentialMode,
  isDictationProvider,
  normalizeDictationSettings,
  type DictationCredentialMode,
  type DictationProvider,
  type DictationSettings,
} from "@/lib/dictation/config";
import { dictationSettingsFromDocument } from "@/lib/dictation/settings.server";

const MAX_KEY_CHARS = 4_096;
const MAX_MODEL_CHARS = 128;

// Same structural adapter as userSettings.actions — the CAS primitive never
// imports @/lib/db itself so the store stays injectable.
const userSettingsStore: UserSettingsStore = {
  findUnique: (args) => prisma.userSettings.findUnique(args),
  updateMany: (args) => prisma.userSettings.updateMany(args),
  create: (args) => prisma.userSettings.create(args),
};

export interface DictationKeyMeta {
  last4: string;
  protection: "os" | "app" | "none";
}

export type DictationCredentialStatus = Record<
  DictationProvider,
  { shared: DictationKeyMeta | null; dedicated: DictationKeyMeta | null }
>;

function keyMeta(row: {
  last4: string;
  iv: string;
  encryptedKey: string;
}): DictationKeyMeta {
  return {
    last4: row.last4,
    protection:
      row.iv === "" ? "none" : isOsEnvelopeIv(row.iv) ? "os" : "app",
  };
}

export async function getDictationSettings(): Promise<{
  success: boolean;
  data?: {
    config: DictationSettings | null;
    credentials: DictationCredentialStatus;
  };
  message?: string;
}> {
  try {
    const user = await requireUser();
    const providers = [...DICTATION_PROVIDERS, ...DICTATION_PROVIDERS.map(dictationApiKeyProvider)];
    const [settingsRow, keyRows] = await Promise.all([
      prisma.userSettings.findUnique({
        where: { userId: user.id },
        select: { settings: true },
      }),
      prisma.apiKey.findMany({
        where: { userId: user.id, provider: { in: providers } },
        select: { provider: true, last4: true, iv: true, encryptedKey: true },
      }),
    ]);
    const credentials = Object.fromEntries(
      DICTATION_PROVIDERS.map((provider) => [
        provider,
        {
          shared:
            keyRows.find((row) => row.provider === provider) ?? null,
          dedicated:
            keyRows.find(
              (row) => row.provider === dictationApiKeyProvider(provider),
            ) ?? null,
        },
      ]),
    ) as Record<
      DictationProvider,
      {
        shared: (typeof keyRows)[number] | null;
        dedicated: (typeof keyRows)[number] | null;
      }
    >;
    return {
      success: true,
      data: {
        config: dictationSettingsFromDocument(settingsRow?.settings),
        credentials: Object.fromEntries(
          Object.entries(credentials).map(([provider, entry]) => [
            provider,
            {
              shared: entry.shared ? keyMeta(entry.shared) : null,
              dedicated: entry.dedicated ? keyMeta(entry.dedicated) : null,
            },
          ]),
        ) as DictationCredentialStatus,
      },
    };
  } catch (error) {
    return handleError(error, "Failed to fetch dictation settings") as {
      success: boolean;
      message: string;
    };
  }
}

export async function updateDictationSettings(input: {
  provider?: unknown;
  model?: unknown;
  credentialMode?: unknown;
}): Promise<{ success: boolean; message?: string }> {
  try {
    const user = await requireUser();
    const provider = isDictationProvider(input.provider)
      ? input.provider
      : null;
    const model =
      typeof input.model === "string" && input.model.trim().length > 0
        ? input.model.trim()
        : null;
    const credentialMode = isDictationCredentialMode(input.credentialMode)
      ? input.credentialMode
      : null;
    if (!provider || !model || model.length > MAX_MODEL_CHARS || !credentialMode) {
      return {
        success: false,
        message: "Dictation provider, model and credential mode are required.",
      };
    }
    const patch: { dictation: DictationSettings } = {
      dictation: { provider, model, credentialMode },
    };
    const result = await patchUserSettings(user.id, patch, userSettingsStore);
    if (!result.success) {
      return {
        success: false,
        message:
          result.code === SETTINGS_CONFLICT
            ? "Settings changed while saving. Please retry."
            : result.message,
      };
    }
    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to save dictation settings") as {
      success: boolean;
      message: string;
    };
  }
}

export async function saveDictationKey(input: {
  provider?: unknown;
  credentialMode?: unknown;
  key?: unknown;
}): Promise<{
  success: boolean;
  data?: DictationKeyMeta;
  message?: string;
  code?: string;
}> {
  const provider = isDictationProvider(input.provider)
    ? input.provider
    : null;
  const credentialMode: DictationCredentialMode = isDictationCredentialMode(
    input.credentialMode,
  )
    ? input.credentialMode
    : "shared";
  const key =
    typeof input.key === "string" ? input.key.trim() : "";
  if (!provider) {
    return { success: false, message: "Unknown dictation provider." };
  }
  if (!key || key.length > MAX_KEY_CHARS) {
    return { success: false, message: "API key is required." };
  }

  if (credentialMode === "shared") {
    // Shared reuse goes through the existing BYOK save path verbatim —
    // validation, sealing and the AIConnection projection all stay in sync.
    const saved = await saveApiKey({ provider, key });
    if (!saved.success || !saved.data) {
      return {
        success: false,
        message: saved.message,
        code: saved.code,
      };
    }
    return {
      success: true,
      data: {
        last4: saved.data.last4,
        protection: saved.data.protection ?? "app",
      },
    };
  }

  try {
    const user = await requireUser();
    const { encryptedKey, iv } = await sealApiKeySecret(key);
    const row = await prisma.apiKey.upsert({
      where: {
        userId_provider: {
          userId: user.id,
          provider: dictationApiKeyProvider(provider),
        },
      },
      create: {
        userId: user.id,
        provider: dictationApiKeyProvider(provider),
        encryptedKey,
        iv,
        last4: getLast4(key),
        label: "Dictation",
      },
      update: { encryptedKey, iv, last4: getLast4(key), label: "Dictation" },
      select: { last4: true, iv: true, encryptedKey: true },
    });
    return { success: true, data: keyMeta(row) };
  } catch (error) {
    if (error instanceof CredentialStoreError) {
      return { success: false, code: error.code, message: error.message };
    }
    return handleError(error, "Failed to save dictation API key") as {
      success: boolean;
      message: string;
    };
  }
}

/**
 * Dedicated dictation keys can be removed here. Shared keys are the BYOK
 * credential itself — deleting them belongs to the BYOK settings surface,
 * so this action refuses rather than silently breaking chat BYOK.
 */
export async function deleteDictationKey(input: {
  provider?: unknown;
  credentialMode?: unknown;
}): Promise<{ success: boolean; message?: string }> {
  try {
    const user = await requireUser();
    const provider = isDictationProvider(input.provider)
      ? input.provider
      : null;
    if (!provider) {
      return { success: false, message: "Unknown dictation provider." };
    }
    if (input.credentialMode !== "dedicated") {
      return {
        success: false,
        message: "Shared keys are managed in the BYOK settings.",
      };
    }
    await prisma.apiKey.deleteMany({
      where: {
        userId: user.id,
        provider: dictationApiKeyProvider(provider),
      },
    });
    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to delete dictation API key") as {
      success: boolean;
      message: string;
    };
  }
}

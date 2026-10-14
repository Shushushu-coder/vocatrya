"use server";

import db from "@/lib/db";
import { getCurrentUser } from "@/utils/user.utils";
import { requireUser } from "./shared";
import { handleError } from "@/lib/utils";
import { getLast4 } from "@/lib/encryption";
import {
  CredentialStoreError,
  isOsEnvelopeIv,
  resolveApiKeySecret,
  sealApiKeySecret,
} from "@/lib/ai/credential-store";
import {
  markByokConnectionDisconnected,
  upsertByokConnectionForApiKey,
} from "@/lib/ai/byok";
import { apiKeySaveSchema } from "@/models/apiKey.schema";
import { PROVIDER_REGISTRY } from "@/lib/ai/provider-registry";
import type {
  ApiKeyClientResponse,
  ApiKeyProvider,
} from "@/models/apiKey.model";

export async function getUserApiKeys(): Promise<{
  success: boolean;
  data?: ApiKeyClientResponse[];
  message?: string;
}> {
  try {
    const user = await requireUser();

    const keys = await db.apiKey.findMany({
      where: { userId: user.id },
      select: {
        id: true,
        provider: true,
        last4: true,
        iv: true,
        encryptedKey: true,
        label: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });

    return {
      success: true,
      data: keys.map((k) => {
        const isSensitive = k.iv !== "";
        return {
          id: k.id,
          provider: k.provider as ApiKeyProvider,
          last4: k.last4,
          // Storage-format metadata only — "os" marks the DPAPI-bound
          // envelope, "app" the application cipher, "none" the
          // non-sensitive plaintext passthrough. Ciphertext never leaves.
          protection: isSensitive ? (isOsEnvelopeIv(k.iv) ? "os" : "app") : "none",
          ...(isSensitive ? {} : { displayValue: k.encryptedKey }),
          label: k.label,
          createdAt: k.createdAt,
          lastUsedAt: k.lastUsedAt,
        };
      }),
    };
  } catch (error) {
    return handleError(error, "Failed to fetch API keys") as {
      success: boolean;
      message: string;
    };
  }
}

export async function saveApiKey(input: {
  provider: string;
  key: string;
  label?: string;
  sensitive?: boolean;
}): Promise<{
  success: boolean;
  data?: ApiKeyClientResponse;
  message?: string;
  code?: string;
}> {
  try {
    const user = await requireUser();

    const parsed = apiKeySaveSchema.parse(input);
    // Sensitivity is decided server-side by the provider registry — a
    // client-supplied flag can never downgrade an api-key provider to
    // plaintext storage.
    const isSensitive =
      PROVIDER_REGISTRY[parsed.provider]?.keyConfig.sensitive ?? true;

    let encryptedKey: string;
    let iv: string;
    let last4: string;

    if (isSensitive) {
      // Credential-store write policy: a desktop backend seals through the
      // OS broker (iv = "os:v1"); without the broker env the existing v1
      // application cipher applies. A configured-but-unavailable broker
      // throws CredentialStoreError — there is no downgrade path.
      const result = await sealApiKeySecret(parsed.key);
      encryptedKey = result.encryptedKey;
      iv = result.iv;
      last4 = getLast4(parsed.key);
    } else {
      // Non-sensitive values stored as plaintext
      encryptedKey = parsed.key;
      iv = "";
      last4 = parsed.key;
    }

    const apiKey = await db.apiKey.upsert({
      where: {
        userId_provider: {
          userId: user.id,
          provider: parsed.provider,
        },
      },
      create: {
        userId: user.id,
        provider: parsed.provider,
        encryptedKey,
        iv,
        last4,
        label: parsed.label,
      },
      update: {
        encryptedKey,
        iv,
        last4,
        label: parsed.label,
      },
      select: {
        id: true,
        provider: true,
        last4: true,
        label: true,
        createdAt: true,
        lastUsedAt: true,
      },
    });

    // Keep the provider's BYOK AIConnection bound to the saved row —
    // saves rebind credentialRef and flip the connection to CONNECTED.
    await upsertByokConnectionForApiKey({ userId: user.id, apiKey });

    const response: ApiKeyClientResponse = {
      ...apiKey,
      provider: apiKey.provider as ApiKeyProvider,
      protection: isSensitive ? (isOsEnvelopeIv(iv) ? "os" : "app") : "none",
    };
    if (!isSensitive) {
      response.displayValue = parsed.key;
    }

    return { success: true, data: response };
  } catch (error) {
    if (error instanceof CredentialStoreError) {
      // Fail closed and machine-readable — the UI maps the code, and no
      // key material or internals ever enter the message.
      return { success: false, code: error.code, message: error.message };
    }
    return handleError(error, "Failed to save API key") as {
      success: boolean;
      message: string;
    };
  }
}

export async function deleteApiKey(provider: string): Promise<{
  success: boolean;
  message?: string;
}> {
  try {
    const user = await requireUser();

    await db.apiKey.deleteMany({
      where: { userId: user.id, provider },
    });

    // The BYOK connection degrades to DISCONNECTED — assignments pinned
    // to it fail explicitly rather than resolving a stale credential.
    await markByokConnectionDisconnected({ userId: user.id, provider });

    return { success: true };
  } catch (error) {
    return handleError(error, "Failed to delete API key") as {
      success: boolean;
      message: string;
    };
  }
}

export async function getDefaultOllamaBaseUrl(): Promise<string> {
  return process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
}

// userId is optional and only needed for callers with no request-scoped
// session (e.g. the cron scheduler running a background automation) — it
// bypasses getCurrentUser(), which requires an active session and always
// resolves to null outside a request context.
export async function getOllamaBaseUrl(userId?: string): Promise<string> {
  try {
    const resolvedUserId = userId ?? (await getCurrentUser())?.id;
    if (resolvedUserId) {
      const apiKey = await db.apiKey.findUnique({
        where: {
          userId_provider: { userId: resolvedUserId, provider: "ollama" },
        },
      });
      if (apiKey) {
        return await resolveApiKeySecret(apiKey);
      }
    }
  } catch {
    // Fall through to defaults
  }
  return process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434";
}

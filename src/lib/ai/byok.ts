/**
 * BYOK (Custom API Key) ↔ AIConnection bridge.
 *
 * An explicit BYOK connection is an AIConnection row with
 *   provider:     BYOK_API_KEY_PROVIDERS key (e.g. DEEPSEEK)
 *   backendKind:  LOCAL_BYOK
 *   authType:     API_KEY
 *   credentialRef: the bound ApiKey row id — never key material
 *   runtimeProfileRef / accountIdentity: null (no runtime, no account)
 *
 * Lifecycle is owned here (server-side, like managed-bootstrap): saving an
 * ApiKey upserts its connection to CONNECTED, deleting the key flips it to
 * DISCONNECTED, and listing self-heals — historical ApiKey rows gain a
 * connection on first read so pre-bridge data stays usable without a
 * schema migration.
 *
 * Execution never reaches the desktop runtime: LOCAL_BYOK cannot mint a
 * ticket, and the execution seam branches to the AI SDK in-process.
 */
import "server-only";

import prisma from "@/lib/db";
import {
  resolveApiKeySecret,
  type CredentialStoreDeps,
} from "@/lib/ai/credential-store";
import {
  AI_BUSINESS_ERROR_CODES,
  AIBusinessError,
  BYOK_BACKEND_KIND,
  apiKeyProviderToByokProvider,
  byokApiKeyProviderFor,
  type ByokConnectionProvider,
} from "@/lib/ai/connections";
import type { PrismaClient } from "@prisma/client";

type DbClient = Pick<PrismaClient, "aIConnection" | "apiKey">;

export const BYOK_DISPLAY_NAMES: Record<ByokConnectionProvider, string> = {
  OPENAI: "OpenAI (API key)",
  DEEPSEEK: "DeepSeek (API key)",
  OPENROUTER: "OpenRouter (API key)",
  GEMINI: "Google Gemini (API key)",
  OLLAMA: "Ollama (base URL)",
};

const BYOK_CONNECTION_WHERE = {
  backendKind: BYOK_BACKEND_KIND,
  authType: "API_KEY",
} as const;

/**
 * Called after an ApiKey row is saved. Rebinds the provider's BYOK
 * connection to the (possibly rewritten) row and marks it CONNECTED —
 * a previously archived or disconnected projection revives because the
 * user's intent is to use this key again.
 */
export async function upsertByokConnectionForApiKey(
  {
    userId,
    apiKey,
  }: { userId: string; apiKey: { id: string; provider: string } },
  dbClient: DbClient = prisma,
): Promise<void> {
  const provider = apiKeyProviderToByokProvider(apiKey.provider);
  if (!provider) return;
  const displayName = BYOK_DISPLAY_NAMES[provider];
  const existing = await dbClient.aIConnection.findFirst({
    where: { userId, provider, ...BYOK_CONNECTION_WHERE },
  });
  if (existing) {
    await dbClient.aIConnection.update({
      where: { id: existing.id },
      data: {
        credentialRef: apiKey.id,
        status: "CONNECTED",
        archivedAt: null,
        runtimeProfileRef: null,
        accountIdentity: null,
        providerMetadata: null,
        lastVerifiedAt: new Date(),
      },
    });
    return;
  }
  await dbClient.aIConnection.create({
    data: {
      userId,
      provider,
      ...BYOK_CONNECTION_WHERE,
      displayName,
      status: "CONNECTED",
      credentialRef: apiKey.id,
      runtimeProfileRef: null,
      accountIdentity: null,
      providerMetadata: null,
      lastVerifiedAt: new Date(),
    },
  });
}

/**
 * Called after an ApiKey row is deleted. The connection survives as
 * DISCONNECTED — assignments pinned to it fail explicitly
 * (CONNECTION_DISCONNECTED at resolve, never a silent credential swap),
 * and the row keeps its audit trail.
 */
export async function markByokConnectionDisconnected(
  { userId, provider }: { userId: string; provider: string },
  dbClient: DbClient = prisma,
): Promise<void> {
  const byokProvider = apiKeyProviderToByokProvider(provider);
  if (!byokProvider) return;
  await dbClient.aIConnection.updateMany({
    where: {
      userId,
      provider: byokProvider,
      ...BYOK_CONNECTION_WHERE,
      archivedAt: null,
    },
    data: { status: "DISCONNECTED" },
  });
}

/**
 * Explicit-verify/migration-check paths only: flip a CONNECTED BYOK
 * connection to REAUTH_REQUIRED when its bound credential provably cannot
 * be read in this OS context (foreign user/machine, corrupt blob, or an
 * unrestorable migration). Read and execution paths never call this —
 * they fail with BYOK_CREDENTIAL_UNAVAILABLE without mutating state.
 */
export async function markByokConnectionReauthRequired(
  { userId, provider }: { userId: string; provider: string },
  dbClient: DbClient = prisma,
): Promise<void> {
  const byokProvider = apiKeyProviderToByokProvider(provider);
  if (!byokProvider) return;
  await dbClient.aIConnection.updateMany({
    where: {
      userId,
      provider: byokProvider,
      ...BYOK_CONNECTION_WHERE,
      archivedAt: null,
      status: "CONNECTED",
    },
    data: { status: "REAUTH_REQUIRED" },
  });
}

/**
 * Reconciles BYOK connections with the ApiKey table — runs on read paths
 * so pre-bridge ApiKey rows become assignable connections and orphaned
 * projections (key deleted outside the action) degrade to DISCONNECTED.
 */
export async function ensureByokConnectionsForUser(
  userId: string,
  dbClient: DbClient = prisma,
): Promise<void> {
  const [keys, connections] = await Promise.all([
    dbClient.apiKey.findMany({
      where: { userId },
      select: { id: true, provider: true },
    }),
    dbClient.aIConnection.findMany({
      where: { userId, ...BYOK_CONNECTION_WHERE },
      select: {
        id: true,
        provider: true,
        credentialRef: true,
        status: true,
        archivedAt: true,
      },
    }),
  ]);
  const keyByProvider = new Map<string, { id: string }>();
  for (const key of keys) {
    if (apiKeyProviderToByokProvider(key.provider)) {
      keyByProvider.set(key.provider, { id: key.id });
    }
  }
  for (const key of keys) {
    const provider = apiKeyProviderToByokProvider(key.provider);
    if (!provider) continue;
    const existing = connections.find((row) => row.provider === provider);
    if (!existing) {
      await dbClient.aIConnection.create({
        data: {
          userId,
          provider,
          ...BYOK_CONNECTION_WHERE,
          displayName: BYOK_DISPLAY_NAMES[provider],
          status: "CONNECTED",
          credentialRef: key.id,
          runtimeProfileRef: null,
          accountIdentity: null,
          providerMetadata: null,
          lastVerifiedAt: new Date(),
        },
      });
      continue;
    }
    if (
      existing.archivedAt === null &&
      existing.credentialRef === key.id &&
      existing.status === "CONNECTED"
    ) {
      continue;
    }
    await dbClient.aIConnection.update({
      where: { id: existing.id },
      data: {
        credentialRef: key.id,
        status: "CONNECTED",
        archivedAt: null,
        lastVerifiedAt: new Date(),
      },
    });
  }
  for (const connection of connections) {
    const apiKeyProvider = byokApiKeyProviderFor(connection.provider);
    const key = apiKeyProvider
      ? keyByProvider.get(apiKeyProvider)
      : undefined;
    if (!key && connection.archivedAt === null && connection.status !== "DISCONNECTED") {
      await dbClient.aIConnection.update({
        where: { id: connection.id },
        data: { status: "DISCONNECTED" },
      });
    }
  }
}

/**
 * Strict credential resolution for an explicit BYOK connection: the bound
 * ApiKey row, owner- and provider-checked, decrypted in place. Deliberately
 * NOT the legacy resolver — no env-var fallback, no default credential; an
 * explicit connection can never silently substitute another credential.
 */
export async function resolveByokCredential(
  {
    userId,
    connection,
  }: {
    userId: string;
    connection: {
      credentialRef: string | null;
      provider: string;
    };
  },
  dbClient: Pick<PrismaClient, "apiKey"> = prisma,
  storeDeps?: CredentialStoreDeps,
): Promise<string> {
  const apiKeyProvider = byokApiKeyProviderFor(connection.provider);
  const unavailable = () =>
    new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.BYOK_CREDENTIAL_UNAVAILABLE,
      "The API key bound to this connection is not available",
    );
  if (!apiKeyProvider || !connection.credentialRef) throw unavailable();
  let row: { encryptedKey: string; iv: string } | null = null;
  try {
    row = await dbClient.apiKey.findFirst({
      where: {
        id: connection.credentialRef,
        userId,
        provider: apiKeyProvider,
      },
      select: { id: true, encryptedKey: true, iv: true },
    });
  } catch {
    throw unavailable();
  }
  if (!row) throw unavailable();
  dbClient.apiKey
    .update({ where: { id: connection.credentialRef }, data: { lastUsedAt: new Date() } })
    .catch(() => {});
  try {
    // Format dispatch lives in the credential store: plaintext passthrough,
    // os:v1 broker unseal, or the v1/legacy application cipher. Any failure
    // — broker down, foreign OS context, undecryptable ciphertext — maps to
    // the same explicit BYOK_CREDENTIAL_UNAVAILABLE. No fallback, ever.
    return await resolveApiKeySecret(row, storeDeps);
  } catch {
    throw unavailable();
  }
}

/** The display name a BYOK connection carries in pickers — safe metadata only. */
export function byokConnectionDisplayName(provider: string): string | null {
  const byokProvider = apiKeyProviderToByokProvider(provider);
  return byokProvider ? BYOK_DISPLAY_NAMES[byokProvider] : null;
}

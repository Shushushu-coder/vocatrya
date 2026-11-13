import "server-only";

import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import {
  CREDENTIAL_STORE_ERROR_CODES,
  CredentialStoreError,
  resolveApiKeySecret,
  sealApiKeySecret,
} from "@/lib/ai/credential-store";
import { NOTION_ERROR, NotionError } from "./errors";

type Db = Pick<PrismaClient, "notionConnection">;

export type NotionConnectionRow = Awaited<
  ReturnType<Db["notionConnection"]["findUnique"]>
> & object;

export const NOTION_STATUS = {
  CONNECTED: "CONNECTED",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
  DISCONNECTED: "DISCONNECTED",
} as const;
export type NotionStatus = keyof typeof NOTION_STATUS;

/** What the sealed credential envelope carries — never persisted in clear. */
export type NotionTokenBundle = {
  v: 1;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scope?: string;
  clientId: string;
  clientSecret?: string;
};

/** In-flight OAuth flow, sealed between the authorize redirect and callback. */
export type NotionPendingFlow = {
  v: 1;
  state: string;
  codeVerifier: string;
  redirectUri: string;
  appOrigin: string;
  expiresAt: number;
  clientSecret?: string;
};

export async function getNotionConnection(
  userId: string,
  db: Db = prisma,
): Promise<NotionConnectionRow | null> {
  return db.notionConnection.findUnique({ where: { userId } });
}

export async function getNotionConnectionByStateHash(
  stateHash: string,
  db: Db = prisma,
): Promise<NotionConnectionRow | null> {
  return db.notionConnection.findFirst({
    where: { pendingStateHash: stateHash },
  });
}

export async function upsertNotionConnection(
  userId: string,
  data: Record<string, unknown>,
  db: Db = prisma,
): Promise<NotionConnectionRow> {
  return db.notionConnection.upsert({
    where: { userId },
    create: { userId, ...data },
    update: data,
  });
}

export async function savePendingFlow(
  userId: string,
  flow: NotionPendingFlow,
  stateHash: string,
  db: Db = prisma,
): Promise<void> {
  const sealed = await sealApiKeySecret(JSON.stringify(flow));
  await upsertNotionConnection(
    userId,
    {
      pendingCipher: sealed.encryptedKey,
      pendingIv: sealed.iv,
      pendingStateHash: stateHash,
      lastError: null,
    },
    db,
  );
}

export async function loadPendingFlow(
  row: Pick<
    NotionConnectionRow,
    "pendingCipher" | "pendingIv" | "pendingStateHash"
  >,
): Promise<NotionPendingFlow | null> {
  if (!row.pendingCipher || !row.pendingIv) return null;
  try {
    const plaintext = await resolveApiKeySecret({
      encryptedKey: row.pendingCipher,
      iv: row.pendingIv,
    });
    const flow = JSON.parse(plaintext) as NotionPendingFlow;
    return flow?.v === 1 ? flow : null;
  } catch {
    // A pending flow that cannot be unsealed is treated as absent — the
    // connection was never established on this install.
    return null;
  }
}

export async function clearPendingFlow(
  userId: string,
  db: Db = prisma,
): Promise<void> {
  await db.notionConnection.updateMany({
    where: { userId },
    data: { pendingCipher: null, pendingIv: null, pendingStateHash: null },
  });
}

export async function saveTokenBundle(
  userId: string,
  bundle: NotionTokenBundle,
  db: Db = prisma,
): Promise<void> {
  const sealed = await sealApiKeySecret(JSON.stringify(bundle));
  await db.notionConnection.updateMany({
    where: { userId },
    data: {
      encryptedCredential: sealed.encryptedKey,
      credentialIv: sealed.iv,
    },
  });
}

export async function loadTokenBundle(
  row: Pick<NotionConnectionRow, "encryptedCredential" | "credentialIv">,
): Promise<NotionTokenBundle | null> {
  if (!row.encryptedCredential || !row.credentialIv) return null;
  try {
    const plaintext = await resolveApiKeySecret({
      encryptedKey: row.encryptedCredential,
      iv: row.credentialIv,
    });
    const bundle = JSON.parse(plaintext) as NotionTokenBundle;
    return bundle?.v === 1 && typeof bundle.accessToken === "string"
      ? bundle
      : null;
  } catch (error) {
    // Store unavailability is transient and keeps the row CONNECTED for the
    // UI; a decrypt failure means the credential is permanently unreadable
    // on this install and must be re-authorized.
    const code =
      error instanceof CredentialStoreError &&
      error.code === CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE
        ? NOTION_ERROR.CREDENTIAL_UNAVAILABLE
        : NOTION_ERROR.REAUTH_REQUIRED;
    throw new NotionError(code);
  }
}

export type CachedRemoteTool = { name: string; inputSchema?: unknown };

/**
 * availableTools stores the last verified tools/list as a JSON array of
 * {name, inputSchema} — the schemas drive capability detection and the
 * remote-argument shape at call time. Legacy rows storing bare name strings
 * still parse (inputSchema just reads undefined).
 */
export function parseAvailableTools(raw: string | null | undefined): string[] {
  return parseAvailableToolSchemas(raw).map((tool) => tool.name);
}

export function parseAvailableToolSchemas(
  raw: string | null | undefined,
): CachedRemoteTool[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item): CachedRemoteTool | null =>
        typeof item === "string"
          ? { name: item }
          : item && typeof item === "object" && typeof item.name === "string"
            ? { name: item.name, inputSchema: item.inputSchema }
            : null,
      )
      .filter((item): item is CachedRemoteTool => item !== null);
  } catch {
    return [];
  }
}

export function findRemoteToolSchema(
  row: Pick<NotionConnectionRow, "availableTools">,
  remoteName: string,
): unknown {
  return parseAvailableToolSchemas(row.availableTools).find(
    (tool) => tool.name === remoteName,
  )?.inputSchema;
}

import "server-only";

import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import {
  CREDENTIAL_STORE_ERROR_CODES,
  CredentialStoreError,
  resolveApiKeySecret,
  sealApiKeySecret,
} from "@/lib/ai/credential-store";
import { FEISHU_ERROR, FeishuError } from "./errors";

type Db = Pick<PrismaClient, "feishuConnection">;

export type FeishuConnectionRow = Awaited<
  ReturnType<Db["feishuConnection"]["findUnique"]>
> & object;

export const FEISHU_STATUS = {
  CONNECTED: "CONNECTED",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
  DISCONNECTED: "DISCONNECTED",
} as const;
export type FeishuStatus = keyof typeof FEISHU_STATUS;

/** What the sealed credential envelope carries — never persisted in clear. */
export type FeishuCredentialBundle = {
  v: 1;
  appId: string;
  appSecret: string;
};

export async function getFeishuConnection(
  userId: string,
  db: Db = prisma,
): Promise<FeishuConnectionRow | null> {
  return db.feishuConnection.findUnique({ where: { userId } });
}

export async function upsertFeishuConnection(
  userId: string,
  data: Record<string, unknown>,
  db: Db = prisma,
): Promise<FeishuConnectionRow> {
  return db.feishuConnection.upsert({
    where: { userId },
    create: { userId, ...data, ...(typeof data.revision === "object" ? { revision: 1 } : {}) },
    update: data,
  });
}

export async function saveCredentialBundle(
  userId: string,
  bundle: FeishuCredentialBundle,
  db: Db = prisma,
): Promise<void> {
  const sealed = await sealApiKeySecret(JSON.stringify(bundle));
  await db.feishuConnection.updateMany({
    where: { userId },
    data: {
      encryptedCredential: sealed.encryptedKey,
      credentialIv: sealed.iv,
    },
  });
}

export async function loadCredentialBundle(
  row: Pick<FeishuConnectionRow, "encryptedCredential" | "credentialIv">,
): Promise<FeishuCredentialBundle | null> {
  if (!row.encryptedCredential || !row.credentialIv) return null;
  try {
    const plaintext = await resolveApiKeySecret({
      encryptedKey: row.encryptedCredential,
      iv: row.credentialIv,
    });
    const bundle = JSON.parse(plaintext) as FeishuCredentialBundle;
    return bundle?.v === 1 &&
      typeof bundle.appId === "string" &&
      typeof bundle.appSecret === "string"
      ? bundle
      : null;
  } catch (error) {
    // Store unavailability is transient and keeps the row CONNECTED for the
    // UI; a decrypt failure means the credential is permanently unreadable
    // on this install and must be re-entered.
    const code =
      error instanceof CredentialStoreError &&
      error.code === CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE
        ? FEISHU_ERROR.CREDENTIAL_UNAVAILABLE
        : FEISHU_ERROR.REAUTH_REQUIRED;
    throw new FeishuError(code);
  }
}

export function parseAvailableCapabilities(
  raw: string | null | undefined,
): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

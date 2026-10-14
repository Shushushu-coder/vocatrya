"use server";

/**
 * BYOK credential storage actions — status, explicit OS-envelope
 * migration, and explicit credential verification. None of these run on
 * any implicit read path: listing, resolving, and execution never touch
 * migration or status writes.
 */
import db from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import {
  CREDENTIAL_STORE_ERROR_CODES,
  CredentialStoreError,
  credentialStoreStatus,
  isCipherKeyUnavailableError,
  isOsEnvelopeIv,
  resolveApiKeySecret,
} from "@/lib/ai/credential-store";
import { markByokConnectionReauthRequired } from "@/lib/ai/byok";
import {
  migrateByokCredentialsForUser,
  type CredentialMigrationSummary,
} from "@/lib/ai/credential-migration";

export async function getByokCredentialStorageStatus(): Promise<{
  success: boolean;
  data?: {
    mode: "os-backed" | "app-cipher";
    available: boolean;
    backend: string | null;
    osProtected: number;
    appCipher: number;
    plaintext: number;
  };
  message?: string;
}> {
  try {
    const user = await requireUser();
    const [store, rows] = await Promise.all([
      credentialStoreStatus(),
      db.apiKey.findMany({
        where: { userId: user.id },
        select: { iv: true },
      }),
    ]);
    let osProtected = 0;
    let appCipher = 0;
    let plaintext = 0;
    for (const row of rows) {
      if (row.iv === "") plaintext += 1;
      else if (isOsEnvelopeIv(row.iv)) osProtected += 1;
      else appCipher += 1;
    }
    return {
      success: true,
      data: { ...store, osProtected, appCipher, plaintext },
    };
  } catch (error) {
    return handleError(error, "Failed to read credential storage status") as {
      success: boolean;
      message: string;
    };
  }
}

/**
 * Explicit user-triggered migration of the caller's legacy-format keys
 * into the Windows OS envelope. Idempotent and non-destructive: rows that
 * cannot be upgraded stay exactly as they were and are reported in the
 * summary. Never runs implicitly from any read path.
 */
export async function migrateByokCredentialsToOsStore(): Promise<{
  success: boolean;
  data?: CredentialMigrationSummary;
  message?: string;
}> {
  try {
    const user = await requireUser();
    const summary = await migrateByokCredentialsForUser(user.id);
    return { success: true, data: summary };
  } catch (error) {
    return handleError(error, "Failed to upgrade credential storage") as {
      success: boolean;
      message: string;
    };
  }
}

/**
 * Explicit health check over the caller's sensitive keys. A key that
 * provably cannot be read in this OS context (foreign user/machine,
 * corrupt blob) marks its BYOK connection REAUTH_REQUIRED — the honest
 * state, since only re-entering the key recovers it. A transient store
 * outage reports "unavailable" without touching connection state.
 */
export async function verifyByokCredentials(): Promise<{
  success: boolean;
  data?: Array<{
    provider: string;
    status: "ok" | "reauth_required" | "unavailable";
  }>;
  message?: string;
}> {
  try {
    const user = await requireUser();
    const rows = await db.apiKey.findMany({
      where: { userId: user.id },
      select: { provider: true, encryptedKey: true, iv: true },
    });
    const results: Array<{
      provider: string;
      status: "ok" | "reauth_required" | "unavailable";
    }> = [];
    for (const row of rows) {
      if (row.iv === "") continue; // non-sensitive passthrough — nothing to verify
      try {
        await resolveApiKeySecret(row);
        results.push({ provider: row.provider, status: "ok" });
      } catch (error) {
        const transient =
          (error instanceof CredentialStoreError &&
            error.code === CREDENTIAL_STORE_ERROR_CODES.CREDENTIAL_STORE_UNAVAILABLE) ||
          isCipherKeyUnavailableError(error);
        if (transient) {
          results.push({ provider: row.provider, status: "unavailable" });
        } else {
          await markByokConnectionReauthRequired({
            userId: user.id,
            provider: row.provider,
          });
          results.push({ provider: row.provider, status: "reauth_required" });
        }
      }
    }
    return { success: true, data: results };
  } catch (error) {
    return handleError(error, "Failed to verify credentials") as {
      success: boolean;
      message: string;
    };
  }
}

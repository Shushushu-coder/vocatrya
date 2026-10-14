/**
 * Explicit BYOK credential migration to the OS envelope (design §5).
 *
 * This is a MAINTENANCE task, never a read-path side effect: it only runs
 * when invoked (the Settings → BYOK "upgrade" action). Each ApiKey row
 * migrates independently and atomically:
 *
 *   1. fresh re-read of the row
 *   2. decrypt via the existing format (v1 per-record salt / LEGACY_SALT)
 *   3. seal through the desktop credential broker
 *   4. unseal round-trip must reproduce the plaintext BEFORE any write
 *   5. journal entry — the durable recovery record holding BOTH the old
 *      and new ciphertext (never plaintext), so a crash after the CAS
 *      write can still restore the pre-migration value without relying
 *      on in-process memory
 *   6. single-row CAS update (id + old ciphertext + old iv) — a
 *      concurrent save/delete makes it a no-op, never a clobber
 *   7. post-write re-read + resolve must reproduce the plaintext;
 *      on failure the journal restores the old ciphertext (same CAS),
 *      and only a failed restore marks the BYOK connection
 *      REAUTH_REQUIRED — a broken row must never sit behind CONNECTED
 *
 * Crash safety: interrupt anywhere before step 6 and the row is
 * untouched; interrupt after it and the row is a complete, verified
 * os:v1 value. Re-running is idempotent — os:* and plaintext rows are
 * skipped.
 */
import "server-only";

import fs from "node:fs";
import path from "node:path";

import prisma from "@/lib/db";
import {
  OS_ENVELOPE_IV,
  credentialNeedsOsMigration,
  isCipherKeyUnavailableError,
  isOsEnvelopeIv,
  resolveApiKeySecret,
  sealApiKeySecret,
  type CredentialStoreDeps,
} from "@/lib/ai/credential-store";
import { markByokConnectionReauthRequired } from "@/lib/ai/byok";
import type { PrismaClient } from "@prisma/client";

type DbClient = Pick<PrismaClient, "apiKey" | "aIConnection">;

export const CREDENTIAL_MIGRATION_REASON_CODES = {
  DECRYPT_LEGACY_FAILED: "DECRYPT_LEGACY_FAILED",
  STORE_UNAVAILABLE: "STORE_UNAVAILABLE",
  ROUNDTRIP_MISMATCH: "ROUNDTRIP_MISMATCH",
  WRITE_CONFLICT: "WRITE_CONFLICT",
  // Post-write verification failed; the row was restored to its prior
  // ciphertext (verified) — migration did not take, nothing is broken.
  VERIFY_FAILED: "VERIFY_FAILED",
  // Post-write verification failed AND the journal restore could not
  // land — the row holds an unverified os blob and the connection was
  // marked REAUTH_REQUIRED instead of pretending it still works.
  RESTORE_FAILED: "RESTORE_FAILED",
} as const;
export type CredentialMigrationReasonCode =
  (typeof CREDENTIAL_MIGRATION_REASON_CODES)[keyof typeof CREDENTIAL_MIGRATION_REASON_CODES];

export interface CredentialMigrationSummary {
  migrated: Array<{ apiKeyId: string; provider: string }>;
  skipped: Array<{ apiKeyId: string; provider: string; reason: string }>;
  failed: Array<{
    apiKeyId: string;
    provider: string;
    reasonCode: CredentialMigrationReasonCode;
  }>;
}

/** Durable per-row recovery record — ciphertext only, never plaintext. */
export interface CredentialMigrationJournalEntry {
  apiKeyId: string;
  userId: string;
  provider: string;
  previousIv: string;
  previousEncryptedKey: string;
  migratedIv: string;
  migratedEncryptedKey: string;
  recordedAt: string;
}

export interface CredentialMigrationJournal {
  readonly path: string;
  record(entry: CredentialMigrationJournalEntry): void;
  entries(): CredentialMigrationJournalEntry[];
  latest(apiKeyId: string): CredentialMigrationJournalEntry | null;
}

function isJournalEntry(value: unknown): value is CredentialMigrationJournalEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.apiKeyId === "string" &&
    typeof v.userId === "string" &&
    typeof v.provider === "string" &&
    typeof v.previousIv === "string" &&
    typeof v.previousEncryptedKey === "string" &&
    typeof v.migratedIv === "string" &&
    typeof v.migratedEncryptedKey === "string" &&
    typeof v.recordedAt === "string"
  );
}

const JOURNAL_FILE_NAME = "credential-migration-recovery.jsonl";

/**
 * One shared JSONL journal per data directory — next to the SQLite
 * database (same filesystem ACL boundary as the DB it protects). Entries
 * hold the ciphertext before AND after the CAS write; plaintext never
 * lands here. A single append-only file across runs keeps the ops-level
 * restore path working without knowing which run wrote a given row.
 */
export function createCredentialMigrationJournal(
  directory: string,
): CredentialMigrationJournal {
  const filePath = path.join(directory, JOURNAL_FILE_NAME);
  let cached: CredentialMigrationJournalEntry[] | null = null;
  const entries = (): CredentialMigrationJournalEntry[] => {
    if (cached) return cached;
    let lines: string[] = [];
    try {
      lines = fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0);
    } catch {
      lines = [];
    }
    const parsed: CredentialMigrationJournalEntry[] = [];
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as unknown;
        if (isJournalEntry(value)) parsed.push(value);
      } catch {
        // A torn tail line (crash mid-append) is skipped, not fatal.
      }
    }
    cached = parsed;
    return parsed;
  };
  return {
    path: filePath,
    record(entry) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", {
        encoding: "utf8",
        mode: 0o600,
      });
      cached = null;
    },
    entries,
    latest(apiKeyId) {
      const matches = entries().filter((entry) => entry.apiKeyId === apiKeyId);
      return matches.length > 0 ? matches[matches.length - 1] : null;
    },
  };
}

/** Journal lives beside the SQLite file the backend is bound to. */
export function defaultCredentialMigrationJournalDir(
  env: Record<string, string | undefined> = process.env,
): string {
  const url = env.DATABASE_URL ?? "";
  if (url.startsWith("file:")) {
    const dbPath = path.resolve(url.slice("file:".length).split("?")[0]);
    return path.join(path.dirname(dbPath), "credential-migration");
  }
  return path.join(process.cwd(), "data", "credential-migration");
}

export interface MigrateByokCredentialDeps {
  db?: DbClient;
  store?: CredentialStoreDeps;
  journal?: CredentialMigrationJournal;
  journalDir?: string;
  /** Test seam — runs after the journal record, before the CAS write. */
  beforeCasWrite?: (rowId: string) => void | Promise<void>;
  /** Test seam — runs after the CAS write, before post-write verify. */
  afterCasWrite?: (rowId: string) => void | Promise<void>;
}

/**
 * Restore a row to the ciphertext recorded in the journal — but only
 * while the row still holds exactly the migrated value this run wrote.
 * A later user save wins the CAS and is never clobbered.
 */
async function restoreFromJournal(
  journal: CredentialMigrationJournal,
  rowId: string,
  db: DbClient,
): Promise<"restored" | "no-entry" | "conflict"> {
  const entry = journal.latest(rowId);
  if (!entry) return "no-entry";
  const result = await db.apiKey.updateMany({
    where: {
      id: rowId,
      encryptedKey: entry.migratedEncryptedKey,
      iv: entry.migratedIv,
    },
    data: {
      encryptedKey: entry.previousEncryptedKey,
      iv: entry.previousIv,
    },
  });
  return result.count === 1 ? "restored" : "conflict";
}

/**
 * Ops-level recovery: re-apply a journaled pre-migration ciphertext for a
 * row that still carries the migrated value. Idempotent and CAS-bounded;
 * returns the outcome so callers can decide on re-verification.
 */
export async function restoreCredentialRowFromJournal(
  apiKeyId: string,
  deps: MigrateByokCredentialDeps = {},
): Promise<"restored" | "no-entry" | "conflict"> {
  const db = deps.db ?? prisma;
  const journal =
    deps.journal ??
    createCredentialMigrationJournal(
      deps.journalDir ?? defaultCredentialMigrationJournalDir(),
    );
  return restoreFromJournal(journal, apiKeyId, db);
}

async function resolvesTo(
  row: { encryptedKey: string; iv: string },
  expected: string,
  store: CredentialStoreDeps | undefined,
): Promise<boolean> {
  try {
    return (await resolveApiKeySecret(row, store)) === expected;
  } catch {
    return false;
  }
}

async function migrateCredentialRow(
  rowId: string,
  ctx: {
    db: DbClient;
    store: CredentialStoreDeps | undefined;
    journal: CredentialMigrationJournal;
    beforeCasWrite?: MigrateByokCredentialDeps["beforeCasWrite"];
    afterCasWrite?: MigrateByokCredentialDeps["afterCasWrite"];
    summary: CredentialMigrationSummary;
  },
): Promise<void> {
  const { db, summary } = ctx;
  const skip = (row: { id: string; provider: string }, reason: string) => {
    summary.skipped.push({ apiKeyId: row.id, provider: row.provider, reason });
  };
  const fail = (
    row: { id: string; provider: string },
    reasonCode: CredentialMigrationReasonCode,
  ) => {
    summary.failed.push({ apiKeyId: row.id, provider: row.provider, reasonCode });
  };

  const row = await db.apiKey.findUnique({
    where: { id: rowId },
    select: {
      id: true,
      userId: true,
      provider: true,
      encryptedKey: true,
      iv: true,
    },
  });
  if (!row) return;
  if (row.iv === "") return skip(row, "non-sensitive");
  if (isOsEnvelopeIv(row.iv)) return skip(row, "already-os-envelope");

  let plaintext: string;
  try {
    plaintext = await resolveApiKeySecret(row, ctx.store);
  } catch (error) {
    // A missing ENCRYPTION_KEY is an environment outage (desktop secret
    // unreadable / misconfigured env), not a corrupt credential — report
    // it as store-unavailable so ops sees the real failure class.
    return fail(
      row,
      isCipherKeyUnavailableError(error)
        ? CREDENTIAL_MIGRATION_REASON_CODES.STORE_UNAVAILABLE
        : CREDENTIAL_MIGRATION_REASON_CODES.DECRYPT_LEGACY_FAILED,
    );
  }

  let sealed: { encryptedKey: string; iv: string };
  try {
    sealed = await sealApiKeySecret(plaintext, ctx.store);
    if (sealed.iv !== OS_ENVELOPE_IV) {
      // No desktop broker → seal produced the application cipher, which is
      // not an upgrade. Report store-unavailable rather than rewriting a
      // v1 row with a v1 row.
      return fail(row, CREDENTIAL_MIGRATION_REASON_CODES.STORE_UNAVAILABLE);
    }
  } catch {
    return fail(row, CREDENTIAL_MIGRATION_REASON_CODES.STORE_UNAVAILABLE);
  }

  // Pre-write verification: the envelope must read back the exact secret
  // before the old ciphertext is allowed to go anywhere.
  if (!(await resolvesTo({ encryptedKey: sealed.encryptedKey, iv: sealed.iv }, plaintext, ctx.store))) {
    return fail(row, CREDENTIAL_MIGRATION_REASON_CODES.ROUNDTRIP_MISMATCH);
  }

  ctx.journal.record({
    apiKeyId: row.id,
    userId: row.userId,
    provider: row.provider,
    previousIv: row.iv,
    previousEncryptedKey: row.encryptedKey,
    migratedIv: sealed.iv,
    migratedEncryptedKey: sealed.encryptedKey,
    recordedAt: new Date().toISOString(),
  });

  await ctx.beforeCasWrite?.(row.id);

  // Single-row CAS: matches only while encryptedKey+iv are still exactly
  // the values we decrypted — a concurrent save or delete wins and the
  // migration steps aside instead of overwriting it.
  const cas = await db.apiKey.updateMany({
    where: {
      id: row.id,
      encryptedKey: row.encryptedKey,
      iv: row.iv,
    },
    data: { encryptedKey: sealed.encryptedKey, iv: sealed.iv },
  });
  if (cas.count !== 1) {
    return fail(row, CREDENTIAL_MIGRATION_REASON_CODES.WRITE_CONFLICT);
  }

  await ctx.afterCasWrite?.(row.id);

  const after = await db.apiKey.findUnique({
    where: { id: row.id },
    select: { encryptedKey: true, iv: true },
  });
  if (!after) return skip(row, "row-gone");
  if (after.iv !== sealed.iv || after.encryptedKey !== sealed.encryptedKey) {
    // A later write superseded ours between CAS and re-read — that newer
    // value is authoritative; nothing to restore.
    return skip(row, "concurrent-update");
  }
  if (await resolvesTo(after, plaintext, ctx.store)) {
    summary.migrated.push({ apiKeyId: row.id, provider: row.provider });
    return;
  }

  // The write landed but post-write verification failed — put the
  // journaled pre-migration ciphertext back (CAS-bounded), then prove the
  // restored row is readable again.
  const restore = await restoreFromJournal(ctx.journal, row.id, db);
  if (restore === "restored") {
    const reread = await db.apiKey.findUnique({
      where: { id: row.id },
      select: { encryptedKey: true, iv: true },
    });
    if (reread && (await resolvesTo(reread, plaintext, ctx.store))) {
      return fail(row, CREDENTIAL_MIGRATION_REASON_CODES.VERIFY_FAILED);
    }
  } else if (restore === "conflict") {
    // Someone else wrote between CAS and restore — their value wins; if it
    // resolves, this is a concurrent update, not a failure.
    const reread = await db.apiKey.findUnique({
      where: { id: row.id },
      select: { encryptedKey: true, iv: true },
    });
    if (reread && !(reread.iv === sealed.iv && reread.encryptedKey === sealed.encryptedKey)) {
      return skip(row, "concurrent-update");
    }
  }
  // Unrecoverable: the row holds our os blob and it does not resolve, or
  // the restore could not be verified. Never leave that behind CONNECTED.
  await markByokConnectionReauthRequired(
    { userId: row.userId, provider: row.provider },
    db,
  );
  return fail(row, CREDENTIAL_MIGRATION_REASON_CODES.RESTORE_FAILED);
}

/**
 * Migrate every legacy-format (v1 / LEGACY_SALT) sensitive ApiKey row the
 * user owns to the OS envelope. Rows already os:* and non-sensitive
 * plaintext rows are skipped. The summary carries ids and reason codes
 * only — never plaintext, never ciphertext.
 */
export async function migrateByokCredentialsForUser(
  userId: string,
  deps: MigrateByokCredentialDeps = {},
): Promise<CredentialMigrationSummary> {
  const db = deps.db ?? prisma;
  const journal =
    deps.journal ??
    createCredentialMigrationJournal(
      deps.journalDir ?? defaultCredentialMigrationJournalDir(),
    );
  const summary: CredentialMigrationSummary = {
    migrated: [],
    skipped: [],
    failed: [],
  };
  const rows = await db.apiKey.findMany({
    where: { userId },
    select: { id: true, provider: true },
    orderBy: { createdAt: "asc" },
  });
  for (const row of rows) {
    try {
      await migrateCredentialRow(row.id, {
        db,
        store: deps.store,
        journal,
        beforeCasWrite: deps.beforeCasWrite,
        afterCasWrite: deps.afterCasWrite,
        summary,
      });
    } catch {
      // An unexpected per-row fault must not abort the batch — and must
      // never carry raw error material into the summary.
      summary.failed.push({
        apiKeyId: row.id,
        provider: row.provider,
        reasonCode: CREDENTIAL_MIGRATION_REASON_CODES.STORE_UNAVAILABLE,
      });
    }
  }
  return summary;
}

export { credentialNeedsOsMigration };

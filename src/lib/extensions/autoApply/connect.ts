import "server-only";

import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { log } from "@/lib/telemetry";
import packageJson from "../../../../package.json";
import { loadAutoApplySource } from "./source";
import { buildAutoApplyExport } from "./convert";
import {
  AUTO_APPLY_EXPORTABLE_SECTIONS,
  isExportableSectionKey,
  type AutoApplySectionKey,
} from "./sections";
import type {
  AutoApplyConnectionSummary,
  AutoApplyPairedProfilePayload,
} from "./types";

export type {
  AutoApplyConnectionSummary,
  AutoApplyPairedProfilePayload,
} from "./types";

/**
 * Paired-connection layer for the auto-apply companion extension.
 *
 * Flow: the signed-in user creates a short-lived pairing code in the app;
 * the plugin (options page, user-triggered) exchanges it once for a bearer
 * token, then pulls the whitelisted profile on demand. Every secret lives
 * in storage as sha256 only — plaintext pairing codes and access tokens are
 * never persisted or logged. Revocation flips `revokedAt`; a revoked or
 * unknown token can never reach profile data again.
 */

export const AUTO_APPLY_CONNECT_CLIENT_HEADER = "x-vocatrya-client";
export const AUTO_APPLY_CONNECT_CLIENT_VALUE = "auto-apply-extension";
export const AUTO_APPLY_PAIRING_TTL_MS = 10 * 60 * 1000;
export const AUTO_APPLY_MAX_CONNECTIONS = 10;
export const AUTO_APPLY_PAIRING_SCHEME = "vocatrya-auto-apply://pair";

const PAIRING_PREFIX = "vaap";
const TOKEN_PREFIX = "vaac";

export const AUTO_APPLY_CONNECT_ERROR = {
  INVALID_REQUEST: "INVALID_REQUEST",
  PAIRING_INVALID: "PAIRING_INVALID",
  PAIRING_EXPIRED: "PAIRING_EXPIRED",
  PAIRING_CONSUMED: "PAIRING_CONSUMED",
  CONNECTION_INVALID: "CONNECTION_INVALID",
  CONNECTION_REVOKED: "CONNECTION_REVOKED",
  CONNECTION_LIMIT: "CONNECTION_LIMIT",
} as const;

export type AutoApplyConnectErrorCode =
  (typeof AUTO_APPLY_CONNECT_ERROR)[keyof typeof AUTO_APPLY_CONNECT_ERROR];

export class AutoApplyConnectError extends Error {
  readonly code: AutoApplyConnectErrorCode;
  constructor(code: AutoApplyConnectErrorCode, message: string) {
    super(message);
    this.name = "AutoApplyConnectError";
    this.code = code;
  }
}

export interface AutoApplyConnectionRow {
  id: string;
  userId: string;
  clientName: string | null;
  allowedSections: string;
  pairedAt: Date;
  lastSeenAt: Date | null;
  lastSyncAt: Date | null;
  lastProfileUpdatedAt: string | null;
  revokedAt: Date | null;
}

type Deps = { db?: PrismaClient };

function resolveDb(deps: Deps): PrismaClient {
  return deps.db ?? prisma;
}

function randomSecret(): string {
  return randomBytes(36).toString("base64url");
}

function hashSecret(kind: string, value: string): string {
  return createHash("sha256").update(`${kind}:${value}`).digest("hex");
}

function hashMatches(expected: string, kind: string, value: string): boolean {
  const actual = hashSecret(kind, value);
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function toIso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function readSectionGrant(raw: string): AutoApplySectionKey[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (key): key is AutoApplySectionKey =>
        typeof key === "string" && isExportableSectionKey(key),
    );
  } catch {
    return [];
  }
}

/** Validate a user-supplied section list for a pairing grant. */
export function parseSectionGrant(raw: unknown): AutoApplySectionKey[] {
  if (!Array.isArray(raw)) {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.INVALID_REQUEST,
      "sections must be an array",
    );
  }
  const grant = new Set<AutoApplySectionKey>();
  for (const entry of raw) {
    if (typeof entry !== "string" || !isExportableSectionKey(entry)) {
      throw new AutoApplyConnectError(
        AUTO_APPLY_CONNECT_ERROR.INVALID_REQUEST,
        `Unknown or non-exportable section: ${String(entry)}`,
      );
    }
    grant.add(entry);
  }
  if (grant.size === 0) {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.INVALID_REQUEST,
      "At least one exportable section is required",
    );
  }
  return AUTO_APPLY_EXPORTABLE_SECTIONS.filter((key) => grant.has(key));
}

function clampText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  return clean ? clean.slice(0, max) : null;
}

export function getAutoApplyAppVersion(): string {
  return (
    (process.env.VOCATRYA_APP_VERSION ?? "").trim() || packageJson.version
  );
}

/**
 * Create a one-shot pairing code bound to `userId`. The returned string
 * embeds the app origin so the plugin knows where to call — loopback ports
 * are OS-assigned, so a configured origin cannot be assumed.
 */
export async function createPairingRequest(
  userId: string,
  appOrigin: string,
  sections: readonly AutoApplySectionKey[],
  deps: Deps = {},
  now: Date = new Date(),
): Promise<{ pairingId: string; pairingString: string; expiresAt: string }> {
  const db = resolveDb(deps);
  const origin = normalizeAppOrigin(appOrigin);
  const pairingId = randomUUID();
  const secret = randomSecret();
  const code = `${PAIRING_PREFIX}.${pairingId}.${secret}`;
  const expiresAt = new Date(now.getTime() + AUTO_APPLY_PAIRING_TTL_MS);

  // Housekeeping first: finished pairings are useless forever, and an
  // abandoned flow should not accumulate rows.
  await db.autoApplyExtensionPairing.deleteMany({
    where: {
      userId,
      OR: [{ consumedAt: { not: null } }, { expiresAt: { lt: now } }],
    },
  });

  await db.autoApplyExtensionPairing.create({
    data: {
      id: pairingId,
      userId,
      secretHash: hashSecret(PAIRING_PREFIX, code),
      allowedSections: JSON.stringify(sections),
      expiresAt,
    },
  });

  const pairingString =
    `${AUTO_APPLY_PAIRING_SCHEME}?v=1` +
    `&app=${encodeURIComponent(origin)}` +
    `&code=${encodeURIComponent(code)}`;
  return { pairingId, pairingString, expiresAt: expiresAt.toISOString() };
}

function normalizeAppOrigin(raw: string): string {
  const origin = String(raw ?? "").trim();
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("bad protocol");
    }
    return url.origin;
  } catch {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.INVALID_REQUEST,
      "Invalid app origin",
    );
  }
}

/**
 * Exchange a pairing code for a long-lived access token. The code is
 * single-use and time-limited; the returned token is shown to the plugin
 * once and stored only as a hash.
 */
export async function exchangePairingCode(
  code: string,
  client: { name?: unknown; version?: unknown } = {},
  deps: Deps = {},
  now: Date = new Date(),
): Promise<{
  connectionId: string;
  accessToken: string;
  allowedSections: AutoApplySectionKey[];
  appName: "Vocatrya";
  appVersion: string;
}> {
  const db = resolveDb(deps);
  const parsed = parseCode(PAIRING_PREFIX, code);
  if (!parsed) {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.PAIRING_INVALID,
      "Unrecognized pairing code",
    );
  }
  const pairing = await db.autoApplyExtensionPairing.findUnique({
    where: { id: parsed.id },
  });
  if (
    !pairing ||
    !hashMatches(pairing.secretHash, PAIRING_PREFIX, code)
  ) {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.PAIRING_INVALID,
      "Unrecognized pairing code",
    );
  }
  if (pairing.consumedAt) {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.PAIRING_CONSUMED,
      "Pairing code was already used — create a new one",
    );
  }
  if (pairing.expiresAt.getTime() <= now.getTime()) {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.PAIRING_EXPIRED,
      "Pairing code expired — create a new one",
    );
  }

  const connectionId = randomUUID();
  const secret = randomSecret();
  const accessToken = `${TOKEN_PREFIX}.${connectionId}.${secret}`;
  const clientVersion = clampText(client.version, 40);
  const clientName =
    clampText(client.name, 80) ??
    (clientVersion ? `OpenJobAutofill ${clientVersion}` : null);

  await db.$transaction(async (tx) => {
    // Acquire SQLite's write lock before counting connections; rollback
    // consumption as well if the limit or insertion fails.
    const consumed = await tx.autoApplyExtensionPairing.updateMany({
      where: { id: pairing.id, consumedAt: null },
      data: { consumedAt: now },
    });
    if (consumed.count !== 1) {
      throw new AutoApplyConnectError(
        AUTO_APPLY_CONNECT_ERROR.PAIRING_CONSUMED,
        "Pairing code was already used — create a new one",
      );
    }

    const active = await tx.autoApplyExtensionConnection.count({
      where: { userId: pairing.userId, revokedAt: null },
    });
    if (active >= AUTO_APPLY_MAX_CONNECTIONS) {
      throw new AutoApplyConnectError(
        AUTO_APPLY_CONNECT_ERROR.CONNECTION_LIMIT,
        "Too many paired plugins — revoke one first",
      );
    }

    await tx.autoApplyExtensionConnection.create({
      data: {
        id: connectionId,
        userId: pairing.userId,
        clientName,
        tokenHash: hashSecret(TOKEN_PREFIX, accessToken),
        allowedSections: pairing.allowedSections,
        pairedAt: now,
      },
    });
  });

  log.info("[auto-apply] extension paired", {
    userId: pairing.userId,
    connectionId,
  });
  return {
    connectionId,
    accessToken,
    allowedSections: readSectionGrant(pairing.allowedSections),
    appName: "Vocatrya",
    appVersion: getAutoApplyAppVersion(),
  };
}

function parseCode(
  prefix: string,
  raw: string,
): { id: string; secret: string } | null {
  const value = String(raw ?? "").trim();
  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== prefix) return null;
  const [, id, secret] = parts;
  if (!id || !secret || secret.length < 24) return null;
  return { id, secret };
}

/**
 * Resolve a bearer token to its live connection. Throws CONNECTION_INVALID
 * for malformed/unknown tokens and CONNECTION_REVOKED for revoked ones —
 * callers map both to 401 so a dead token can never pull data.
 */
export async function authenticateConnection(
  token: string,
  deps: Deps = {},
): Promise<AutoApplyConnectionRow> {
  const db = resolveDb(deps);
  const parsed = parseCode(TOKEN_PREFIX, token);
  if (!parsed) {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.CONNECTION_INVALID,
      "Unrecognized access token",
    );
  }
  const row = await db.autoApplyExtensionConnection.findUnique({
    where: { id: parsed.id },
  });
  if (!row || !hashMatches(row.tokenHash, TOKEN_PREFIX, token)) {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.CONNECTION_INVALID,
      "Unrecognized access token",
    );
  }
  if (row.revokedAt) {
    throw new AutoApplyConnectError(
      AUTO_APPLY_CONNECT_ERROR.CONNECTION_REVOKED,
      "Connection revoked in Vocatrya — pair again to reconnect",
    );
  }
  return row;
}

export async function touchConnection(
  connectionId: string,
  patch: {
    lastSeenAt?: Date;
    lastSyncAt?: Date;
    lastProfileUpdatedAt?: string;
  },
  deps: Deps = {},
): Promise<void> {
  const db = resolveDb(deps);
  await db.autoApplyExtensionConnection.updateMany({
    where: { id: connectionId },
    data: patch,
  });
}

/** Connections for the detail page — secrets never leave this layer. */
export async function listConnections(
  userId: string,
  deps: Deps = {},
): Promise<AutoApplyConnectionSummary[]> {
  const db = resolveDb(deps);
  const rows = await db.autoApplyExtensionConnection.findMany({
    where: { userId },
    orderBy: [{ revokedAt: "asc" }, { pairedAt: "desc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    clientName: row.clientName,
    allowedSections: readSectionGrant(row.allowedSections),
    pairedAt: toIso(row.pairedAt) ?? "",
    lastSeenAt: toIso(row.lastSeenAt),
    lastSyncAt: toIso(row.lastSyncAt),
    lastProfileUpdatedAt: row.lastProfileUpdatedAt,
    revoked: row.revokedAt !== null,
    revokedAt: toIso(row.revokedAt),
  }));
}

/** App-side revoke: user-scoped so one user cannot kill another's token. */
export async function revokeConnection(
  userId: string,
  connectionId: string,
  deps: Deps = {},
  now: Date = new Date(),
): Promise<boolean> {
  const db = resolveDb(deps);
  const result = await db.autoApplyExtensionConnection.updateMany({
    where: { id: connectionId, userId, revokedAt: null },
    data: { revokedAt: now },
  });
  if (result.count === 1) {
    log.info("[auto-apply] extension connection revoked", {
      userId,
      connectionId,
    });
  }
  return result.count === 1;
}

/** Plugin self-disconnect with its own token. */
export async function revokeConnectionByToken(
  token: string,
  deps: Deps = {},
  now: Date = new Date(),
): Promise<boolean> {
  const connection = await authenticateConnection(token, deps);
  const db = resolveDb(deps);
  const result = await db.autoApplyExtensionConnection.updateMany({
    where: { id: connection.id, revokedAt: null },
    data: { revokedAt: now },
  });
  return result.count === 1;
}

export async function countActiveConnections(
  userId: string,
  deps: Deps = {},
): Promise<number> {
  const db = resolveDb(deps);
  return db.autoApplyExtensionConnection.count({
    where: { userId, revokedAt: null },
  });
}

export async function latestConnectionSyncAt(
  userId: string,
  deps: Deps = {},
): Promise<string | null> {
  const db = resolveDb(deps);
  const row = await db.autoApplyExtensionConnection.findFirst({
    where: { userId, revokedAt: null, lastSyncAt: { not: null } },
    orderBy: { lastSyncAt: "desc" },
  });
  return toIso(row?.lastSyncAt);
}

/**
 * Build the on-demand profile pull. `requested` narrows the granted set —
 * the grant from pair time is the ceiling and the export whitelist is the
 * outer bound; sensitive sections can never be requested into existence.
 */
export async function buildPairedProfile(
  connection: AutoApplyConnectionRow,
  requested: readonly string[] | null,
  deps: Deps = {},
): Promise<AutoApplyPairedProfilePayload> {
  const db = resolveDb(deps);
  const granted = readSectionGrant(connection.allowedSections);
  const requestedSet = requested ? new Set(requested) : null;
  const sections = granted.filter(
    (key) => !requestedSet || requestedSet.has(key),
  );

  const source = await loadAutoApplySource(db, connection.userId);
  const { backup, report } = buildAutoApplyExport(source, sections, {
    appVersion: getAutoApplyAppVersion(),
  });

  return {
    connectionId: connection.id,
    issuedAt: backup.exportedAt,
    profileV2: backup.profileV2,
    meta: {
      app: "Vocatrya",
      appVersion: getAutoApplyAppVersion(),
      channel: "paired-sync",
      sourceUpdatedAt: backup.profileV2.updatedAt,
      allowedSections: granted,
      sections,
      report: {
        ambiguous: report.ambiguous,
        unsupported: report.unsupported,
        sensitiveExcluded: report.sensitiveExcluded,
      },
    },
  };
}

/** Optional `sections` query param → validated subset of the grant. */
export function parseRequestedSections(
  raw: string | null,
): string[] | null {
  if (raw == null || raw.trim() === "") return null;
  const keys: string[] = [];
  for (const part of raw.split(",")) {
    const key = part.trim();
    if (!key) continue;
    if (!isExportableSectionKey(key)) {
      throw new AutoApplyConnectError(
        AUTO_APPLY_CONNECT_ERROR.INVALID_REQUEST,
        `Unknown or non-exportable section: ${key}`,
      );
    }
    keys.push(key);
  }
  return keys;
}

import "server-only";

import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { sealApiKeySecret } from "@/lib/ai/credential-store";
import { log } from "@/lib/telemetry";
import {
  FEISHU_OPERATION,
  FEISHU_TOKEN_REFRESH_LEEWAY_MS,
} from "./constants";
import { FEISHU_ERROR, FeishuError, isFeishuError } from "./errors";
import {
  fetchTenantAccessToken,
  probeFeishuCapabilities,
  type FeishuCall,
} from "./apiMap";
import { feishuRequest, mapFeishuRemoteError } from "./api";
import {
  FEISHU_STATUS,
  getFeishuConnection,
  loadCredentialBundle,
  parseAvailableCapabilities,
  upsertFeishuConnection,
  type FeishuCredentialBundle,
  type FeishuConnectionRow,
} from "./store";
import {
  computeFeishuAgentTools,
  feishuCapabilityFlags,
  isFeishuToolAllowed,
  type FeishuCapabilityFlags,
} from "./capabilities";

type Db = Pick<PrismaClient, "feishuConnection">;

export type FeishuExtensionState = {
  status: "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECTED";
  /** The configured app identifier — an ID, never the secret. */
  appId: string | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  capabilities: FeishuCapabilityFlags;
};

type Deps = { db?: Db; call?: FeishuCall };

const EMPTY_CAPABILITIES: FeishuCapabilityFlags = {
  searchDocs: false,
  readDoc: false,
  createDoc: false,
  appendContent: false,
  updateContent: false,
};

export function toExtensionState(row: {
  status: string;
  appId: string | null;
  availableCapabilities: string | null;
  connectedAt: Date | null;
  lastVerifiedAt: Date | null;
  lastError: string | null;
}): FeishuExtensionState {
  const connected = row.status === FEISHU_STATUS.CONNECTED;
  return {
    status: connected
      ? "CONNECTED"
      : row.status === FEISHU_STATUS.REAUTH_REQUIRED
        ? "REAUTH_REQUIRED"
        : "DISCONNECTED",
    appId: connected || row.status === FEISHU_STATUS.REAUTH_REQUIRED
      ? row.appId
      : null,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastError: row.lastError,
    capabilities: connected
      ? feishuCapabilityFlags(parseAvailableCapabilities(row.availableCapabilities))
      : EMPTY_CAPABILITIES,
  };
}

export async function getFeishuExtensionState(
  userId: string,
  deps: Deps = {},
): Promise<FeishuExtensionState> {
  const row = await getFeishuConnection(userId, deps.db ?? prisma);
  if (!row) {
    return toExtensionState({
      status: FEISHU_STATUS.DISCONNECTED,
      appId: null,
      availableCapabilities: null,
      connectedAt: null,
      lastVerifiedAt: null,
      lastError: null,
    });
  }
  return toExtensionState(row);
}

// ─── Tenant access token cache ─────────────────────────────────────────────
// Process-local only: the token is derivable from the sealed credentials at
// any time, holds no persistence duty, and dies with the backend process —
// exactly the lifetime we want (a restart never inherits a stale token).
const tokenCache = new Map<
  string,
  { revision: number; token: string; expiresAt: number; inflight?: Promise<string> }
>();

export function invalidateTenantToken(userId: string): void {
  tokenCache.delete(userId);
}

/** Async results belong to one exact credential generation. */
function connectionWhere(row: FeishuConnectionRow) {
  return { userId: row.userId, status: FEISHU_STATUS.CONNECTED, revision: row.revision };
}

export async function resolveFeishuAccessToken(
  userId: string,
  deps: Deps & { expectedAppId?: string | null } = {},
): Promise<string> {
  const db = deps.db ?? prisma;
  const call = deps.call ?? feishuRequest;
  const row = await getFeishuConnection(userId, db);
  if (!row || row.status !== FEISHU_STATUS.CONNECTED) {
    throw new FeishuError(row?.status === FEISHU_STATUS.REAUTH_REQUIRED
      ? FEISHU_ERROR.REAUTH_REQUIRED : FEISHU_ERROR.NOT_CONNECTED);
  }
  if (deps.expectedAppId && deps.expectedAppId !== row.appId) throw new FeishuError(FEISHU_ERROR.TOOL_UNAVAILABLE);
  const cached = tokenCache.get(userId);
  if (cached?.revision === row.revision) {
    if (cached.expiresAt - Date.now() > FEISHU_TOKEN_REFRESH_LEEWAY_MS) return cached.token;
    if (cached.inflight) return cached.inflight;
  }
  const entry = { revision: row.revision, token: "", expiresAt: 0, inflight: undefined as Promise<string> | undefined };
  tokenCache.set(userId, entry);
  entry.inflight = (async () => {
    try {
      const bundle = await loadCredentialBundle(row);
      if (!bundle) throw new FeishuError(FEISHU_ERROR.REAUTH_REQUIRED);
      const issued = await fetchTenantAccessToken(bundle.appId, bundle.appSecret, call);
      const live = await getFeishuConnection(userId, db);
      if (!live || live.status !== FEISHU_STATUS.CONNECTED || live.revision !== row.revision) throw new FeishuError(FEISHU_ERROR.NOT_CONNECTED);
      if (tokenCache.get(userId) === entry) {
        entry.token = issued.token;
        entry.expiresAt = Date.now() + issued.expiresInSec * 1000;
      }
      return issued.token;
    } catch (error) {
      const mapped = isFeishuError(error) ? error : mapFeishuRemoteError(error);
      if (mapped.code === FEISHU_ERROR.INVALID_CREDENTIALS || mapped.code === FEISHU_ERROR.REAUTH_REQUIRED) {
        await db.feishuConnection.updateMany({
          where: connectionWhere(row),
          data: { status: FEISHU_STATUS.REAUTH_REQUIRED, revision: { increment: 1 },
            encryptedCredential: null, credentialIv: null, availableCapabilities: null,
            lastError: FEISHU_ERROR.REAUTH_REQUIRED },
        });
        throw new FeishuError(FEISHU_ERROR.REAUTH_REQUIRED);
      }
      throw mapped;
    } finally {
      if (tokenCache.get(userId) === entry) {
        delete entry.inflight;
        if (!entry.token) tokenCache.delete(userId);
      }
    }
  })();
  return entry.inflight;
}

/**
 * Connect (or re-credential) the app. Validates the pair against the token
 * endpoint, seals the bundle, probes capabilities, and commits CONNECTED in
 * one conditional write — a concurrent disconnect between probe and commit
 * loses the race honestly (the row it writes is keyed on the state it saw).
 */
export async function connectFeishu(
  userId: string,
  input: { appId: string; appSecret: string },
  deps: Deps = {},
): Promise<FeishuExtensionState> {
  const db = deps.db ?? prisma;
  const call = deps.call ?? feishuRequest;
  const appId = input.appId.trim();
  let appSecret = input.appSecret.trim();
  if (!/^[A-Za-z0-9_-]{4,}$/.test(appId) || (appSecret && appSecret.length < 8)) throw new FeishuError(FEISHU_ERROR.VALIDATION_FAILED);
  // Establish the revision before any asynchronous credential or network work.
  const before = await upsertFeishuConnection(userId, {}, db);
  if (!appSecret) {
    // Reconnect keeping the stored secret: only when the same app id already
    // holds a readable bundle — never a blank-secret bypass for a new app.
    const existing = before;
    const bundle =
      existing && existing.appId === appId
        ? await loadCredentialBundle(existing)
        : null;
    if (!bundle) throw new FeishuError(FEISHU_ERROR.VALIDATION_FAILED);
    appSecret = bundle.appSecret;
  }
  if (!/^[A-Za-z0-9_-]{4,}$/.test(appId) || appSecret.length < 8) {
    throw new FeishuError(FEISHU_ERROR.VALIDATION_FAILED);
  }
  let issued;
  try {
    issued = await fetchTenantAccessToken(appId, appSecret, call);
  } catch (error) {
    throw isFeishuError(error) ? error : mapFeishuRemoteError(error);
  }
  const probe = await probeFeishuCapabilities(issued.token, call);
  const bundle: FeishuCredentialBundle = { v: 1, appId, appSecret };
  const sealed = await sealApiKeySecret(JSON.stringify(bundle));
  const updated = await db.feishuConnection.updateMany({
    where: { userId, revision: before.revision },
    data: {
      status: FEISHU_STATUS.CONNECTED, revision: { increment: 1 }, appId,
      encryptedCredential: sealed.encryptedKey, credentialIv: sealed.iv,
      availableCapabilities: JSON.stringify(probe.capabilities),
      connectedAt: new Date(), lastVerifiedAt: new Date(), lastError: probe.error ?? null,
    },
  });
  if (updated.count !== 1) return getFeishuExtensionState(userId, deps);
  // Let resolution fill the generation-bound cache on demand.
  const row = await getFeishuConnection(userId, db);
  if (!row) return getFeishuExtensionState(userId, deps);
  log.info("[feishu] connected", { userId, appId });
  return toExtensionState(row);
}

/**
 * Re-assert the connection: resolve a fresh tenant token and re-probe
 * capabilities, persisting the verified set. Invalid credentials flip the
 * row to REAUTH_REQUIRED; a network failure keeps CONNECTED with the stale
 * set (calls fail honestly at call time). The write is conditional on the
 * row still being CONNECTED — a disconnect during the probe wins.
 */
export async function verifyFeishuConnection(
  userId: string,
  deps: Deps = {},
): Promise<FeishuExtensionState> {
  const db = deps.db ?? prisma;
  const call = deps.call ?? feishuRequest;
  const row = await getFeishuConnection(userId, db);
  if (!row || row.status !== FEISHU_STATUS.CONNECTED) {
    return getFeishuExtensionState(userId, deps);
  }
  try {
    const token = await resolveFeishuAccessToken(userId, deps);
    const probe = await probeFeishuCapabilities(token, call);
    const updated = await db.feishuConnection.updateMany({
      where: connectionWhere(row),
      data: {
        availableCapabilities: JSON.stringify(probe.capabilities),
        lastVerifiedAt: new Date(),
        lastError: probe.error ?? null,
      },
    });
    if (updated.count !== 1) return getFeishuExtensionState(userId, deps);
    return toExtensionState(
      (await getFeishuConnection(userId, db)) ?? row,
    );
  } catch (error) {
    const mapped = isFeishuError(error)
      ? error
      : mapFeishuRemoteError(error);
    if (mapped.code === FEISHU_ERROR.REAUTH_REQUIRED) {
      await db.feishuConnection.updateMany({
        where: connectionWhere(row),
        data: {
          status: FEISHU_STATUS.REAUTH_REQUIRED,
          revision: { increment: 1 },
          encryptedCredential: null,
          credentialIv: null,
          availableCapabilities: null,
          lastError: mapped.code,
        },
      });
      if (tokenCache.get(userId)?.revision === row.revision) invalidateTenantToken(userId);
      return getFeishuExtensionState(userId, deps);
    }
    await db.feishuConnection.updateMany({
      where: connectionWhere(row),
      data: { lastError: mapped.code },
    });
    return getFeishuExtensionState(userId, deps);
  }
}

/**
 * The agent-tool names this user's connected app can serve — connection ∩
 * probed capabilities ∩ app allowlist, resolved before the chat registry is
 * built. Role allowlists shrink it downstream; execution re-checks the live
 * row per call.
 */
export async function resolveFeishuAgentToolNames(
  userId: string,
  deps: Deps = {},
): Promise<string[]> {
  const row = await getFeishuConnection(userId, deps.db ?? prisma);
  if (!row || row.status !== FEISHU_STATUS.CONNECTED) return [];
  return [
    ...computeFeishuAgentTools(
      parseAvailableCapabilities(row.availableCapabilities),
    ),
  ];
}

/**
 * Execution-time gate for the harness VERIFY step and the read tools: the
 * live row must still be CONNECTED and the tool must still be allowed.
 * Returns the app id so proposals bound to one credential cannot dispatch
 * under a silently different app.
 */
export async function resolveFeishuRemoteMeta(
  userId: string,
  agentToolName: string,
  db: Db = prisma,
): Promise<{ remoteName: string; appId: string | null }> {
  const row = await getFeishuConnection(userId, db);
  if (!isFeishuToolAllowed(row, agentToolName)) {
    throw new FeishuError(
      !row
        ? FEISHU_ERROR.NOT_CONNECTED
        : row.status === FEISHU_STATUS.REAUTH_REQUIRED
          ? FEISHU_ERROR.REAUTH_REQUIRED
          : FEISHU_ERROR.TOOL_UNAVAILABLE,
    );
  }
  const remoteName =
    agentToolName === "feishu_create_doc"
      ? FEISHU_OPERATION.createDoc
      : agentToolName === "feishu_append_content"
        ? FEISHU_OPERATION.appendBlocks
        : agentToolName === "feishu_update_content"
          ? FEISHU_OPERATION.batchUpdateBlocks
          : agentToolName;
  return {
    remoteName,
    appId: typeof row!.appId === "string" ? row!.appId : null,
  };
}

export async function disconnectFeishu(
  userId: string,
  deps: Deps = {},
): Promise<FeishuExtensionState> {
  const db = deps.db ?? prisma;
  await upsertFeishuConnection(userId, {
    status: FEISHU_STATUS.DISCONNECTED, revision: { increment: 1 }, appId: null,
    availableCapabilities: null, encryptedCredential: null, credentialIv: null,
    connectedAt: null, lastVerifiedAt: null, lastError: null,
  }, db);
  invalidateTenantToken(userId);
  log.info("[feishu] disconnected", { userId });
  return getFeishuExtensionState(userId, deps);
}

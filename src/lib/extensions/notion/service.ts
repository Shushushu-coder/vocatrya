import "server-only";

import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { sealApiKeySecret } from "@/lib/ai/credential-store";
import { log } from "@/lib/telemetry";
import {
  NOTION_CALLBACK_HOST,
  NOTION_CALLBACK_PATH,
  NOTION_CALLBACK_PORTS,
  NOTION_OAUTH_CLIENT_NAME,
  NOTION_OAUTH_PENDING_TTL_MS,
  NOTION_TOKEN_REFRESH_LEEWAY_MS,
} from "./constants";
import {
  closeNotionCallbackListener,
  ensureNotionCallbackListener,
} from "./callbackServer";
import { NOTION_ERROR, NotionError, isNotionError } from "./errors";
import {
  listNotionRemoteTools,
  mapNotionRemoteError,
} from "./mcpClient";
import {
  buildAuthorizationUrl,
  discoverNotionAuthorizationServer,
  exchangeAuthorizationCode,
  generatePkce,
  generateState,
  hashPendingState,
  refreshNotionTokens,
  registerNotionClient,
  revokeNotionToken,
  type NotionAuthorizationServer,
} from "./oauth";
import {
  NOTION_STATUS,
  clearPendingFlow,
  getNotionConnection,
  getNotionConnectionByStateHash,
  loadPendingFlow,
  loadTokenBundle,
  parseAvailableTools,
  savePendingFlow,
  upsertNotionConnection,
  type NotionTokenBundle,
} from "./store";
import {
  computeNotionAgentTools,
  notionCapabilityFlags,
  type NotionCapabilityFlags,
} from "./capabilities";

type Db = Pick<PrismaClient, "notionConnection">;

export type NotionExtensionState = {
  status: "CONNECTED" | "REAUTH_REQUIRED" | "DISCONNECTED" | "CONNECTING";
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceIcon: string | null;
  connectedAt: string | null;
  lastVerifiedAt: string | null;
  lastError: string | null;
  capabilities: NotionCapabilityFlags;
};

type Deps = { db?: Db };

function stateOf(row: {
  status: string;
  pendingCipher: string | null;
}): NotionExtensionState["status"] {
  if (row.status === NOTION_STATUS.CONNECTED) return "CONNECTED";
  if (row.status === NOTION_STATUS.REAUTH_REQUIRED) return "REAUTH_REQUIRED";
  return row.pendingCipher ? "CONNECTING" : "DISCONNECTED";
}

export function toExtensionState(row: {
  status: string;
  pendingCipher: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceIcon: string | null;
  availableTools: string | null;
  connectedAt: Date | null;
  lastVerifiedAt: Date | null;
  lastError: string | null;
}): NotionExtensionState {
  const connected = row.status === NOTION_STATUS.CONNECTED;
  return {
    status: stateOf(row),
    workspaceId: row.workspaceId,
    workspaceName: row.workspaceName,
    workspaceIcon: row.workspaceIcon,
    connectedAt: row.connectedAt?.toISOString() ?? null,
    lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
    lastError: row.lastError,
    capabilities: connected
      ? notionCapabilityFlags(parseAvailableTools(row.availableTools))
      : {
          search: false,
          read: false,
          createPage: false,
          appendContent: false,
          updateRecord: false,
          updateContent: false,
          deletePages: false,
        },
  };
}

export async function getNotionExtensionState(
  userId: string,
  deps: Deps = {},
): Promise<NotionExtensionState> {
  const db = deps.db ?? prisma;
  let row = await getNotionConnection(userId, db);
  if (!row) {
    return toExtensionState({
      status: NOTION_STATUS.DISCONNECTED,
      pendingCipher: null,
      workspaceId: null,
      workspaceName: null,
      workspaceIcon: null,
      availableTools: null,
      connectedAt: null,
      lastVerifiedAt: null,
      lastError: null,
    });
  }
  // Lazily heal an abandoned OAuth flow: the pending record is TTL-bound and
  // the callback listener is long gone, but the sealed column would keep the
  // UI in CONNECTING forever with no way to restart the consent.
  if (row.status !== NOTION_STATUS.CONNECTED && row.pendingCipher) {
    const pending = await loadPendingFlow(row);
    if (!pending || pending.expiresAt < Date.now()) {
      // A newer login may have replaced this flow while it was unsealed.
      await db.notionConnection.updateMany({
        where: {
          userId,
          status: row.status,
          pendingCipher: row.pendingCipher,
          pendingStateHash: row.pendingStateHash,
        },
        data: { pendingCipher: null, pendingIv: null, pendingStateHash: null },
      });
      row = (await getNotionConnection(userId, db)) ?? {
        ...row, pendingCipher: null, pendingIv: null, pendingStateHash: null,
      };
    }
  }
  return toExtensionState(row);
}

/**
 * Re-assert the connection against the live server: resolves a fresh token
 * (refreshing when needed) and lists remote tools, persisting the verified
 * set. A revoked grant flips the row to REAUTH_REQUIRED; a network failure
 * keeps CONNECTED with a stale tool list (reads fail honestly at call time).
 */
export async function verifyNotionConnection(
  userId: string,
  deps: Deps = {},
): Promise<NotionExtensionState> {
  const db = deps.db ?? prisma;
  const row = await getNotionConnection(userId, db);
  if (!row || row.status !== NOTION_STATUS.CONNECTED) {
    return getNotionExtensionState(userId, deps);
  }
  try {
    const accessToken = await resolveNotionAccessToken(userId, deps);
    const remoteTools = await listNotionRemoteTools(accessToken);
    const updated = await upsertNotionConnection(
      userId,
      {
        availableTools: JSON.stringify(
          remoteTools.map((tool) => ({
            name: tool.name,
            inputSchema: tool.inputSchema,
          })),
        ),
        lastVerifiedAt: new Date(),
        lastError: null,
      },
      db,
    );
    return toExtensionState(updated);
  } catch (error) {
    const mapped = isNotionError(error)
      ? error
      : mapNotionRemoteError(error);
    if (mapped.code === NOTION_ERROR.REAUTH_REQUIRED) {
      const updated = await upsertNotionConnection(
        userId,
        {
          status: NOTION_STATUS.REAUTH_REQUIRED,
          encryptedCredential: null,
          credentialIv: null,
          lastError: mapped.code,
        },
        db,
      );
      return toExtensionState(updated);
    }
    const updated = await upsertNotionConnection(
      userId,
      { lastError: mapped.code },
      db,
    );
    return toExtensionState(updated);
  }
}

export async function startNotionConnect(
  userId: string,
  appOrigin: string,
  deps: Deps = {},
): Promise<{ authorizationUrl: string }> {
  const db = deps.db ?? prisma;
  const server = await discoverNotionAuthorizationServer();
  const redirectUris = NOTION_CALLBACK_PORTS.map(
    (port) => `http://${NOTION_CALLBACK_HOST}:${port}${NOTION_CALLBACK_PATH}`,
  );

  const existing = await getNotionConnection(userId, db);
  let clientId = existing?.oauthClientId ?? null;
  let clientSecret: string | undefined;
  if (!clientId) {
    const registration = await registerNotionClient(
      server,
      redirectUris,
      NOTION_OAUTH_CLIENT_NAME,
    );
    clientId = registration.clientId;
    clientSecret = registration.clientSecret;
  }

  const port = await ensureNotionCallbackListener(
    NOTION_CALLBACK_PORTS,
    handleNotionOAuthCallback,
  );
  const redirectUri = `http://${NOTION_CALLBACK_HOST}:${port}${NOTION_CALLBACK_PATH}`;
  const { verifier, challenge } = generatePkce();
  const state = generateState();
  // A registration secret, when issued, travels inside the sealed pending
  // record and lands in the sealed token bundle — never a plaintext column.
  await savePendingFlow(
    userId,
    {
      v: 1,
      state,
      codeVerifier: verifier,
      redirectUri,
      appOrigin,
      expiresAt: Date.now() + NOTION_OAUTH_PENDING_TTL_MS,
      clientSecret,
    },
    hashPendingState(state),
    db,
  );
  // The client registration persists with the pending flow: if the flow is
  // abandoned, the next connect reuses it.
  await db.notionConnection.updateMany({
    where: { userId },
    data: { oauthClientId: clientId },
  });

  const authorizationUrl = buildAuthorizationUrl({
    endpoint: server.authorizationEndpoint,
    clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
  });
  log.info("[notion] connect started", { userId });
  return { authorizationUrl };
}

export async function handleNotionOAuthCallback(input: {
  code?: string;
  state?: string;
  error?: string;
}, deps: Deps = {}): Promise<{ redirectUrl: string | null; connected: boolean }> {
  const db = deps.db ?? prisma;
  const state = input.state;
  if (!state) {
    return { redirectUrl: null, connected: false };
  }
  const row = await getNotionConnectionByStateHash(hashPendingState(state), db);
  const pending = row ? await loadPendingFlow(row) : null;
  const appOrigin = pending?.appOrigin;
  const done = (suffix: string) =>
    appOrigin
      ? {
          redirectUrl: `${appOrigin}/dashboard/extensions/notion?${suffix}`,
          connected: suffix === "notion=connected",
        }
      : { redirectUrl: null, connected: false };

  const settle = async () => {
    if (!row || !pending) return done("notion=error&code=NOTION_OAUTH_STATE_MISMATCH");
    if (pending.state !== state || pending.expiresAt < Date.now()) {
      await db.notionConnection.updateMany({
        where: { userId: row.userId, pendingStateHash: row.pendingStateHash, pendingCipher: row.pendingCipher },
        data: { pendingCipher: null, pendingIv: null, pendingStateHash: null },
      });
      return done("notion=error&code=NOTION_OAUTH_FLOW_EXPIRED");
    }
    if (input.error) {
      await db.notionConnection.updateMany({
        where: { userId: row.userId, pendingStateHash: row.pendingStateHash, pendingCipher: row.pendingCipher },
        data: { pendingCipher: null, pendingIv: null, pendingStateHash: null },
      });
      return done(
        `notion=error&code=${input.error === "access_denied" ? "NOTION_OAUTH_DENIED" : "NOTION_OAUTH_FAILED"}`,
      );
    }
    if (!input.code) return done("notion=error&code=NOTION_OAUTH_FAILED");

    try {
      const server = await discoverNotionAuthorizationServer();
      const clientId = row.oauthClientId ?? "";
      const tokens = await exchangeAuthorizationCode(server, {
        code: input.code,
        redirectUri: pending.redirectUri,
        codeVerifier: pending.codeVerifier,
        clientId,
        clientSecret: pending.clientSecret,
      });
      const bundle: NotionTokenBundle = {
        v: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope,
        clientId,
        clientSecret: pending.clientSecret,
      };
      const sealed = await sealApiKeySecret(JSON.stringify(bundle));
      const committed = await db.notionConnection.updateMany({
        where: { userId: row.userId, pendingStateHash: row.pendingStateHash, pendingCipher: row.pendingCipher },
        data: {
        encryptedCredential: sealed.encryptedKey,
        credentialIv: sealed.iv,
        status: NOTION_STATUS.CONNECTED,
        workspaceId: tokens.workspaceId ?? null,
        workspaceName: tokens.workspaceName ?? null,
        workspaceIcon: tokens.workspaceIcon ?? null,
        notionUserId: tokens.ownerUserId ?? null,
        botId: tokens.botId ?? null,
        grantedScope: tokens.scope ?? null,
        connectedAt: new Date(),
        lastVerifiedAt: null,
        lastError: null,
        pendingCipher: null,
        pendingIv: null,
        pendingStateHash: null,
        },
      });
      if (committed.count !== 1) return done("notion=error&code=NOTION_OAUTH_STATE_MISMATCH");
      // Best-effort first verification — its failure leaves CONNECTED with
      // an empty capability set rather than failing the whole flow.
      void verifyNotionConnection(row.userId, { db }).catch(() => undefined);
      log.info("[notion] connected", {
        userId: row.userId,
        workspaceId: tokens.workspaceId ?? null,
      });
      return done("notion=connected");
    } catch (error) {
      const code = isNotionError(error)
        ? error.code
        : NOTION_ERROR.OAUTH_FAILED;
      await db.notionConnection.updateMany({
        where: { userId: row.userId, pendingStateHash: row.pendingStateHash, pendingCipher: row.pendingCipher },
        data: { pendingCipher: null, pendingIv: null, pendingStateHash: null },
      });
      // A failed old callback must not mutate a disconnected or newer flow.

      return done(`notion=error&code=${code}`);
    } finally {
      // An old callback must not close the listener of a newer pending flow.
      const current = await getNotionConnection(row.userId, db);
      if (!current?.pendingStateHash) closeNotionCallbackListener();
    }
  };
  return settle();
}

const refreshLocks = new Map<string, Promise<string>>();

/**
 * Resolve a usable access token for the user: unseals the bundle, refreshes
 * when inside the expiry leeway (single-flight per user), and persists the
 * rotated bundle atomically. Never logs or returns anything but the token.
 */
export async function resolveNotionAccessToken(
  userId: string,
  deps: Deps = {},
): Promise<string> {
  const db = deps.db ?? prisma;
  const row = await getNotionConnection(userId, db);
  if (!row || row.status !== NOTION_STATUS.CONNECTED) {
    throw new NotionError(
      row?.status === NOTION_STATUS.REAUTH_REQUIRED
        ? NOTION_ERROR.REAUTH_REQUIRED
        : NOTION_ERROR.NOT_CONNECTED,
    );
  }
  const bundle = await loadTokenBundle(row);
  if (!bundle) throw new NotionError(NOTION_ERROR.REAUTH_REQUIRED);
  const expired =
    bundle.expiresAt !== undefined &&
    bundle.expiresAt - Date.now() < NOTION_TOKEN_REFRESH_LEEWAY_MS;
  if (!expired) return bundle.accessToken;
  if (!bundle.refreshToken) {
    throw new NotionError(NOTION_ERROR.REAUTH_REQUIRED);
  }

  const inFlight = refreshLocks.get(userId);
  if (inFlight) return inFlight;
  const refresh = (async () => {
    try {
      const server = await discoverNotionAuthorizationServer();
      const tokens = await refreshNotionTokens(server, {
        refreshToken: bundle.refreshToken!,
        clientId: bundle.clientId,
        clientSecret: bundle.clientSecret,
      });
      const next: NotionTokenBundle = {
        v: 1,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? bundle.refreshToken,
        expiresAt: tokens.expiresAt,
        scope: tokens.scope ?? bundle.scope,
        clientId: bundle.clientId,
        clientSecret: bundle.clientSecret,
      };
      const sealed = await sealApiKeySecret(JSON.stringify(next));
      const saved = await db.notionConnection.updateMany({
        where: { userId, status: NOTION_STATUS.CONNECTED, encryptedCredential: row.encryptedCredential },
        data: { encryptedCredential: sealed.encryptedKey, credentialIv: sealed.iv },
      });
      if (saved.count !== 1) throw new NotionError(NOTION_ERROR.NOT_CONNECTED);
      return next.accessToken;
    } catch (error) {
      const mapped = isNotionError(error)
        ? error
        : mapNotionRemoteError(error);
      if (mapped.code === NOTION_ERROR.REAUTH_REQUIRED) {
        await upsertNotionConnection(
          userId,
          {
            status: NOTION_STATUS.REAUTH_REQUIRED,
            encryptedCredential: null,
            credentialIv: null,
            lastError: mapped.code,
          },
          db,
        );
      }
      throw mapped;
    } finally {
      refreshLocks.delete(userId);
    }
  })();
  refreshLocks.set(userId, refresh);
  return refresh;
}

/**
 * The agent-tool names this user's connected session can serve — the
 * connection ∩ remote tools/list ∩ app allowlist intersection the chat
 * route resolves before building the registry. Role allowlists shrink it
 * further downstream; execution re-checks the live row per call.
 */
export async function resolveNotionAgentToolNames(
  userId: string,
  deps: Deps = {},
): Promise<string[]> {
  const row = await getNotionConnection(userId, deps.db ?? prisma);
  if (!row || row.status !== NOTION_STATUS.CONNECTED) return [];
  return [...computeNotionAgentTools(parseAvailableTools(row.availableTools))];
}

export async function disconnectNotion(
  userId: string,
  deps: Deps = {},
): Promise<NotionExtensionState> {
  const db = deps.db ?? prisma;
  const row = await getNotionConnection(userId, db);
  if (row) {
    await upsertNotionConnection(
      userId,
      {
        status: NOTION_STATUS.DISCONNECTED,
        workspaceId: null,
        workspaceName: null,
        workspaceIcon: null,
        notionUserId: null,
        botId: null,
        grantedScope: null,
        availableTools: null,
        encryptedCredential: null,
        credentialIv: null,
        pendingCipher: null,
        pendingIv: null,
        pendingStateHash: null,
        connectedAt: null,
        lastVerifiedAt: null,
        lastError: null,
      },
      db,
    );
    closeNotionCallbackListener();
    // Best-effort remote revocation of the refresh token (revokes the whole
    // grant); the local wipe happens regardless of the outcome.
    try {
      const bundle = await loadTokenBundle(row).catch(() => null);
      const token = bundle?.refreshToken ?? bundle?.accessToken;
      if (token && bundle) {
        const server = await discoverNotionAuthorizationServer();
        await revokeNotionToken(server, {
          token,
          clientId: bundle.clientId,
          clientSecret: bundle.clientSecret,
        });
      }
    } catch {
      // Revocation is advisory — the connection is severed locally anyway.
    }

  }
  closeNotionCallbackListener();
  log.info("[notion] disconnected", { userId });
  return getNotionExtensionState(userId, deps);
}

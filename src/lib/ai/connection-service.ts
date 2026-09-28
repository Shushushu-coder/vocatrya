/**
 * Phase D AIConnection persistence service — the only module that writes
 * AIConnection rows for runtime account-login operations.
 *
 * Every write path here is reached exclusively through the internal
 * loopback API after the Electron runtime has performed and verified the
 * operation. Rows are created as CONNECTED only on verified authentication.
 * Credential material never enters this module: it sees opaque profile
 * refs, auth-state enums, and an optional non-secret account identity.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import prisma from "@/lib/db";
import {
  AI_CONNECTION_OP_ERROR_CODES,
  assertProviderMetadataSafe,
  isAIBackendKind,
  isAIConnectionProvider,
  isSupportedAccountProviderForBackend,
} from "@/lib/ai/connections";
import { isRuntimeProfileRef } from "@/lib/ai/runtime/contract";
import type { PrismaClient } from "@prisma/client";

type DbClient = Pick<
  PrismaClient,
  "aIConnection"
>;

export class ConnectionOpError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ConnectionOpError";
    this.code = code;
  }
}

export interface ConnectionSummary {
  id: string;
  provider: string;
  authType: string;
  backendKind: string;
  displayName: string;
  accountIdentity: string | null;
  status: string;
  runtimeProfileRef: string | null;
  lastVerifiedAt: Date | null;
  createdAt: Date;
}

const CONNECTION_SUMMARY_SELECT = {
  id: true,
  provider: true,
  authType: true,
  backendKind: true,
  displayName: true,
  accountIdentity: true,
  status: true,
  runtimeProfileRef: true,
  lastVerifiedAt: true,
  createdAt: true,
} as const;

// Default display names per account-login provider + runtime pairing; a
// second connection of the same pairing is numbered ("Claude 2", ...).
// The runtime is part of the name so e.g. two products on the same
// runtime stay visually distinct.
const ACCOUNT_LOGIN_DISPLAY_NAMES: Record<string, string> = {
  "OPENAI:CODEX_RUNTIME": "ChatGPT via Codex",
  "ANTHROPIC:CLAUDE_RUNTIME": "Claude",
  "XAI:GROK_RUNTIME": "Grok",
  "OPENCODE_ZEN:OPENCODE_RUNTIME": "OpenCode Zen",
  "OPENCODE_GO:OPENCODE_RUNTIME": "OpenCode Go",
  "CURSOR:CURSOR_RUNTIME": "Cursor",
  "GITHUB_COPILOT:COPILOT_RUNTIME": "Copilot",
  "DEVIN:DEVIN_RUNTIME": "Devin",
};

/**
 * Normalizes the non-secret provider metadata reported by the runtime
 * (e.g. Claude's org name / subscription type). Any credential-shaped key
 * is rejected — a provider row must never become a credential store.
 */
function serializeProviderMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new ConnectionOpError(
      AI_CONNECTION_OP_ERROR_CODES.LOGIN_FAILED,
      "Invalid provider metadata",
    );
  }
  try {
    assertProviderMetadataSafe(metadata);
  } catch {
    throw new ConnectionOpError(
      AI_CONNECTION_OP_ERROR_CODES.LOGIN_FAILED,
      "Provider metadata contains forbidden fields",
    );
  }
  return JSON.stringify(metadata);
}

export async function listConnectionsForUser(
  userId: string,
  dbClient: DbClient = prisma,
): Promise<ConnectionSummary[]> {
  const rows = await dbClient.aIConnection.findMany({
    where: { userId, archivedAt: null },
    select: CONNECTION_SUMMARY_SELECT,
    orderBy: { createdAt: "asc" },
  });
  return rows;
}

/**
 * Connection context the Electron runtime needs to perform an operation:
 * the opaque profile binding plus the stored identity for reauth
 * comparison. Ownership was proven when the ticket was minted; the
 * userId re-check here is defense in depth against ticket misuse.
 */
export async function getConnectionOperationContext(
  { userId, connectionId }: { userId: string; connectionId: string },
  dbClient: DbClient = prisma,
): Promise<ConnectionSummary> {
  const connection = await dbClient.aIConnection.findUnique({
    where: { id: connectionId },
    select: { ...CONNECTION_SUMMARY_SELECT, userId: true, archivedAt: true },
  });
  if (!connection || connection.userId !== userId) {
    throw new ConnectionOpError(
      AI_CONNECTION_OP_ERROR_CODES.CONNECTION_NOT_FOUND,
      "Connection not found",
    );
  }
  if (connection.archivedAt) {
    throw new ConnectionOpError(
      AI_CONNECTION_OP_ERROR_CODES.CONNECTION_ARCHIVED,
      "Connection is archived",
    );
  }
  return connection;
}

/**
 * Creates the AIConnection row after the runtime has verified the account
 * login. The pending profile becomes the connection's managed profile —
 * nothing is persisted before this point.
 *
 * `verifiedProvider` is the account provider the runtime adapter actually
 * verified during authentication (e.g. OpenAI ChatGPT OAuth inside the
 * OpenCode profile) — never a renderer-supplied value and never derived
 * from backendKind alone. The provider/runtime pairing is re-validated
 * against the supported-provider matrix before anything is written.
 */
export async function createVerifiedAccountConnection(
  {
    userId,
    backendKind,
    verifiedProvider,
    runtimeProfileRef,
    accountIdentity,
    providerMetadata,
  }: {
    userId: string;
    backendKind: string;
    verifiedProvider: string;
    runtimeProfileRef: string;
    accountIdentity: string | null;
    providerMetadata?: Record<string, unknown> | null;
  },
  dbClient: DbClient = prisma,
): Promise<ConnectionSummary> {
  if (!isAIBackendKind(backendKind)) {
    throw new ConnectionOpError(
      AI_CONNECTION_OP_ERROR_CODES.UNSUPPORTED_BACKEND,
      `Unsupported backend kind: ${backendKind}`,
    );
  }
  if (
    !isAIConnectionProvider(verifiedProvider) ||
    !isSupportedAccountProviderForBackend(backendKind, verifiedProvider)
  ) {
    throw new ConnectionOpError(
      AI_CONNECTION_OP_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
      `Provider ${verifiedProvider} is not supported on backend ${backendKind}`,
    );
  }
  const provider = verifiedProvider;
  if (!isRuntimeProfileRef(runtimeProfileRef)) {
    throw new ConnectionOpError(
      AI_CONNECTION_OP_ERROR_CODES.LOGIN_FAILED,
      "Invalid runtime profile ref",
    );
  }
  if (
    accountIdentity !== null &&
    (typeof accountIdentity !== "string" || accountIdentity.length > 320)
  ) {
    throw new ConnectionOpError(
      AI_CONNECTION_OP_ERROR_CODES.LOGIN_FAILED,
      "Invalid account identity",
    );
  }
  const siblingCount = await dbClient.aIConnection.count({
    where: { userId, provider, backendKind, authType: "ACCOUNT_LOGIN" },
  });
  const baseName =
    ACCOUNT_LOGIN_DISPLAY_NAMES[`${provider}:${backendKind}`] ?? provider;
  const displayName =
    siblingCount === 0 ? baseName : `${baseName} ${siblingCount + 1}`;
  return dbClient.aIConnection.create({
    data: {
      id: randomUUID(),
      userId,
      provider,
      authType: "ACCOUNT_LOGIN",
      backendKind,
      displayName,
      accountIdentity,
      status: "CONNECTED",
      credentialRef: null,
      runtimeProfileRef,
      providerMetadata: serializeProviderMetadata(providerMetadata),
      lastVerifiedAt: new Date(),
    },
    select: CONNECTION_SUMMARY_SELECT,
  });
}

/** AUTHENTICATED reconnect keeps the same row — id and profile untouched. */
export async function applyReconnectAuthenticated(
  {
    userId,
    connectionId,
    accountIdentity,
    providerMetadata,
  }: {
    userId: string;
    connectionId: string;
    accountIdentity: string | null;
    providerMetadata?: Record<string, unknown> | null;
  },
  dbClient: DbClient = prisma,
): Promise<ConnectionSummary> {
  await getConnectionOperationContext({ userId, connectionId }, dbClient);
  const serialized = serializeProviderMetadata(providerMetadata);
  return dbClient.aIConnection.update({
    where: { id: connectionId },
    data: {
      status: "CONNECTED",
      lastVerifiedAt: new Date(),
      ...(accountIdentity ? { accountIdentity } : {}),
      ...(serialized ? { providerMetadata: serialized } : {}),
    },
    select: CONNECTION_SUMMARY_SELECT,
  });
}

/**
 * Re-authentication produced a different account identity. The connection
 * is moved to ERROR so no business surface silently uses the wrong account;
 * resolving it requires explicit user action (e.g. archive + connect new).
 */
export async function applyReconnectIdentityConflict(
  { userId, connectionId }: { userId: string; connectionId: string },
  dbClient: DbClient = prisma,
): Promise<ConnectionSummary> {
  await getConnectionOperationContext({ userId, connectionId }, dbClient);
  return dbClient.aIConnection.update({
    where: { id: connectionId },
    data: { status: "ERROR" },
    select: CONNECTION_SUMMARY_SELECT,
  });
}

/**
 * Maps a runtime auth-state observation onto connection status. Runtime
 * installation state is never written here — it is a separate axis.
 */
export function mapAuthStateToConnectionStatus(authState: string): string {
  switch (authState) {
    case "AUTHENTICATED":
      return "CONNECTED";
    case "NOT_AUTHENTICATED":
    case "REAUTH_REQUIRED":
      return "REAUTH_REQUIRED";
    default:
      return "ERROR";
  }
}

export async function applyVerifyResult(
  {
    userId,
    connectionId,
    authState,
  }: { userId: string; connectionId: string; authState: string },
  dbClient: DbClient = prisma,
): Promise<ConnectionSummary> {
  await getConnectionOperationContext({ userId, connectionId }, dbClient);
  const status = mapAuthStateToConnectionStatus(authState);
  return dbClient.aIConnection.update({
    where: { id: connectionId },
    data: {
      status,
      ...(status === "CONNECTED" ? { lastVerifiedAt: new Date() } : {}),
    },
    select: CONNECTION_SUMMARY_SELECT,
  });
}

/** Disconnect keeps the row, the profile ref, and all history. */
export async function applyDisconnect(
  { userId, connectionId }: { userId: string; connectionId: string },
  dbClient: DbClient = prisma,
): Promise<ConnectionSummary> {
  await getConnectionOperationContext({ userId, connectionId }, dbClient);
  return dbClient.aIConnection.update({
    where: { id: connectionId },
    data: { status: "DISCONNECTED" },
    select: CONNECTION_SUMMARY_SELECT,
  });
}

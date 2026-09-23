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
  AI_BACKEND_PROVIDER,
  AI_CONNECTION_OP_ERROR_CODES,
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
 */
export async function createVerifiedAccountConnection(
  {
    userId,
    backendKind,
    runtimeProfileRef,
    accountIdentity,
  }: {
    userId: string;
    backendKind: string;
    runtimeProfileRef: string;
    accountIdentity: string | null;
  },
  dbClient: DbClient = prisma,
): Promise<ConnectionSummary> {
  const provider = AI_BACKEND_PROVIDER[
    backendKind as keyof typeof AI_BACKEND_PROVIDER
  ];
  if (!provider) {
    throw new ConnectionOpError(
      AI_CONNECTION_OP_ERROR_CODES.UNSUPPORTED_BACKEND,
      `Unsupported backend kind: ${backendKind}`,
    );
  }
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
    where: { userId, provider, authType: "ACCOUNT_LOGIN" },
  });
  const displayName =
    siblingCount === 0 ? "ChatGPT" : `ChatGPT ${siblingCount + 1}`;
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
  }: { userId: string; connectionId: string; accountIdentity: string | null },
  dbClient: DbClient = prisma,
): Promise<ConnectionSummary> {
  await getConnectionOperationContext({ userId, connectionId }, dbClient);
  return dbClient.aIConnection.update({
    where: { id: connectionId },
    data: {
      status: "CONNECTED",
      lastVerifiedAt: new Date(),
      ...(accountIdentity ? { accountIdentity } : {}),
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

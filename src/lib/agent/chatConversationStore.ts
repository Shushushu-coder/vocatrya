import { nativeReadiness, NATIVE_PATH, APP_PATH } from "./nativeSession.server";
import { decodeHistory } from "./historyCodec";
import { ConversationRequestError } from "./conversationRequest";
import { permissionModeOfContext } from "./preferences";
import { prepareConversationDelete } from "./operationProposal";
import { restoredJobReferences, withRestoredJobReferences } from "./restoredJobReferences";
import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { UIMessage } from "ai";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { resolveChatCreationLock } from "./chatConversationLock";
import {
  deriveConversationTitle,
  firstUserMessageText,
  parseConversationContext,
  serializeConversationContext,
  titleFallbackFromMessages,
  type AgentConversationContextV1,
} from "./conversationContext";
import type { ExplicitModelSelection } from "./chatTypes";
import type { AgentRole } from "./agentRoles";

/**
 * ChatConversation persistence.
 *
 * A user owns many conversations. Every read and write is scoped by
 * conversation id AND userId. Creation resolves the AI lock once; later
 * writes touch messages or context only.
 *
 * The old userId-unique create race is gone: two creates are two
 * conversations. Existing transcripts use request-owned revision CAS and
 * never rewrite the lock.
 */
export type ChatConversationRow = Prisma.ChatConversationGetPayload<{
  select: {
    executionPath: true;
    nativeInitializationState: true;
    chatMode: true;
    activeRole: true;
    revision: true;
    id: true;
    userId: true;
    title: true;
    context: true;
    messages: true;
    resolvedConnectionId: true;
    resolvedModel: true;
    managedAiProvenance: true;
    agentRole: true;
    agentTaskId: true;
    archivedAt: true;
    createdAt: true;
    updatedAt: true;
  };
}>;

const CHAT_ROW_SELECT = {
  executionPath: true,
  nativeInitializationState: true,
  chatMode: true,
  activeRole: true,
  revision: true,
  id: true,
  userId: true,
  title: true,
  context: true,
  messages: true,
  resolvedConnectionId: true,
  resolvedModel: true,
  managedAiProvenance: true,
  agentRole: true,
  agentTaskId: true,
  archivedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

const SUMMARY_SELECT = {
  id: true,
  title: true,
  messages: true,
  agentRole: true,
  chatMode: true,
  activeRole: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class ChatConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found");
    this.name = "ChatConversationNotFoundError";
  }
}

export class ChatConversationArchivedError extends Error {
  constructor() {
    super("Conversation is archived");
    this.name = "ChatConversationArchivedError";
  }
}

function serializeMessages(messages: UIMessage[]): string {
  return JSON.stringify(messages);
}

export async function getOwnedChatConversation(
  userId: string,
  conversationId: string,
): Promise<ChatConversationRow | null> {
  if (!conversationId) return null;
  const row = await prisma.chatConversation.findFirst({
    where: { id: conversationId, userId },
    select: CHAT_ROW_SELECT,
  });
  return row ? { ...row, messages: decodeHistory(row.messages) } : null;
}

export async function listOwnedChatConversations(
  userId: string,
  limit = APP_CONSTANTS.AGENT_CHAT_HISTORY_PAGE,
): Promise<
  Array<{
    id: string;
    title: string | null;
    titleFallback: string | null;
    agentRole: string | null;
    chatMode: string;
    activeRole: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  const rows = await prisma.chatConversation.findMany({
    where: { userId, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: SUMMARY_SELECT,
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    titleFallback: row.title ? null : titleFallbackFromMessages(decodeHistory(row.messages)),
    agentRole: row.agentRole,
    chatMode: row.chatMode,
    activeRole: row.activeRole,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getNewestOwnedChatConversation(
  userId: string,
): Promise<ChatConversationRow | null> {
  const row = await prisma.chatConversation.findFirst({
    where: { userId, archivedAt: null },
    orderBy: { updatedAt: "desc" },
    select: CHAT_ROW_SELECT,
  });
  return row ? { ...row, messages: decodeHistory(row.messages) } : null;
}

export async function createChatConversationRecord(input: {
  executionPath?: "APP_ORCHESTRATED" | "NATIVE_CODEX_V1";
  chatMode?: "UNIFIED" | "LEGACY_ROLE_BOUND";
  userId: string;
  messages: UIMessage[];
  context: AgentConversationContextV1;
  explicit?: ExplicitModelSelection | null;
  firstUserText?: string | null;
  /** Role fixed at creation — immutable for the row's lifetime. */
  agentRole?: AgentRole | null;
  /** Initial sticky activeRole for unified sessions. */
  activeRole?: AgentRole | null;
  /**
   * Binds the new row to an owned agent task (resumeAgentTask only; the
   * caller has already verified ownership). Requires a Pilot role.
   */
  agentTaskId?: string | null;
  /** Injected for tests; production uses the default Hosted client. */
  managedClient?: import("@/lib/ai/managed-client").HostedManagedClient;
}): Promise<ChatConversationRow> {
  // The id is allocated before the lock resolves: a Managed assignment
  // first-binds `conversation:<id>` through the Hosted authority and the
  // row persists that binding in the same create.
  const conversationId = randomUUID();
  const chatMode = input.chatMode ?? "LEGACY_ROLE_BOUND";
  // Unified conversations resolve & lock per-step models at Turn entry (D07)
  // unless an explicit model/native lock was specifically requested.
  const lock =
    chatMode === "UNIFIED" && !input.explicit && input.executionPath !== NATIVE_PATH
      ? { resolvedConnectionId: null, resolvedModel: null, managedAiProvenance: null }
      : await resolveChatCreationLock(input.userId, input.explicit, {
          resourceKey: `conversation:${conversationId}`,
          managedClient: input.managedClient,
        });
  if (input.executionPath !== undefined && ![APP_PATH, NATIVE_PATH].includes(input.executionPath)) throw new Error("Invalid execution path");
  if (input.executionPath === NATIVE_PATH) {
    if (!lock.resolvedConnectionId || !lock.resolvedModel || input.messages.length || input.context.items.length) throw new Error("Native sessions start with an empty plain-text conversation");
    await nativeReadiness(input.userId, lock.resolvedConnectionId, lock.resolvedModel);
  }
  const firstUserText =
    input.firstUserText ?? firstUserMessageText(input.messages);
  const title = deriveConversationTitle({
    context: input.context,
    firstUserText,
  });
  return prisma.chatConversation.create({
    data: {
      id: conversationId,
      executionPath: input.executionPath ?? APP_PATH,
      chatMode,
      activeRole: input.activeRole ?? input.agentRole ?? (chatMode === "UNIFIED" ? "pilot" : null),
      userId: input.userId,
      title,
      context: serializeConversationContext(input.context),
      messages: serializeMessages(input.messages),
      resolvedConnectionId: lock.resolvedConnectionId,
      resolvedModel: lock.resolvedModel,
      managedAiProvenance: lock.managedAiProvenance ?? null,
      agentRole: chatMode === "UNIFIED" ? null : (input.agentRole ?? null),
      ...(input.agentTaskId ? { agentTaskId: input.agentTaskId } : {}),
    },
    select: CHAT_ROW_SELECT,
  });
}

/**
 * Reject the former full-snapshot write API. Existing transcripts can only
 * change through request admission, tool checkpoint, finish, or cancellation.
 */
export async function updateChatConversationMessages(
  userId: string,
  conversationId: string,
  messages: UIMessage[],
): Promise<ChatConversationRow> {
  // Existing-row snapshot replacement is forbidden. Execution uses the
  // request-owned CAS helpers; seed snapshots belong to creation only.
  void userId; void conversationId; void messages;
  throw new ConversationRequestError("CONVERSATION_TURN_CONFLICT");
}

export async function updateOwnedChatConversationContext(
  userId: string,
  conversationId: string,
  context: AgentConversationContextV1,
): Promise<ChatConversationRow> {
  const previous = await getOwnedChatConversation(userId, conversationId);
  if (!previous) throw new ChatConversationNotFoundError();
  const updated = await prisma.chatConversation.updateMany({
    where: { id: conversationId, userId, archivedAt: null, context: previous.context },
    data: { context: withRestoredJobReferences(
      serializeConversationContext({ ...context, permissionMode: permissionModeOfContext(previous.context) }), restoredJobReferences(previous.context),
    ) },
  });
  if (updated.count !== 1) {
    const existing = await prisma.chatConversation.findFirst({
      where: { id: conversationId, userId },
      select: { archivedAt: true },
    });
    if (!existing) throw new ChatConversationNotFoundError();
    if (!existing.archivedAt) throw new ConversationRequestError("CONVERSATION_TURN_CONFLICT");
    throw new ChatConversationArchivedError();
  }
  const row = await getOwnedChatConversation(userId, conversationId);
  if (!row) throw new ChatConversationNotFoundError();
  return row;
}

/**
 * Reversible archive — removes the conversation from History and every AI
 * read path. The active-request lock is released in the same CAS so an
 * in-flight or stranded request cannot pin the row or block the restore;
 * the request's own CAS then fails harmlessly on revision/activeRequestId.
 * Idempotent: archiving an already-archived row is a success no-op.
 */
export async function archiveOwnedChatConversation(
  userId: string,
  conversationId: string,
): Promise<ChatConversationRow> {
  const updated = await prisma.chatConversation.updateMany({
    where: { id: conversationId, userId, archivedAt: null },
    data: {
      archivedAt: new Date(),
      activeRequestId: null,
      activeRequestExpiresAt: null,
    },
  });
  if (updated.count !== 1) {
    const existing = await prisma.chatConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!existing) throw new ChatConversationNotFoundError();
  }
  const row = await getOwnedChatConversation(userId, conversationId);
  if (!row) throw new ChatConversationNotFoundError();
  return row;
}

/** Reverse of archiveOwnedChatConversation. Idempotent the same way. */
export async function unarchiveOwnedChatConversation(
  userId: string,
  conversationId: string,
): Promise<ChatConversationRow> {
  const updated = await prisma.chatConversation.updateMany({
    where: { id: conversationId, userId, archivedAt: { not: null } },
    data: { archivedAt: null },
  });
  if (updated.count !== 1) {
    const existing = await prisma.chatConversation.findFirst({
      where: { id: conversationId, userId },
      select: { id: true },
    });
    if (!existing) throw new ChatConversationNotFoundError();
  }
  const row = await getOwnedChatConversation(userId, conversationId);
  if (!row) throw new ChatConversationNotFoundError();
  return row;
}

/** Archive Center listing: archived conversations only. */
export async function listArchivedChatConversations(
  userId: string,
  search?: string,
  limit = APP_CONSTANTS.AGENT_CHAT_HISTORY_PAGE,
): Promise<
  Array<{
    id: string;
    title: string | null;
    titleFallback: string | null;
    agentRole: string | null;
    archivedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  const q = search?.trim();
  const rows: Pick<ChatConversationRow, "id" | "title" | "messages" | "agentRole" | "archivedAt" | "createdAt" | "updatedAt">[] = [];
  let cursor: string | undefined;
  do {
    const page = await prisma.chatConversation.findMany({
      where: { userId, archivedAt: { not: null } },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: q ? 100 : limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { ...SUMMARY_SELECT, archivedAt: true },
    });
    for (const row of page) {
      if (!q || `${row.title ?? ""} ${decodeHistory(row.messages)}`.toLocaleLowerCase().includes(q.toLocaleLowerCase())) rows.push(row);
      if (rows.length >= limit) break;
    }
    if (!q || page.length < 100 || rows.length >= limit) break;
    cursor = page[page.length - 1].id;
  } while (true);
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    titleFallback: row.title ? null : titleFallbackFromMessages(decodeHistory(row.messages)),
    agentRole: row.agentRole,
    archivedAt: row.archivedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function deleteOwnedChatConversation(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  // Proposals share the same commit boundary as the delete: undecided and
  // approved-but-undispatched operations are withdrawn/cancelled atomically
  // with the row; dispatched and terminal rows keep their evidence via
  // conversationId SetNull.
  const deleted = await prisma.$transaction(async (tx) => {
    await prepareConversationDelete(tx, { userId, conversationId });
    const removed = await tx.chatConversation.deleteMany({
      where: { id: conversationId, userId },
    });
    return removed.count;
  });
  return deleted === 1;
}

export function contextOfRow(row: {
  context: string | null;
}): AgentConversationContextV1 {
  return parseConversationContext(row.context);
}

import "server-only";

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

/**
 * ChatConversation persistence.
 *
 * A user owns many conversations. Every read and write is scoped by
 * conversation id AND userId. Creation resolves the AI lock once; later
 * writes touch messages or context only.
 *
 * The old userId-unique create race is gone: two creates are two
 * conversations. Updates still replace the transcript of one owned row
 * and never rewrite the lock.
 */
export type ChatConversationRow = Prisma.ChatConversationGetPayload<{
  select: {
    id: true;
    userId: true;
    title: true;
    context: true;
    messages: true;
    resolvedConnectionId: true;
    resolvedModel: true;
    createdAt: true;
    updatedAt: true;
  };
}>;

const CHAT_ROW_SELECT = {
  id: true,
  userId: true,
  title: true,
  context: true,
  messages: true,
  resolvedConnectionId: true,
  resolvedModel: true,
  createdAt: true,
  updatedAt: true,
} as const;

const SUMMARY_SELECT = {
  id: true,
  title: true,
  messages: true,
  createdAt: true,
  updatedAt: true,
} as const;

export class ChatConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found");
    this.name = "ChatConversationNotFoundError";
  }
}

function serializeMessages(messages: UIMessage[]): string {
  return JSON.stringify(
    messages.slice(-APP_CONSTANTS.AGENT_CHAT_MAX_STORED_MESSAGES),
  );
}

export async function getOwnedChatConversation(
  userId: string,
  conversationId: string,
): Promise<ChatConversationRow | null> {
  if (!conversationId) return null;
  return prisma.chatConversation.findFirst({
    where: { id: conversationId, userId },
    select: CHAT_ROW_SELECT,
  });
}

export async function listOwnedChatConversations(
  userId: string,
  limit = APP_CONSTANTS.AGENT_CHAT_HISTORY_PAGE,
): Promise<
  Array<{
    id: string;
    title: string | null;
    titleFallback: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>
> {
  const rows = await prisma.chatConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: SUMMARY_SELECT,
  });
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    titleFallback: row.title ? null : titleFallbackFromMessages(row.messages),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }));
}

export async function getNewestOwnedChatConversation(
  userId: string,
): Promise<ChatConversationRow | null> {
  return prisma.chatConversation.findFirst({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: CHAT_ROW_SELECT,
  });
}

export async function createChatConversationRecord(input: {
  userId: string;
  messages: UIMessage[];
  context: AgentConversationContextV1;
  explicit?: ExplicitModelSelection | null;
  firstUserText?: string | null;
}): Promise<ChatConversationRow> {
  const lock = await resolveChatCreationLock(input.userId, input.explicit);
  const firstUserText =
    input.firstUserText ?? firstUserMessageText(input.messages);
  const title = deriveConversationTitle({
    context: input.context,
    firstUserText,
  });
  return prisma.chatConversation.create({
    data: {
      userId: input.userId,
      title,
      context: serializeConversationContext(input.context),
      messages: serializeMessages(input.messages),
      resolvedConnectionId: lock.resolvedConnectionId,
      resolvedModel: lock.resolvedModel,
    },
    select: CHAT_ROW_SELECT,
  });
}

/**
 * Replace the transcript of one owned conversation. Lock columns are not
 * in the write. A missing or foreign id throws.
 */
export async function updateChatConversationMessages(
  userId: string,
  conversationId: string,
  messages: UIMessage[],
): Promise<ChatConversationRow> {
  const serialized = serializeMessages(messages);
  const updated = await prisma.chatConversation.updateMany({
    where: { id: conversationId, userId },
    data: { messages: serialized },
  });
  if (updated.count !== 1) throw new ChatConversationNotFoundError();
  const row = await getOwnedChatConversation(userId, conversationId);
  if (!row) throw new ChatConversationNotFoundError();
  return row;
}

export async function updateOwnedChatConversationContext(
  userId: string,
  conversationId: string,
  context: AgentConversationContextV1,
): Promise<ChatConversationRow> {
  const updated = await prisma.chatConversation.updateMany({
    where: { id: conversationId, userId },
    data: { context: serializeConversationContext(context) },
  });
  if (updated.count !== 1) throw new ChatConversationNotFoundError();
  const row = await getOwnedChatConversation(userId, conversationId);
  if (!row) throw new ChatConversationNotFoundError();
  return row;
}

export async function deleteOwnedChatConversation(
  userId: string,
  conversationId: string,
): Promise<boolean> {
  const deleted = await prisma.chatConversation.deleteMany({
    where: { id: conversationId, userId },
  });
  return deleted.count === 1;
}

export function contextOfRow(row: {
  context: string | null;
}): AgentConversationContextV1 {
  return parseConversationContext(row.context);
}

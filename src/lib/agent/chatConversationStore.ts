import "server-only";

import { Prisma } from "@prisma/client";
import type { UIMessage } from "ai";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { resolveChatCreationLock } from "./chatConversationLock";

/**
 * ChatConversation persistence — the single write path for the career
 * dialogue transcript.
 *
 * Creation-time lock semantics: the resolvedConnectionId/resolvedModel pair
 * is decided once inside the create (resolveChatCreationLock) and is part of
 * the same write as the first persisted messages — a locked execution can
 * therefore never outrun its own lock row. The update path touches `messages`
 * only; lock columns are creation-time state.
 *
 * Concurrent first turns: two requests can both observe "no row" and race
 * the create. The loser hits the userId unique constraint, re-reads the
 * canonical row and adopts ITS lock — one conversation, one lock.
 */
export type ChatConversationRow = Prisma.ChatConversationGetPayload<{
  select: {
    id: true;
    userId: true;
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
  messages: true,
  resolvedConnectionId: true,
  resolvedModel: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function getChatConversationRow(
  userId: string,
): Promise<ChatConversationRow | null> {
  return prisma.chatConversation.findUnique({
    where: { userId },
    select: CHAT_ROW_SELECT,
  });
}

function serializeMessages(messages: UIMessage[]): string {
  return JSON.stringify(
    messages.slice(-APP_CONSTANTS.AGENT_CHAT_MAX_STORED_MESSAGES),
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

/**
 * Upsert the transcript. On create the creation-time AI lock is resolved
 * and stored in the same write; on update only `messages` changes. Returns
 * the canonical row — under a create race this is the WINNER's row, whose
 * lock the caller must honor even if it resolved a different pair itself.
 */
export async function persistChatMessages(
  userId: string,
  messages: UIMessage[],
): Promise<ChatConversationRow> {
  const serialized = serializeMessages(messages);
  const existing = await prisma.chatConversation.findUnique({
    where: { userId },
    select: CHAT_ROW_SELECT,
  });
  if (existing) {
    return prisma.chatConversation.update({
      where: { userId },
      data: { messages: serialized },
      select: CHAT_ROW_SELECT,
    });
  }

  const lock = await resolveChatCreationLock(userId);
  try {
    return await prisma.chatConversation.create({
      data: {
        userId,
        messages: serialized,
        resolvedConnectionId: lock.resolvedConnectionId,
        resolvedModel: lock.resolvedModel,
      },
      select: CHAT_ROW_SELECT,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost the create race — the winner's row (and lock) is canonical.
    // Merge rather than overwrite: both first turns wrote-on-receipt, so a
    // blind update would drop the winner's message.
    const canonical = await prisma.chatConversation.findUnique({
      where: { userId },
      select: CHAT_ROW_SELECT,
    });
    if (!canonical) throw error;
    let merged = serialized;
    try {
      const theirs = JSON.parse(canonical.messages) as UIMessage[];
      const seen = new Set(theirs.map((m) => m.id));
      const ours = (JSON.parse(serialized) as UIMessage[]).filter(
        (m) => !seen.has(m.id),
      );
      merged = JSON.stringify(
        [...theirs, ...ours].slice(
          -APP_CONSTANTS.AGENT_CHAT_MAX_STORED_MESSAGES,
        ),
      );
    } catch {
      // Corrupt stored JSON — keep our well-formed write.
    }
    return prisma.chatConversation.update({
      where: { userId },
      data: { messages: merged },
      select: CHAT_ROW_SELECT,
    });
  }
}

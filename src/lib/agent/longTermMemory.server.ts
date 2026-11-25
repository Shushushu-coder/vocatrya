import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { loadAgentPreferences } from "./preferences.server";
import {
  LONG_TERM_MEMORY_BLOCK_TOKENS,
  USER_MEMORY_CATEGORIES,
  USER_MEMORY_MAX_ENTRIES,
  isUserMemoryCategory,
  longTermMemoryBlock,
  validateUserMemoryEntry,
  type UserMemoryCategory,
  type UserMemoryEntryDTO,
} from "./longTermMemory";

export class UserMemoryConflictError extends Error {
  constructor() {
    super("A memory entry already exists for this category and key.");
    this.name = "UserMemoryConflictError";
  }
}

type MemoryRow = {
  id: string;
  category: string;
  key: string;
  content: string;
  sourceConversationId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDTO(row: MemoryRow): UserMemoryEntryDTO {
  return {
    id: row.id,
    category: isUserMemoryCategory(row.category) ? row.category : "collaboration_habit",
    key: row.key,
    content: row.content,
    sourceConversationId: row.sourceConversationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const orderBy = [{ category: "asc" as const }, { key: "asc" as const }];

/** Cap enforcement: after any write, evict the least-recently-updated rows. */
async function enforceMemoryCap(userId: string, tx: Prisma.TransactionClient | PrismaClient = prisma) {
  const overflow = await tx.userMemoryEntry.findMany({
    where: { userId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    skip: USER_MEMORY_MAX_ENTRIES,
    select: { id: true },
  });
  if (overflow.length > 0) {
    await tx.userMemoryEntry.deleteMany({
      where: { userId, id: { in: overflow.map((row) => row.id) } },
    });
  }
}

export async function listUserMemoryEntries(userId: string): Promise<UserMemoryEntryDTO[]> {
  const rows = await prisma.userMemoryEntry.findMany({
    where: { userId },
    orderBy,
  });
  return rows.map(toDTO);
}

export async function upsertUserMemoryEntry(input: {
  userId: string;
  category: string;
  key: string;
  content: string;
  sourceConversationId?: string | null;
}): Promise<UserMemoryEntryDTO> {
  const valid = validateUserMemoryEntry(input);
  if (!valid.ok) throw new Error(`Invalid memory entry: ${valid.issue}`);
  const row = await prisma.$transaction(async (tx) => {
    const saved = await tx.userMemoryEntry.upsert({
      where: {
        userId_category_key: {
          userId: input.userId,
          category: valid.category,
          key: valid.key,
        },
      },
      create: {
        userId: input.userId,
        category: valid.category,
        key: valid.key,
        content: valid.content,
        sourceConversationId: input.sourceConversationId ?? null,
      },
      update: {
        content: valid.content,
        // A refresh stamps a new source only when one is provided — an
        // extracted overwrite keeps its original provenance otherwise.
        ...(input.sourceConversationId !== undefined
          ? { sourceConversationId: input.sourceConversationId }
          : {}),
      },
    });
    await enforceMemoryCap(input.userId, tx);
    return saved;
  });
  return toDTO(row);
}

export async function updateUserMemoryEntry(input: {
  userId: string;
  id: string;
  category?: string;
  key?: string;
  content?: string;
}): Promise<UserMemoryEntryDTO> {
  const existing = await prisma.userMemoryEntry.findFirst({
    where: { id: input.id, userId: input.userId },
  });
  if (!existing) throw new Error("Memory entry not found.");
  const merged = {
    category: input.category ?? existing.category,
    key: input.key ?? existing.key,
    content: input.content ?? existing.content,
  };
  const valid = validateUserMemoryEntry(merged);
  if (!valid.ok) throw new Error(`Invalid memory entry: ${valid.issue}`);
  const conflict = await prisma.userMemoryEntry.findFirst({
    where: {
      userId: input.userId,
      category: valid.category,
      key: valid.key,
      id: { not: input.id },
    },
    select: { id: true },
  });
  if (conflict) throw new UserMemoryConflictError();
  const row = await prisma.userMemoryEntry.update({
    where: { id: input.id },
    data: { category: valid.category, key: valid.key, content: valid.content },
  });
  return toDTO(row);
}

export async function deleteUserMemoryEntry(input: { userId: string; id: string }): Promise<boolean> {
  const result = await prisma.userMemoryEntry.deleteMany({
    where: { id: input.id, userId: input.userId },
  });
  return result.count === 1;
}

export async function clearUserMemoryEntries(userId: string): Promise<number> {
  const result = await prisma.userMemoryEntry.deleteMany({ where: { userId } });
  return result.count;
}

/** Internal load for injection — valid rows only, stable ordering. */
async function loadRenderableEntries(userId: string) {
  const rows = await prisma.userMemoryEntry.findMany({
    where: { userId },
    orderBy,
    select: { category: true, key: true, content: true },
  });
  return rows.filter((row) => isUserMemoryCategory(row.category));
}

/**
 * Managed-path memory line: honors the master switch, renders the
 * untrusted-preference block capped at the shared 700-token budget.
 */
export async function loadLongTermMemoryLine(userId: string): Promise<string> {
  const preferences = await loadAgentPreferences(userId);
  if (!preferences.longTermMemoryEnabled) return "";
  const entries = await loadRenderableEntries(userId);
  return longTermMemoryBlock(entries, { maxTokens: LONG_TERM_MEMORY_BLOCK_TOKENS });
}

/**
 * Native-path memory line — the freeze contract.
 *
 * A native Codex thread keeps the developer instructions it was created
 * with (the prompt hash rejects changes). The block used at creation is
 * persisted on the conversation row and read back verbatim for every turn
 * of that thread: a mid-thread memory change must neither invalidate the
 * binding nor silently diverge from what the native runtime actually saw.
 * For a conversation whose binding does not exist yet (initialization in
 * flight or first turn), the current block is computed and frozen now.
 */
export async function nativeMemoryBlockForConversation(
  userId: string,
  conversationId: string,
): Promise<string> {
  const row = await prisma.chatConversation.findFirst({
    where: { id: conversationId, userId },
    select: { nativeMemoryBlock: true },
  });
  if (!row) return "";
  const binding = await prisma.nativeConversationBinding.findUnique({
    where: { conversationId },
    select: { conversationId: true },
  });
  if (binding) return row.nativeMemoryBlock ?? "";
  const block = await loadLongTermMemoryLine(userId);
  if ((row.nativeMemoryBlock ?? "") !== block) {
    await prisma.chatConversation.updateMany({
      where: { id: conversationId, userId },
      data: { nativeMemoryBlock: block || null },
    });
  }
  return block;
}

export const USER_MEMORY_CATEGORY_ORDER = USER_MEMORY_CATEGORIES;
export type { UserMemoryCategory };

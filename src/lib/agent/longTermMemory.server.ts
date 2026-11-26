import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { loadAgentPreferences } from "./preferences.server";
import {
  LONG_TERM_MEMORY_BLOCK_TOKENS,
  USER_MEMORY_CAREER_PREFERENCE_CATEGORIES,
  USER_MEMORY_CATEGORIES,
  USER_MEMORY_CORE_CATEGORIES,
  USER_MEMORY_CORE_CATEGORY_FLOOR,
  USER_MEMORY_MAX_ENTRIES,
  isUserMemoryCategory,
  isUserMemorySource,
  longTermMemoryBlock,
  normalizeMemoryKey,
  validateUserMemoryEntry,
  type MemoryCurationAction,
  type UserMemoryCategory,
  type UserMemoryEntryDTO,
  type UserMemorySource,
} from "./longTermMemory";

export class UserMemoryConflictError extends Error {
  constructor() {
    super("A memory entry already exists for this category and key.");
    this.name = "UserMemoryConflictError";
  }
}

export class UserMemoryStoreFullError extends Error {
  constructor() {
    super("The memory store is full. Delete some entries first.");
    this.name = "UserMemoryStoreFullError";
  }
}

type MemoryRow = {
  id: string;
  category: string;
  key: string;
  content: string;
  source: string;
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
    // An unrecognized provenance reads as the protected side, never the
    // curatable one — forward-compatible with any future source value.
    source: isUserMemorySource(row.source) ? row.source : "USER_MANUAL",
    sourceConversationId: row.sourceConversationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const orderBy = [{ category: "asc" as const }, { key: "asc" as const }];

/**
 * Cap enforcement (M2.1): eviction selects AI_EXTRACTED rows only — a
 * user-authored entry is never silently dropped by a background write.
 * Each core category keeps its newest FLOOR entries ahead of every other
 * candidate; beyond that, eviction is least-recently-updated first.
 * If no evictable row remains (a store of manual entries) the caller's
 * write decides what to do — this function never touches manual rows.
 */
async function enforceMemoryCap(
  userId: string,
  tx: Prisma.TransactionClient | PrismaClient = prisma,
): Promise<void> {
  const rows = await tx.userMemoryEntry.findMany({
    where: { userId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, category: true, source: true, updatedAt: true },
  });
  const overflow = rows.length - USER_MEMORY_MAX_ENTRIES;
  if (overflow <= 0) return;

  const protectedIds = new Set<string>();
  for (const core of USER_MEMORY_CORE_CATEGORIES) {
    for (const row of rows.filter((r) => r.category === core).slice(0, USER_MEMORY_CORE_CATEGORY_FLOOR)) {
      protectedIds.add(row.id);
    }
  }
  const byAgeAsc = (a: { updatedAt: Date; id: string }, b: { updatedAt: Date; id: string }) =>
    a.updatedAt.getTime() - b.updatedAt.getTime() || (a.id < b.id ? -1 : 1);
  const candidates = rows.filter((r) => r.source === "AI_EXTRACTED");
  const evictOrder = [
    ...candidates.filter((r) => !protectedIds.has(r.id)).sort(byAgeAsc),
    // Even a floor-protected row yields when nothing else can — the cap
    // is a hard bound, not a soft preference.
    ...candidates.filter((r) => protectedIds.has(r.id)).sort(byAgeAsc),
  ];
  const evictIds = evictOrder.slice(0, overflow).map((r) => r.id);
  if (evictIds.length > 0) {
    await tx.userMemoryEntry.deleteMany({
      where: { userId, id: { in: evictIds } },
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

/**
 * The user write path — settings page add/edit. Every save lands as
 * USER_MANUAL (locked): overwriting an AI_EXTRACTED row by hand converts
 * it, and a brand-new row is manual from birth. When the store is full of
 * locked rows a new manual write fails honestly instead of silently
 * evicting one.
 */
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
    const existing = await tx.userMemoryEntry.findUnique({
      where: {
        userId_category_key: {
          userId: input.userId,
          category: valid.category,
          key: valid.key,
        },
      },
      select: { id: true },
    });
    if (!existing) {
      const [total, aiCount] = await Promise.all([
        tx.userMemoryEntry.count({ where: { userId: input.userId } }),
        tx.userMemoryEntry.count({ where: { userId: input.userId, source: "AI_EXTRACTED" } }),
      ]);
      if (total >= USER_MEMORY_MAX_ENTRIES && aiCount === 0) {
        throw new UserMemoryStoreFullError();
      }
    }
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
        source: "USER_MANUAL",
        sourceConversationId: input.sourceConversationId ?? null,
      },
      update: {
        content: valid.content,
        // A manual save locks the slot: the write flips AI_EXTRACTED to
        // USER_MANUAL so the curator can never undo the user's edit.
        source: "USER_MANUAL",
        // A refresh stamps a new source only when one is provided — an
        // overwrite keeps its original provenance otherwise.
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

/**
 * The AI curation write path (M2.1). Applies one extractor action against
 * the store with the lock contract enforced in code, not just in the
 * prompt: USER_MANUAL rows are never overwritten, merged or removed, and
 * AI rows carry AI_EXTRACTED provenance so they stay curatable.
 */
export async function applyMemoryCurationAction(input: {
  userId: string;
  action: MemoryCurationAction;
  sourceConversationId?: string | null;
}): Promise<{ applied: boolean; reason?: "locked" | "missing" }> {
  const { action } = input;
  const where = {
    userId_category_key: {
      userId: input.userId,
      category: action.category,
      key: action.key,
    },
  };
  return prisma.$transaction(async (tx) => {
    const existing = await tx.userMemoryEntry.findUnique({
      where,
      select: { id: true, source: true },
    });
    if (existing?.source === "USER_MANUAL") {
      return { applied: false, reason: "locked" };
    }
    if (action.action === "remove") {
      if (!existing) return { applied: false, reason: "missing" };
      await tx.userMemoryEntry.delete({ where: { id: existing.id } });
      return { applied: true };
    }
    await tx.userMemoryEntry.upsert({
      where,
      create: {
        userId: input.userId,
        category: action.category,
        key: action.key,
        content: action.content,
        source: "AI_EXTRACTED",
        sourceConversationId: input.sourceConversationId ?? null,
      },
      update: {
        content: action.content,
        ...(input.sourceConversationId !== undefined
          ? { sourceConversationId: input.sourceConversationId }
          : {}),
      },
    });
    // A new AI row over a full store sheds other AI_EXTRACTED rows via the
    // floor policy; when nothing is evictable it is itself the candidate
    // and the write degrades to a no-op — never a manual row.
    await enforceMemoryCap(input.userId, tx);
    return { applied: true };
  });
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
    data: { category: valid.category, key: valid.key, content: valid.content, source: "USER_MANUAL" },
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

/** The rendered injection block for the store's current entries. */
async function renderMemoryBlock(userId: string): Promise<string> {
  const entries = await loadRenderableEntries(userId);
  return longTermMemoryBlock(entries, { maxTokens: LONG_TERM_MEMORY_BLOCK_TOKENS });
}

/**
 * Managed-path memory line: honors the master switch, renders the
 * untrusted-preference block capped at the shared 700-token budget.
 */
export async function loadLongTermMemoryLine(userId: string): Promise<string> {
  const preferences = await loadAgentPreferences(userId);
  if (!preferences.longTermMemoryEnabled) return "";
  return renderMemoryBlock(userId);
}

/**
 * Managed-path session freeze (M2.1).
 *
 * One conversation's memory block is computed on its first managed turn
 * and read back verbatim afterwards: background extraction must not
 * mutate the next turn's prefix (provider prefix-cache protection).
 * Refresh happens only on three events — a new session, an L2 auto/manual
 * compaction commit, and the user's own memory writes in settings — all
 * of which already change the assembled prefix for other reasons.
 * The master switch still gates live: switching memory off stops
 * injection immediately regardless of the frozen value.
 */
export async function managedMemoryBlockForConversation(
  userId: string,
  conversationId: string,
): Promise<string> {
  const preferences = await loadAgentPreferences(userId);
  if (!preferences.longTermMemoryEnabled) return "";
  const row = await prisma.chatConversation.findFirst({
    where: { id: conversationId, userId },
    select: { managedMemoryBlock: true },
  });
  if (!row) return "";
  if (row.managedMemoryBlock !== null) return row.managedMemoryBlock;
  const block = await renderMemoryBlock(userId);
  // First freeze wins — a concurrent user-side refresh must not be
  // clobbered back to a pre-edit snapshot by a racing first turn.
  await prisma.chatConversation.updateMany({
    where: { id: conversationId, userId, managedMemoryBlock: null },
    data: { managedMemoryBlock: block || null },
  });
  return block;
}

/** Recompute and re-freeze one conversation's managed memory block. */
export async function refreshManagedMemoryBlockForConversation(
  userId: string,
  conversationId: string,
): Promise<void> {
  const preferences = await loadAgentPreferences(userId);
  const block = preferences.longTermMemoryEnabled ? await renderMemoryBlock(userId) : "";
  await prisma.chatConversation.updateMany({
    where: { id: conversationId, userId },
    data: { managedMemoryBlock: block || null },
  });
}

/**
 * Recompute and re-freeze the managed memory block for every conversation
 * the user owns. Called on user memory writes (add/edit/delete/clear) and
 * the master-switch toggle — the events the freeze contract names.
 */
export async function refreshManagedMemoryBlocksForUser(userId: string): Promise<number> {
  const preferences = await loadAgentPreferences(userId);
  const block = preferences.longTermMemoryEnabled ? await renderMemoryBlock(userId) : "";
  const result = await prisma.chatConversation.updateMany({
    where: { userId },
    data: { managedMemoryBlock: block || null },
  });
  return result.count;
}

/**
 * M2.2 read-only seam — agreed consumer contract.
 *
 * Returns the user's career_goal + industry_preference entries for the
 * match_job / today_plan "conversation-settled preference" fallback.
 * Read-only: callers render these as supplementary context labeled as
 * conversation-derived, and JobSearchPreference stays authoritative on
 * conflict — this store must never be written back by consumers.
 */
export async function listCareerPreferenceMemory(userId: string): Promise<UserMemoryEntryDTO[]> {
  const preferences = await loadAgentPreferences(userId);
  if (!preferences.longTermMemoryEnabled) return [];
  const rows = await prisma.userMemoryEntry.findMany({
    where: { userId, category: { in: [...USER_MEMORY_CAREER_PREFERENCE_CATEGORIES] } },
    orderBy,
  });
  return rows.map(toDTO);
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
export { normalizeMemoryKey };
export type { MemoryCurationAction, UserMemorySource };

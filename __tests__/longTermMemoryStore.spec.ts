// @vitest-environment node
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

import {
  applyMemoryCurationAction,
  clearUserMemoryEntries,
  deleteUserMemoryEntry,
  listCareerPreferenceMemory,
  listUserMemoryEntries,
  loadLongTermMemoryLine,
  managedMemoryBlockForConversation,
  nativeMemoryBlockForConversation,
  refreshManagedMemoryBlockForConversation,
  refreshManagedMemoryBlocksForUser,
  updateUserMemoryEntry,
  upsertUserMemoryEntry,
  UserMemoryConflictError,
  UserMemoryStoreFullError,
} from "@/lib/agent/longTermMemory.server";
import { USER_MEMORY_MAX_ENTRIES } from "@/lib/agent/longTermMemory";

const aiRow = (over: Record<string, unknown>) => ({
  userId,
  source: "AI_EXTRACTED",
  ...over,
});

async function seedEntries(
  rows: Array<{ category: string; key: string; content: string; source?: string; updatedAt?: Date }>,
) {
  for (const row of rows) {
    await prisma.userMemoryEntry.create({ data: aiRow(row) as never });
  }
}

let userId: string;
let otherUserId: string;

beforeAll(async () => {
  userId = await seedAccount(prisma, "memory-owner@example.com");
  otherUserId = await seedAccount(prisma, "memory-other@example.com");
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

describe("user memory store (isolated SQLite)", () => {
  it("creates, lists, overwrites by (category, key) and deletes", async () => {
    const created = await upsertUserMemoryEntry({
      userId,
      category: "career_goal",
      key: "target_cities",
      content: "上海",
    });
    expect(created.key).toBe("target_cities");

    // Same dedupe slot overwrites in place — one row, new content.
    const updated = await upsertUserMemoryEntry({
      userId,
      category: "career_goal",
      key: "Target Cities",
      content: "上海、杭州",
    });
    const entries = await listUserMemoryEntries(userId);
    expect(entries.filter((e) => e.category === "career_goal" && e.key === "target_cities")).toHaveLength(1);
    expect(entries[0].content).toBe("上海、杭州");
    expect(updated.id).toBe(created.id);

    // Cross-user isolation: other users see nothing and cannot touch it.
    expect(await listUserMemoryEntries(otherUserId)).toHaveLength(0);
    expect(await deleteUserMemoryEntry({ userId: otherUserId, id: created.id })).toBe(false);
    await expect(
      updateUserMemoryEntry({ userId: otherUserId, id: created.id, content: "evil" }),
    ).rejects.toThrow(/not found/i);

    expect(await deleteUserMemoryEntry({ userId, id: created.id })).toBe(true);
    expect(await listUserMemoryEntries(userId)).toHaveLength(0);
  });

  it("rejects invalid content before any write", async () => {
    await expect(
      upsertUserMemoryEntry({ userId, category: "career_goal", key: "k", content: "x".repeat(241) }),
    ).rejects.toThrow(/too-long/);
    await expect(
      upsertUserMemoryEntry({ userId, category: "career_goal", key: "k", content: "sk-abcdef123456" }),
    ).rejects.toThrow(/forbidden/);
    await expect(
      upsertUserMemoryEntry({ userId, category: "career_goal", key: "k", content: "已投递字节跳动" }),
    ).rejects.toThrow(/forbidden/);
    expect(await prisma.userMemoryEntry.count({ where: { userId } })).toBe(0);
  });

  it("enforces the 40-entry cap by evicting the least recently updated", async () => {
    for (let i = 0; i < USER_MEMORY_MAX_ENTRIES + 5; i += 1) {
      await prisma.userMemoryEntry.create({
        data: {
          userId,
          source: "AI_EXTRACTED",
          category: "collaboration_habit",
          key: `habit_${String(i).padStart(2, "0")}`,
          content: `habit ${i}`,
          // Distinct updatedAt makes the eviction order deterministic.
          updatedAt: new Date(2026, 0, 1, 0, 0, i),
        },
      });
    }
    // Cap enforcement runs inside the write path: one more upsert brings
    // the store back down to the limit, evicting the oldest six rows.
    await upsertUserMemoryEntry({
      userId,
      category: "collaboration_habit",
      key: "habit_new",
      content: "newest",
    });
    const entries = await listUserMemoryEntries(userId);
    expect(entries).toHaveLength(USER_MEMORY_MAX_ENTRIES);
    const keys = new Set(entries.map((e) => e.key));
    for (let i = 0; i < 6; i += 1) {
      expect(keys.has(`habit_${String(i).padStart(2, "0")}`)).toBe(false);
    }
    expect(keys.has("habit_44")).toBe(true);
    expect(keys.has("habit_new")).toBe(true);
    await clearUserMemoryEntries(userId);
  });

  it("update enforces uniqueness conflicts", async () => {
    const a = await upsertUserMemoryEntry({ userId, category: "career_goal", key: "a", content: "1" });
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "b", content: "2" });
    await expect(
      updateUserMemoryEntry({ userId, id: a.id, key: "b" }),
    ).rejects.toBeInstanceOf(UserMemoryConflictError);
    await clearUserMemoryEntries(userId);
  });

  it("clear empties the store and reports the count", async () => {
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "cities", content: "上海" });
    await upsertUserMemoryEntry({ userId, category: "industry_preference", key: "avoid", content: "外包" });
    expect(await clearUserMemoryEntries(userId)).toBe(2);
    expect(await listUserMemoryEntries(userId)).toHaveLength(0);
  });
});

describe("memory injection line", () => {
  it("renders the untrusted block by default and nothing when disabled", async () => {
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "cities", content: "上海" });
    const block = await loadLongTermMemoryLine(userId);
    expect(block).toContain("untrusted personal preference notes");
    expect(block).toContain("上海");

    await prisma.userSettings.upsert({
      where: { userId },
      create: {
        userId,
        settings: JSON.stringify({ settings: { general: { agent: { longTermMemoryEnabled: false } } } }),
      },
      update: {
        settings: JSON.stringify({ settings: { general: { agent: { longTermMemoryEnabled: false } } } }),
      },
    });
    expect(await loadLongTermMemoryLine(userId)).toBe("");
    await prisma.userSettings.delete({ where: { userId } });
    await clearUserMemoryEntries(userId);
  });
});

describe("native memory freeze", () => {
  it("freezes the block at creation and never mutates a bound thread", async () => {
    const conversation = await prisma.chatConversation.create({
      data: { userId, messages: "[]" },
    });
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "cities", content: "上海" });

    // First turn, no binding yet: the current block is computed and frozen.
    const first = await nativeMemoryBlockForConversation(userId, conversation.id);
    expect(first).toContain("上海");
    const stored = await prisma.chatConversation.findUniqueOrThrow({
      where: { id: conversation.id },
      select: { nativeMemoryBlock: true },
    });
    expect(stored.nativeMemoryBlock).toBe(first);

    // Binding arrives (native thread created with that exact block).
    await prisma.nativeConversationBinding.create({
      data: {
        conversationId: conversation.id,
        userId,
        connectionId: "conn-1",
        model: "gpt-5.4",
        runtimeVersion: "0.170.0",
        runtimeProfileRef: "rp_1",
        configHash: "cfg_1",
        threadId: "thread_1",
        promptHash: "hash_1",
      },
    });

    // Memory changes mid-thread: the bound thread still gets the frozen block.
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "cities", content: "北京" });
    expect(await nativeMemoryBlockForConversation(userId, conversation.id)).toBe(first);
    await clearUserMemoryEntries(userId);
    expect(await nativeMemoryBlockForConversation(userId, conversation.id)).toBe(first);
  });

  it("a pre-M2 bound thread reads as the empty block", async () => {
    const conversation = await prisma.chatConversation.create({
      data: { userId, messages: "[]" },
    });
    await prisma.nativeConversationBinding.create({
      data: {
        conversationId: conversation.id,
        userId,
        connectionId: "conn-1",
        model: "gpt-5.4",
        runtimeVersion: "0.170.0",
        runtimeProfileRef: "rp_1",
        configHash: "cfg_1",
        threadId: "thread_2",
        promptHash: "hash_2",
      },
    });
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "cities", content: "上海" });
    expect(await nativeMemoryBlockForConversation(userId, conversation.id)).toBe("");
    await clearUserMemoryEntries(userId);
  });
});

describe("memory provenance and locks (M2.1)", () => {
  afterEach(async () => {
    await clearUserMemoryEntries(userId);
  });

  it("manual writes land USER_MANUAL; a manual overwrite locks an AI row", async () => {
    // AI curation writes AI_EXTRACTED.
    const ai = await applyMemoryCurationAction({
      userId,
      action: { action: "upsert", category: "career_goal", key: "target_cities", content: "上海" },
      sourceConversationId: "conv-1",
    });
    expect(ai.applied).toBe(true);
    expect((await listUserMemoryEntries(userId))[0].source).toBe("AI_EXTRACTED");

    // The same slot written by hand flips to the locked side — the
    // curator can never undo the user's edit afterwards.
    const manual = await upsertUserMemoryEntry({
      userId,
      category: "career_goal",
      key: "target_cities",
      content: "上海、杭州",
    });
    expect(manual.source).toBe("USER_MANUAL");
    const lockedUpsert = await applyMemoryCurationAction({
      userId,
      action: { action: "upsert", category: "career_goal", key: "target_cities", content: "北京" },
    });
    expect(lockedUpsert).toEqual({ applied: false, reason: "locked" });
    const lockedRemove = await applyMemoryCurationAction({
      userId,
      action: { action: "remove", category: "career_goal", key: "target_cities" },
    });
    expect(lockedRemove).toEqual({ applied: false, reason: "locked" });
    expect((await listUserMemoryEntries(userId))[0].content).toBe("上海、杭州");
  });

  it("a manual edit locks the row it touches", async () => {
    await applyMemoryCurationAction({
      userId,
      action: { action: "upsert", category: "collaboration_habit", key: "reply_style", content: "简洁" },
    });
    const [row] = await listUserMemoryEntries(userId);
    const edited = await updateUserMemoryEntry({
      userId,
      id: row.id,
      content: "先给结论",
    });
    expect(edited.source).toBe("USER_MANUAL");
  });

  it("curation can upsert, correct and remove AI-extracted rows in place", async () => {
    await applyMemoryCurationAction({
      userId,
      action: { action: "upsert", category: "industry_preference", key: "avoid", content: "外包" },
    });
    const corrected = await applyMemoryCurationAction({
      userId,
      action: { action: "upsert", category: "industry_preference", key: "avoid", content: "外包和小厂" },
    });
    expect(corrected.applied).toBe(true);
    let entries = await listUserMemoryEntries(userId);
    expect(entries).toHaveLength(1);
    expect(entries[0].content).toBe("外包和小厂");
    expect(entries[0].source).toBe("AI_EXTRACTED");

    const removed = await applyMemoryCurationAction({
      userId,
      action: { action: "remove", category: "industry_preference", key: "avoid" },
    });
    expect(removed.applied).toBe(true);
    entries = await listUserMemoryEntries(userId);
    expect(entries).toHaveLength(0);
    const missing = await applyMemoryCurationAction({
      userId,
      action: { action: "remove", category: "industry_preference", key: "avoid" },
    });
    expect(missing).toEqual({ applied: false, reason: "missing" });
  });
});

describe("capacity eviction protection (M2.1)", () => {
  afterEach(async () => {
    await clearUserMemoryEntries(userId);
  });

  it("never evicts a manual row — AI rows shed first", async () => {
    await seedEntries(
      Array.from({ length: USER_MEMORY_MAX_ENTRIES }, (_, i) => ({
        category: "collaboration_habit",
        key: `habit_${String(i).padStart(2, "0")}`,
        content: `habit ${i}`,
        updatedAt: new Date(2026, 0, 1, 0, 0, i),
      })),
    );
    // Two manual writes over a full store: both must survive, two oldest
    // AI rows are the only candidates.
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "goal_a", content: "a" });
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "goal_b", content: "b" });
    const entries = await listUserMemoryEntries(userId);
    expect(entries).toHaveLength(USER_MEMORY_MAX_ENTRIES);
    const keys = new Set(entries.map((e) => e.key));
    expect(keys.has("goal_a")).toBe(true);
    expect(keys.has("goal_b")).toBe(true);
    expect(keys.has("habit_00")).toBe(false);
    expect(keys.has("habit_01")).toBe(false);
  });

  it("keeps the newest floor of core-category rows ahead of everything else", async () => {
    // 8 ancient career_goal rows + 33 recent habit rows: without the floor
    // the two oldest career goals would be the eviction order's victims.
    // The manual write occupies one of the 8 floor slots, so the newest
    // seven AI goals join it; goal_0 is the one core row that outlives
    // its floor and leaves with the oldest habit row instead of goal_1.
    await seedEntries([
      ...Array.from({ length: 8 }, (_, i) => ({
        category: "career_goal",
        key: `goal_${i}`,
        content: `goal ${i}`,
        updatedAt: new Date(2025, 0, 1, 0, 0, i),
      })),
      ...Array.from({ length: USER_MEMORY_MAX_ENTRIES - 7 }, (_, i) => ({
        category: "collaboration_habit",
        key: `habit_${i}`,
        content: `habit ${i}`,
        updatedAt: new Date(2026, 0, 1, 0, 0, i),
      })),
    ]);
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "manual_goal", content: "杭州" });
    const entries = await listUserMemoryEntries(userId);
    expect(entries).toHaveLength(USER_MEMORY_MAX_ENTRIES);
    const keys = new Set(entries.map((e) => e.key));
    for (let i = 1; i < 8; i += 1) expect(keys.has(`goal_${i}`)).toBe(true);
    expect(keys.has("manual_goal")).toBe(true);
    expect(keys.has("goal_0")).toBe(false);
    expect(keys.has("habit_0")).toBe(false);
  });

  it("a store of manual rows fails a new manual write honestly", async () => {
    for (let i = 0; i < USER_MEMORY_MAX_ENTRIES; i += 1) {
      await upsertUserMemoryEntry({
        userId,
        category: "collaboration_habit",
        key: `manual_${i}`,
        content: `m ${i}`,
      });
    }
    await expect(
      upsertUserMemoryEntry({ userId, category: "collaboration_habit", key: "one_more", content: "x" }),
    ).rejects.toBeInstanceOf(UserMemoryStoreFullError);
    // Nothing was silently evicted to make room.
    expect(await prisma.userMemoryEntry.count({ where: { userId } })).toBe(USER_MEMORY_MAX_ENTRIES);
    // And the curator's own write degrades to a no-op, never a manual loss.
    await applyMemoryCurationAction({
      userId,
      action: { action: "upsert", category: "collaboration_habit", key: "ai_row", content: "y" },
    });
    expect(await prisma.userMemoryEntry.count({ where: { userId } })).toBe(USER_MEMORY_MAX_ENTRIES);
    const rows = await prisma.userMemoryEntry.findMany({ where: { userId, source: "AI_EXTRACTED" } });
    expect(rows).toHaveLength(0);
  });
});

describe("managed session memory snapshot (M2.1)", () => {
  afterEach(async () => {
    await clearUserMemoryEntries(userId);
    await prisma.chatConversation.deleteMany({ where: { userId } });
    await prisma.userSettings.deleteMany({ where: { userId } });
  });

  it("freezes on first turn, ignores background writes, refreshes on named events", async () => {
    const conversation = await prisma.chatConversation.create({
      data: { userId, messages: "[]" },
    });
    await applyMemoryCurationAction({
      userId,
      action: { action: "upsert", category: "career_goal", key: "cities", content: "上海" },
    });
    const frozen = await managedMemoryBlockForConversation(userId, conversation.id);
    expect(frozen).toContain("上海");
    expect(
      (await prisma.chatConversation.findUniqueOrThrow({ where: { id: conversation.id } }))
        .managedMemoryBlock,
    ).toBe(frozen);

    // A background extraction writes through — the frozen block must not
    // move: the next turn's prefix stays byte-stable.
    await applyMemoryCurationAction({
      userId,
      action: { action: "upsert", category: "career_goal", key: "salary", content: "30k" },
    });
    expect(await managedMemoryBlockForConversation(userId, conversation.id)).toBe(frozen);

    // Compaction commit / manual edit refresh — the named events re-read.
    await refreshManagedMemoryBlockForConversation(userId, conversation.id);
    expect(await managedMemoryBlockForConversation(userId, conversation.id)).toContain("30k");
  });

  it("re-freezes every conversation on user writes and clears when disabled", async () => {
    const [a, b] = await Promise.all([
      prisma.chatConversation.create({ data: { userId, messages: "[]" } }),
      prisma.chatConversation.create({ data: { userId, messages: "[]" } }),
    ]);
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "cities", content: "上海" });
    await managedMemoryBlockForConversation(userId, a.id);
    await managedMemoryBlockForConversation(userId, b.id);

    // Simulated manual write + refresh (the action path calls the same fn).
    await upsertUserMemoryEntry({ userId, category: "career_goal", key: "salary", content: "30k" });
    await refreshManagedMemoryBlocksForUser(userId);
    expect(await managedMemoryBlockForConversation(userId, a.id)).toContain("30k");
    expect(await managedMemoryBlockForConversation(userId, b.id)).toContain("30k");

    // Master switch off: reads are empty now, snapshots cleared to NULL so
    // a re-enable re-freezes instead of resurrecting stale content.
    await prisma.userSettings.upsert({
      where: { userId },
      create: {
        userId,
        settings: JSON.stringify({ settings: { general: { agent: { longTermMemoryEnabled: false } } } }),
      },
      update: {
        settings: JSON.stringify({ settings: { general: { agent: { longTermMemoryEnabled: false } } } }),
      },
    });
    await refreshManagedMemoryBlocksForUser(userId);
    expect(await managedMemoryBlockForConversation(userId, a.id)).toBe("");
    expect(
      (await prisma.chatConversation.findUniqueOrThrow({ where: { id: a.id } })).managedMemoryBlock,
    ).toBeNull();
  });
});

describe("M2.2 read seam", () => {
  afterEach(async () => {
    await clearUserMemoryEntries(userId);
  });

  it("listCareerPreferenceMemory returns only the two preference categories", async () => {
    await seedEntries([
      { category: "career_goal", key: "cities", content: "上海" },
      { category: "industry_preference", key: "avoid", content: "外包" },
      { category: "collaboration_habit", key: "reply", content: "简洁" },
    ]);
    const rows = await listCareerPreferenceMemory(userId);
    expect(rows.map((r) => r.key).sort()).toEqual(["avoid", "cities"]);
  });
});

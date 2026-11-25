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
  clearUserMemoryEntries,
  deleteUserMemoryEntry,
  listUserMemoryEntries,
  loadLongTermMemoryLine,
  nativeMemoryBlockForConversation,
  updateUserMemoryEntry,
  upsertUserMemoryEntry,
  UserMemoryConflictError,
} from "@/lib/agent/longTermMemory.server";
import { USER_MEMORY_MAX_ENTRIES } from "@/lib/agent/longTermMemory";

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

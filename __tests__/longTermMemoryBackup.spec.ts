// @vitest-environment node
import fs from "fs";
import { PrismaClient } from "@prisma/client";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { BACKUP_FORMAT_VERSION } from "@/lib/backup/schema";
import { backupCoverageStatus, BACKUP_COVERAGE_STATUS } from "@/lib/backup/coverage";
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
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let sourceUserId: string;
let conversationId: string;

beforeAll(async () => {
  sourceUserId = await seedAccount(prisma, "memory-backup-src@example.com");
  const conversation = await prisma.chatConversation.create({
    data: { userId: sourceUserId, messages: "[]" },
  });
  conversationId = conversation.id;
  await prisma.userMemoryEntry.create({
    data: {
      userId: sourceUserId,
      category: "career_goal",
      key: "target_cities",
      content: "上海、杭州",
      source: "AI_EXTRACTED",
      sourceConversationId: conversationId,
    },
  });
  await prisma.userMemoryEntry.create({
    data: {
      userId: sourceUserId,
      category: "collaboration_habit",
      key: "reply_style",
      content: "回复先给结论",
      // A dangling provenance pointer: the conversation is NOT in this
      // account — restore must degrade it to null, never leak it across.
      sourceConversationId: "00000000-0000-4000-8000-000000000000",
    },
  });
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

async function unzipJson(buffer: Buffer, name: string) {
  const JSZip = (await import("jszip")).default;
  const zip = await JSZip.loadAsync(buffer);
  return JSON.parse(await zip.file(name)!.async("string"));
}

describe("UserMemoryEntry backup", () => {
  it("is classified as backed up and ships in the v15 format with provenance", async () => {
    expect(backupCoverageStatus("UserMemoryEntry")).toBe(BACKUP_COVERAGE_STATUS.BACKED_UP);
    expect(BACKUP_FORMAT_VERSION).toBe(15);

    const { buffer } = await buildBackupZip(sourceUserId, "memory-backup-src@example.com");
    const manifest = await unzipJson(buffer, "manifest.json");
    const data = await unzipJson(buffer, "data.json");

    expect(manifest.formatVersion).toBe(15);
    expect(manifest.counts.UserMemoryEntry).toBe(2);
    expect(data.UserMemoryEntry).toHaveLength(2);
    // Ownership is stripped on export; restore re-injects it.
    expect(data.UserMemoryEntry.every((row: Record<string, unknown>) => !("userId" in row))).toBe(true);
    // M2.1: provenance travels — the AI-extracted row carries its source.
    const aiRow = data.UserMemoryEntry.find(
      (row: Record<string, unknown>) => row.key === "target_cities",
    );
    expect(aiRow.source).toBe("AI_EXTRACTED");
  });

  it("restores entries re-owned to the importing user with remapped provenance", async () => {
    const { buffer } = await buildBackupZip(sourceUserId, "memory-backup-src@example.com");
    const targetUserId = await seedAccount(prisma, "memory-backup-dst@example.com");

    const result = await importBackup(buffer, targetUserId, "memory-backup-dst@example.com", true);
    expect(result.counts.UserMemoryEntry).toBe(2);

    const restored = await prisma.userMemoryEntry.findMany({
      where: { userId: targetUserId },
      orderBy: { key: "asc" },
    });
    expect(restored).toHaveLength(2);
    // All restored rows are re-owned — the source user keeps nothing here.
    expect(restored.every((row) => row.userId === targetUserId)).toBe(true);

    const withSource = restored.find((row) => row.key === "target_cities")!;
    const dangling = restored.find((row) => row.key === "reply_style")!;

    // The exported conversation was restored under a new id; the pointer
    // remapped to it instead of carrying the source account's id across.
    const targetConversation = await prisma.chatConversation.findFirstOrThrow({
      where: { userId: targetUserId },
    });
    expect(withSource.sourceConversationId).toBe(targetConversation.id);
    expect(withSource.sourceConversationId).not.toBe(conversationId);

    // A pointer whose conversation never shipped degrades to null.
    expect(dangling.sourceConversationId).toBeNull();

    // Provenance restores verbatim; the hand-written row keeps its
    // manual side (it was seeded without an explicit source — the column
    // default is the protected side).
    expect(withSource.source).toBe("AI_EXTRACTED");
    expect(dangling.source).toBe("USER_MANUAL");
  }, 120_000);

  it("re-derives provenance for pre-v14 rows whose source key is absent", async () => {
    const { buffer } = await buildBackupZip(sourceUserId, "memory-backup-src@example.com");
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    // A v13 backup has no `source` key at all — strip it (and forge an
    // unknown value plus a null pointer on one row) so the importer must
    // re-derive, never trust.
    for (const row of data.UserMemoryEntry as Array<Record<string, unknown>>) {
      if (row.key === "reply_style") {
        row.source = "forged";
        row.sourceConversationId = null;
      } else {
        delete row.source;
      }
    }
    manifest.formatVersion = 13;
    zip.file("data.json", JSON.stringify(data));
    zip.file("manifest.json", JSON.stringify(manifest));
    const legacy = await zip.generateAsync({ type: "nodebuffer" });

    const targetUserId = await seedAccount(prisma, "memory-backup-v13@example.com");
    await importBackup(legacy, targetUserId, "memory-backup-v13@example.com", true);
    const restored = await prisma.userMemoryEntry.findMany({
      where: { userId: targetUserId },
    });
    const aiRow = restored.find((row) => row.key === "target_cities")!;
    // The M2 discriminator: a sourceConversationId meant AI-written.
    expect(aiRow.source).toBe("AI_EXTRACTED");
    // An unrecognized source can never unlock a row for future curation —
    // it lands on the protected manual side.
    expect(restored.find((row) => row.key === "reply_style")!.source).toBe("USER_MANUAL");
  }, 120_000);

  it("imports a pre-M2 (v12) backup cleanly — no memory group required", async () => {
    const { buffer } = await buildBackupZip(sourceUserId, "memory-backup-src@example.com");
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    delete data.UserMemoryEntry;
    delete manifest.counts.UserMemoryEntry;
    manifest.formatVersion = 12;
    zip.file("data.json", JSON.stringify(data));
    zip.file("manifest.json", JSON.stringify(manifest));
    const legacy = await zip.generateAsync({ type: "nodebuffer" });

    const targetUserId = await seedAccount(prisma, "memory-backup-v12@example.com");
    const result = await importBackup(legacy, targetUserId, "memory-backup-v12@example.com", true);
    expect(result.counts.UserMemoryEntry ?? 0).toBe(0);
    expect(await prisma.userMemoryEntry.count({ where: { userId: targetUserId } })).toBe(0);
    // The rest of the v12 payload still restores.
    expect(result.counts.ChatConversation).toBe(1);
  }, 120_000);
});

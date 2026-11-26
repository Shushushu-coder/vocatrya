// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  copyRemainingMigrations,
  makeAbTestDbUrl,
  migrateDeploy,
  preparePrismaProjectThrough,
} from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATION_SUFFIX = "user_memory_curation";
const MIGRATION_DIR = path.join(
  REPO_ROOT,
  "prisma",
  "migrations",
  fs
    .readdirSync(path.join(REPO_ROOT, "prisma", "migrations"))
    .find((name) => name.endsWith(MIGRATION_SUFFIX)) ?? "",
);

describe("UserMemoryEntry curation migration (M2.1)", () => {
  it("is additive only — two new columns plus the provenance backfill", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATION_DIR, "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ALTER TABLE\s+"UserMemoryEntry"\s+ADD COLUMN\s+"source"/i);
    expect(sql).toMatch(/ALTER TABLE\s+"ChatConversation"\s+ADD COLUMN\s+"managedMemoryBlock"/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
  });

  it("backfills source from the M2 discriminator and preserves data", async () => {
    const ctx = makeAbTestDbUrl();
    // Database as of the M2 migration: UserMemoryEntry exists but has no
    // source column and ChatConversation no managedMemoryBlock.
    const schemaPath = preparePrismaProjectThrough(ctx.dir, "user_memory_entry");
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schemaPath);
      const userId = await seedAccount(
        prisma,
        `memory-cur-${Date.now()}@example.com`,
      );
      const now = new Date().toISOString();
      // An AI-extracted M2 row (pointer set) and a hand-written M2 row.
      await prisma.$executeRaw`
        INSERT INTO UserMemoryEntry (id, userId, category, key, content, sourceConversationId, createdAt, updatedAt)
        VALUES ('mem-ai', ${userId}, 'career_goal', 'cities', '上海', 'conv-x', ${now}, ${now})
      `;
      await prisma.$executeRaw`
        INSERT INTO UserMemoryEntry (id, userId, category, key, content, sourceConversationId, createdAt, updatedAt)
        VALUES ('mem-manual', ${userId}, 'career_goal', 'salary', '30k', NULL, ${now}, ${now})
      `;
      await prisma.$executeRaw`
        INSERT INTO ChatConversation (id, userId, messages, createdAt, updatedAt)
        VALUES ('conv-x', ${userId}, '[]', ${now}, ${now})
      `;

      copyRemainingMigrations(ctx.dir);
      migrateDeploy(ctx.url, schemaPath);

      const rows = (await prisma.$queryRaw`
        SELECT id, source, sourceConversationId FROM UserMemoryEntry ORDER BY id
      `) as { id: string; source: string; sourceConversationId: string | null }[];
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.id === "mem-ai")!.source).toBe("AI_EXTRACTED");
      expect(rows.find((r) => r.id === "mem-manual")!.source).toBe("USER_MANUAL");
      // Provenance pointer and content are untouched.
      expect(rows.find((r) => r.id === "mem-ai")!.sourceConversationId).toBe("conv-x");

      const conversation = (await prisma.$queryRaw`
        SELECT managedMemoryBlock FROM ChatConversation WHERE id = 'conv-x'
      `) as { managedMemoryBlock: string | null }[];
      expect(conversation[0].managedMemoryBlock).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});

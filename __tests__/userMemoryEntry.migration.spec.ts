// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  copyMigrationBySuffix,
  makeAbTestDbUrl,
  migrateDeploy,
  preparePrismaProject,
} from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATION_SUFFIX = "user_memory_entry";
// The follow-on curation migration ALTERs this table — it must stay out of
// the "pre-M2" fixture too, or deploy fails before the table exists.
const LATER_SUFFIX = "user_memory_curation";
const MIGRATION_DIR = path.join(
  REPO_ROOT,
  "prisma",
  "migrations",
  fs
    .readdirSync(path.join(REPO_ROOT, "prisma", "migrations"))
    .find((name) => name.endsWith(MIGRATION_SUFFIX)) ?? "",
);

describe("UserMemoryEntry migration", () => {
  it("is additive only — one new table, one nullable column, no rewrite", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATION_DIR, "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/CREATE TABLE\s+"UserMemoryEntry"/i);
    expect(sql).toMatch(/ADD COLUMN\s+"nativeMemoryBlock"/i);
    expect(sql).toMatch(/UNIQUE INDEX\s+"UserMemoryEntry_userId_category_key_key"/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });

  it("existing databases migrate without data loss", async () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir, {
      excludeSuffix: [MIGRATION_SUFFIX, LATER_SUFFIX],
    });
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schemaPath);
      const userId = await seedAccount(
        prisma,
        `memory-mig-${Date.now()}@example.com`,
      );
      const transcript = JSON.stringify([
        { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
      ]);
      await prisma.$executeRaw`
        INSERT INTO ChatConversation (id, userId, messages, createdAt, updatedAt)
        VALUES ('conv-mig', ${userId}, ${transcript}, ${new Date().toISOString()}, ${new Date().toISOString()})
      `;

      copyMigrationBySuffix(ctx.dir, MIGRATION_SUFFIX);
      migrateDeploy(ctx.url, schemaPath);

      // Pre-existing row intact; the new column defaults to NULL (no freeze yet).
      const row = (await prisma.$queryRaw`
        SELECT messages, nativeMemoryBlock FROM ChatConversation WHERE id = 'conv-mig'
      `) as { messages: string; nativeMemoryBlock: string | null }[];
      expect(row).toHaveLength(1);
      expect(row[0].messages).toBe(transcript);
      expect(row[0].nativeMemoryBlock).toBeNull();

      // The new table enforces the dedupe slot.
      await prisma.$executeRaw`
        INSERT INTO UserMemoryEntry (id, userId, category, key, content, createdAt, updatedAt)
        VALUES ('mem-1', ${userId}, 'career_goal', 'cities', '上海', ${new Date().toISOString()}, ${new Date().toISOString()})
      `;
      await expect(
        prisma.$executeRaw`
          INSERT INTO UserMemoryEntry (id, userId, category, key, content, createdAt, updatedAt)
          VALUES ('mem-2', ${userId}, 'career_goal', 'cities', '北京', ${new Date().toISOString()}, ${new Date().toISOString()})
        `,
      ).rejects.toThrow();
      const count = (await prisma.$queryRaw`
        SELECT COUNT(*) AS n FROM UserMemoryEntry WHERE userId = ${userId}
      `) as { n: number }[];
      expect(Number(count[0].n)).toBe(1);
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});

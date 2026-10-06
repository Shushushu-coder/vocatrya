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
const MIGRATION_SUFFIX = "add_chat_conversation_ai_lock";
const MIGRATION_DIR = path.join(
  REPO_ROOT,
  "prisma",
  "migrations",
  fs
    .readdirSync(path.join(REPO_ROOT, "prisma", "migrations"))
    .find((name) => name.endsWith(MIGRATION_SUFFIX)) ?? "",
);

describe("ChatConversation AI lock migration", () => {
  it("is additive only — two nullable columns, no rewrite", () => {
    const sql = fs.readFileSync(
      path.join(MIGRATION_DIR, "migration.sql"),
      "utf8",
    );
    expect(sql).toMatch(/ADD COLUMN\s+"resolvedConnectionId"/i);
    expect(sql).toMatch(/ADD COLUMN\s+"resolvedModel"/i);
    // NO_GUESS_BACKFILL: no defaults, no UPDATE, no data touch.
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
    expect(sql).not.toMatch(/DEFAULT/i);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });

  it("existing conversations migrate with messages intact and null lock fields", async () => {
    const ctx = makeAbTestDbUrl();
    // Pre-lock schema. Also hold back the later multi-conversation rebuild:
    // that migration copies resolvedConnectionId, so it cannot run before
    // this one. It has its own disposable round-trip.
    const schemaPath = preparePrismaProject(ctx.dir, {
      excludeSuffix: [MIGRATION_SUFFIX, "chat_conversation_multi", "chat_conversation_concurrency"],
    });
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schemaPath);
      const userId = await seedAccount(
        prisma,
        `chat-lock-mig-${Date.now()}@example.com`,
      );
      const transcript = JSON.stringify([
        { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
      ]);
      // The OLD client doesn't know the new columns — insert through raw
      // SQL so the row is a faithful pre-migration record.
      await prisma.$executeRaw`
        INSERT INTO ChatConversation (id, userId, messages, createdAt, updatedAt)
        VALUES ('conv-old', ${userId}, ${transcript}, ${new Date().toISOString()}, ${new Date().toISOString()})
      `;

      // Now apply the lock migration.
      copyMigrationBySuffix(ctx.dir, MIGRATION_SUFFIX);
      migrateDeploy(ctx.url, schemaPath);

      // Unquoted identifiers — Prisma's sqlite driver echoes a quoted name
      // back verbatim in the result keys.
      const row = (await prisma.$queryRaw`
        SELECT messages, resolvedConnectionId, resolvedModel
        FROM ChatConversation WHERE userId = ${userId}
      `) as {
        messages: string;
        resolvedConnectionId: string | null;
        resolvedModel: string | null;
      }[];
      expect(row).toHaveLength(1);
      expect(row[0].messages).toBe(transcript);
      expect(row[0].resolvedConnectionId).toBeNull();
      expect(row[0].resolvedModel).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});

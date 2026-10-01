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
const MIGRATION_SUFFIX = "chat_conversation_multi";
const MIGRATION_DIR = path.join(
  REPO_ROOT,
  "prisma",
  "migrations",
  fs
    .readdirSync(path.join(REPO_ROOT, "prisma", "migrations"))
    .find((name) => name.endsWith(MIGRATION_SUFFIX)) ?? "",
);

describe("ChatConversation multi-conversation migration", () => {
  it("copies rows without rewriting transcripts or locks", () => {
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
    expect(sql).toMatch(/INSERT INTO "new_ChatConversation"/);
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
    expect(sql).not.toMatch(/resolvedConnectionId"\s*=/);
    expect(sql).toMatch(/CREATE INDEX "ChatConversation_userId_updatedAt_idx"/);
  });

  it("keeps the existing row and allows a second conversation for the same user", async () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir, {
      excludeSuffix: MIGRATION_SUFFIX,
    });
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schemaPath);
      const userId = await seedAccount(
        prisma,
        `chat-multi-${Date.now()}@example.com`,
      );
      const otherId = await seedAccount(
        prisma,
        `chat-multi-other-${Date.now()}@example.com`,
      );
      const transcript = JSON.stringify([
        { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
      ]);
      const createdAt = "2026-09-01T00:00:00.000Z";
      await prisma.$executeRaw`
        INSERT INTO ChatConversation (
          id, userId, messages, resolvedConnectionId, resolvedModel, createdAt, updatedAt
        ) VALUES (
          'conv-legacy',
          ${userId},
          ${transcript},
          NULL,
          NULL,
          ${createdAt},
          ${createdAt}
        )
      `;
      await prisma.$executeRaw`
        INSERT INTO ChatConversation (
          id, userId, messages, resolvedConnectionId, resolvedModel, createdAt, updatedAt
        ) VALUES (
          'conv-locked',
          ${otherId},
          ${transcript},
          'conn-kept',
          'gpt-5.6-luna',
          ${createdAt},
          ${createdAt}
        )
      `;

      copyMigrationBySuffix(ctx.dir, MIGRATION_SUFFIX);
      migrateDeploy(ctx.url, schemaPath);

      const rows = (await prisma.$queryRaw`
        SELECT id, userId, messages, title, context, resolvedConnectionId, resolvedModel, createdAt
        FROM ChatConversation
        ORDER BY id
      `) as Array<{
        id: string;
        userId: string;
        messages: string;
        title: string | null;
        context: string | null;
        resolvedConnectionId: string | null;
        resolvedModel: string | null;
      }>;
      expect(rows).toHaveLength(2);
      const legacy = rows.find((row) => row.id === "conv-legacy");
      const locked = rows.find((row) => row.id === "conv-locked");
      expect(legacy?.userId).toBe(userId);
      expect(locked?.userId).toBe(otherId);
      expect(legacy?.messages).toBe(transcript);
      expect(legacy?.title).toBeNull();
      expect(legacy?.context).toBeNull();
      expect(legacy?.resolvedConnectionId).toBeNull();
      expect(legacy?.resolvedModel).toBeNull();
      expect(locked?.resolvedConnectionId).toBe("conn-kept");
      expect(locked?.resolvedModel).toBe("gpt-5.6-luna");
      expect(locked?.messages).toBe(transcript);

      await prisma.$executeRaw`
        INSERT INTO ChatConversation (
          id, userId, messages, createdAt, updatedAt
        ) VALUES (
          'conv-second',
          ${userId},
          '[]',
          ${createdAt},
          ${createdAt}
        )
      `;
      const count = (await prisma.$queryRaw`
        SELECT COUNT(*) AS n FROM ChatConversation WHERE userId = ${userId}
      `) as Array<{ n: number | bigint }>;
      expect(Number(count[0]?.n)).toBe(2);

      const foreign = (await prisma.$queryRaw`
        SELECT id FROM ChatConversation WHERE userId = ${otherId} ORDER BY id
      `) as Array<{ id: string }>;
      expect(foreign.map((row) => row.id)).toEqual(["conv-locked"]);
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});

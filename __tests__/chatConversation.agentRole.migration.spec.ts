// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  makeAbTestDbUrl,
  migrateDeploy,
  preparePrismaProject,
} from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATION_SUFFIX = "chat_conversation_agent_role";
const MIGRATION_DIR = path.join(
  REPO_ROOT,
  "prisma",
  "migrations",
  fs
    .readdirSync(path.join(REPO_ROOT, "prisma", "migrations"))
    .find((name) => name.endsWith(MIGRATION_SUFFIX)) ?? "",
);

// D2/V12: the multi-agent column is a plain additive ALTER — no table
// rebuild, no back-fill, no constraint that would reject pre-existing rows.
describe("ChatConversation agentRole migration", () => {
  it("is additive only: ADD COLUMN, no rebuild, no UPDATE/DELETE", () => {
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
    expect(sql).toMatch(/ALTER TABLE "ChatConversation" ADD COLUMN "agentRole"/);
    expect(sql).not.toMatch(/new_ChatConversation/);
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
    expect(sql).not.toMatch(/NOT NULL/i);
    expect(sql).not.toMatch(/DEFAULT/i);
  });

  it("deploys on a fresh chain, keeps old rows NULL and stores new roles", async () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir);
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schemaPath);
      const userId = await seedAccount(
        prisma,
        `chat-role-${Date.now()}@example.com`,
      );
      const createdAt = "2026-11-04T00:00:00.000Z";
      // A row written exactly like pre-multi-agent code — no agentRole.
      await prisma.$executeRaw`
        INSERT INTO ChatConversation (id, userId, messages, createdAt, updatedAt)
        VALUES ('conv-pre-role', ${userId}, '[]', ${createdAt}, ${createdAt})
      `;
      await prisma.$executeRaw`
        INSERT INTO ChatConversation (id, userId, messages, agentRole, createdAt, updatedAt)
        VALUES ('conv-reflect', ${userId}, '[]', 'reflect', ${createdAt}, ${createdAt})
      `;

      const cols = (await prisma.$queryRaw`
        PRAGMA table_info(ChatConversation)
      `) as Array<{ name: string; notnull: number }>;
      const col = cols.find((c) => c.name === "agentRole");
      expect(col).toBeTruthy();
      expect(Number(col!.notnull)).toBe(0);

      const rows = (await prisma.$queryRaw`
        SELECT id, agentRole FROM ChatConversation ORDER BY id
      `) as Array<{ id: string; agentRole: string | null }>;
      expect(rows.find((r) => r.id === "conv-pre-role")?.agentRole).toBeNull();
      expect(rows.find((r) => r.id === "conv-reflect")?.agentRole).toBe("reflect");
    } finally {
      await prisma.$disconnect();
    }
  }, 120_000);
});

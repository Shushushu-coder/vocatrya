// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { makeAbTestDbUrl, preparePrismaProject, migrateDeploy, copyMigrationBySuffix } from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

it("adds concurrency fields without changing a pre-change conversation or its summary", async () => {
  const ctx = makeAbTestDbUrl();
  fs.writeFileSync(ctx.url.slice(5), "");
  const schema = preparePrismaProject(ctx.dir, { excludeSuffix: ["chat_conversation_concurrency", "add_managed_ai_core_contracts"] });
  const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
  try {
    migrateDeploy(ctx.url, schema);
    const owner = await seedAccount(db, "migration-concurrency@example.com");
    const messages = '[{"id":"old","role":"user","parts":[{"type":"text","text":"preserve"}]}]';
    const now = new Date().toISOString();
    await db.$executeRaw`INSERT INTO ChatConversation (id,userId,title,context,messages,resolvedConnectionId,resolvedModel,createdAt,updatedAt) VALUES ('old',${owner},'title','context',${messages},'connection','model',${now},${now})`;
    const summary = await db.conversationSummary.create({ data: { conversationId: "old", userId: owner, text: "summary", revision: 7 } });
    // Later migrations (agentRole, executionPath, ...) also apply to this base;
    // compare only the columns that exist on both sides of this change.
    const before = await db.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id,userId,title,context,messages,resolvedConnectionId,resolvedModel,createdAt,updatedAt,archivedAt FROM ChatConversation WHERE id = 'old'");
    copyMigrationBySuffix(ctx.dir, "chat_conversation_concurrency");
    migrateDeploy(ctx.url, schema);
    const after = await db.$queryRawUnsafe<Record<string, unknown>[]>("SELECT id,userId,title,context,messages,resolvedConnectionId,resolvedModel,createdAt,updatedAt,revision,activeRequestId,activeRequestExpiresAt,archivedAt FROM ChatConversation WHERE id = 'old'");
    expect(after[0]).toEqual({ ...before[0], revision: 0, activeRequestId: null, activeRequestExpiresAt: null });
    expect(await db.conversationSummary.findUnique({ where: { conversationId: "old" } })).toEqual(summary);
    copyMigrationBySuffix(ctx.dir, "add_managed_ai_core_contracts");
    migrateDeploy(ctx.url, schema);
    const row = await db.chatConversation.create({ data: { userId: owner, messages: "[]" } });
    expect(row).toMatchObject({ revision: 0, activeRequestId: null, activeRequestExpiresAt: null });
  } finally {
    await db.$disconnect();
    if (ctx.dir.includes("vocatrya-ab-schema-")) fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
}, 120000);

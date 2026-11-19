// @vitest-environment node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  copyMigrationBySuffix,
  makeAbTestDbUrl,
  migrateDeploy,
  preparePrismaProject,
} from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

const SUFFIX = "agent_task_harness";

it("applies additively on top of existing conversations and enforces its constraints", async () => {
  const ctx = makeAbTestDbUrl();
  const schema = preparePrismaProject(ctx.dir, { excludeSuffix: SUFFIX });
  const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
  try {
    migrateDeploy(ctx.url, schema);
    const userId = await seedAccount(db, "agent-task-migration@example.com");
    const convId = randomUUID();
    // Raw insert: the generated client already knows the post-migration column.
    await db.$executeRawUnsafe(
      `INSERT INTO "ChatConversation" ("id","userId","messages","agentRole","updatedAt") VALUES (?,?,?,?,?)`,
      convId,
      userId,
      "[]",
      "pilot",
      new Date().getTime(),
    );
    await db.$disconnect();

    copyMigrationBySuffix(ctx.dir, SUFFIX);
    migrateDeploy(ctx.url, schema);

    // Existing transcript untouched, new column defaults to NULL (ordinary chat).
    const rows = await db.$queryRawUnsafe<
      Array<{ id: string; agentRole: string; agentTaskId: string | null; messages: string }>
    >(`SELECT "id","agentRole","agentTaskId","messages" FROM "ChatConversation"`);
    expect(rows).toEqual([{ id: convId, agentRole: "pilot", agentTaskId: null, messages: "[]" }]);

    const task = await db.agentTask.create({
      data: {
        userId,
        title: "t",
        templateKey: "INTERVIEW_SPRINT",
        milestone: "PREPARING",
        acceptanceItems: "[]",
        liveSlot: "INTERVIEW_SPRINT:job-1",
      },
    });
    // One live task per (user, liveSlot); NULL slots do not collide.
    await expect(
      db.agentTask.create({
        data: {
          userId,
          title: "dup",
          templateKey: "INTERVIEW_SPRINT",
          milestone: "PREPARING",
          acceptanceItems: "[]",
          liveSlot: "INTERVIEW_SPRINT:job-1",
        },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await db.agentTask.createMany({
      data: [1, 2].map((n) => ({
        userId,
        title: `done-${n}`,
        templateKey: "INTERVIEW_SPRINT",
        milestone: "DONE",
        acceptanceItems: "[]",
        liveSlot: null,
      })),
    });

    // Inline FK from the ADD COLUMN is enforced and SetNull on delete.
    await db.chatConversation.update({ where: { id: convId }, data: { agentTaskId: task.id } });
    await expect(
      db.chatConversation.update({ where: { id: convId }, data: { agentTaskId: "missing" } }),
    ).rejects.toBeTruthy();
    await db.agentTask.delete({ where: { id: task.id } });
    expect((await db.chatConversation.findUniqueOrThrow({ where: { id: convId } })).agentTaskId).toBeNull();

    expect(await db.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await db.$disconnect();
    if (ctx.dir.includes("vocatrya-ab-schema-")) fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
}, 120000);

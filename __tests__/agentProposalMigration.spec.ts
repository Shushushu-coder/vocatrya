// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { makeAbTestDbUrl, preparePrismaProject, migrateDeploy, copyMigrationBySuffix } from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

it("upgrades existing task and event rows without losing recovery evidence", async () => {
  const ctx = makeAbTestDbUrl();
  const suffix = "agent_operation_proposal";
  const schema = preparePrismaProject(ctx.dir, { excludeSuffix: suffix });
  const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
  try {
    migrateDeploy(ctx.url, schema);
    const userId = await seedAccount(db, "proposal-migration@example.com");
    const task = await db.harnessTask.create({ data: {
      userId, kind: "DEEP_MATCH", requestKey: "existing-task", inputHash: "hash", inputJson: "{}",
      jobOpportunityId: "job-reference", claimEpoch: 3,
    } });
    await db.harnessTaskEvent.create({ data: { taskId: task.id, seq: 1, epoch: 3, type: "TASK_CREATED" } });
    await db.$disconnect();
    copyMigrationBySuffix(ctx.dir, suffix);
    migrateDeploy(ctx.url, schema);
    expect(await db.harnessTask.findUnique({ where: { id: task.id } })).toMatchObject({ claimEpoch: 3, jobOpportunityId: "job-reference" });
    expect(await db.harnessTaskEvent.count({ where: { taskId: task.id } })).toBe(1);
    expect(await db.$queryRawUnsafe("PRAGMA foreign_key_check")).toEqual([]);
  } finally {
    await db.$disconnect();
    if (ctx.dir.includes("vocatrya-ab-schema-")) fs.rmSync(ctx.dir, { recursive: true, force: true });
  }
}, 120000);

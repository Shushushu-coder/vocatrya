// @vitest-environment node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  AGENT_TASK_EVENT_KIND,
  listTaskEvents,
  recordTaskEvent,
} from "@/lib/agent/task/agentTaskEvents";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
let otherUserId: string;
let taskId: string;

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `ev-${randomUUID()}@example.com`);
  otherUserId = await seedAccount(prisma, `ev-other-${randomUUID()}@example.com`);
  taskId = (
    await prisma.agentTask.create({
      data: {
        userId,
        title: "t",
        templateKey: "INTERVIEW_SPRINT",
        milestone: "PREPARING",
        acceptanceItems: "[]",
      },
    })
  ).id;
});

describe("agent task events", () => {
  it("appends flat pointer payloads and lists them oldest-first", async () => {
    await recordTaskEvent(prisma, { userId, taskId, kind: AGENT_TASK_EVENT_KIND.STEP, payload: { n: 1 } });
    await recordTaskEvent(prisma, { userId, taskId, kind: AGENT_TASK_EVENT_KIND.STEP, payload: { n: 2, ok: true } });
    const events = await listTaskEvents(prisma, { userId, taskId });
    expect(events.map((e) => e.payload)).toEqual([{ n: 1 }, { n: 2, ok: true }]);
    expect(await listTaskEvents(prisma, { userId, taskId, limit: 1 })).toHaveLength(1);
  });

  it("is user-scoped on both write and read", async () => {
    await expect(
      recordTaskEvent(prisma, { userId: otherUserId, taskId, kind: AGENT_TASK_EVENT_KIND.STEP }),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
    await recordTaskEvent(prisma, { userId, taskId, kind: AGENT_TASK_EVENT_KIND.STEP });
    expect(await listTaskEvents(prisma, { userId: otherUserId, taskId })).toEqual([]);
    expect(await prisma.agentTaskEvent.count()).toBe(1);
  });

  it("rejects unknown kinds and oversized payloads", async () => {
    await expect(
      recordTaskEvent(prisma, { userId, taskId, kind: "NOPE" as never }),
    ).rejects.toMatchObject({ code: "INVALID_KIND" });
    await expect(
      recordTaskEvent(prisma, {
        userId,
        taskId,
        kind: AGENT_TASK_EVENT_KIND.STEP,
        payload: { text: "x".repeat(APP_CONSTANTS.AGENT_TASK_EVENT_PAYLOAD_MAX_CHARS) },
      }),
    ).rejects.toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(await prisma.agentTaskEvent.count()).toBe(0);
  });

  it("cascades with the task", async () => {
    await recordTaskEvent(prisma, { userId, taskId, kind: AGENT_TASK_EVENT_KIND.STEP });
    await prisma.agentTask.delete({ where: { id: taskId } });
    expect(await prisma.agentTaskEvent.count()).toBe(0);
  });
});

// @vitest-environment node
/**
 * writeHandoffForSession outcomes against an isolated database with a fake
 * (injected) model. No real model calls.
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { writeHandoffForSession } from "@/lib/agent/task/agentTaskHandoffScheduler";
import { loadLatestHandoff } from "@/lib/agent/task/agentTaskHandoffStore";
import { listTaskEvents } from "@/lib/agent/task/agentTaskEvents";
import { resetDisposableDb } from "./helpers/backupTestDb";
import { seedSprint, type Sprint } from "./helpers/agentTaskHandoffFixtures";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let sprint: Sprint;

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
  sprint = await seedSprint(prisma);
});

const GOOD_REPLY = JSON.stringify({
  summary: "Mock session 1 started; JD fit reviewed.",
  nextActions: [{ action: "Answer the first mock question", toolHint: "submit_answer" }],
  blocking: { isBlocked: false },
});

function run(generateProse: Parameters<typeof writeHandoffForSession>[0]["generateProse"], expectedRevision = 0) {
  return writeHandoffForSession({
    db: prisma,
    userId: sprint.userId,
    taskId: sprint.task.id,
    sessionId: sprint.conversation.id,
    expectedRevision,
    generateProse,
  });
}

describe("writeHandoffForSession", () => {
  it("commits: pointers from code, prose from the model, event recorded", async () => {
    const prompts: string[] = [];
    const result = await run(async ({ prompt, operationKey }) => {
      prompts.push(prompt);
      expect(operationKey).toMatch(new RegExp(`^task:${sprint.task.id}:handoff:[0-9a-f]{16}$`));
      return GOOD_REPLY;
    });
    expect(result).toMatchObject({ status: "committed", revision: 1 });
    expect(prompts[0]).toContain("Let's practice system design.");

    const loaded = await loadLatestHandoff(prisma, {
      userId: sprint.userId,
      taskId: sprint.task.id,
    });
    if (loaded?.status !== "ok") throw new Error("expected ok");
    expect(loaded.sessionId).toBe(sprint.conversation.id);
    expect(loaded.state.completedWork).toMatchObject({
      summary: "Mock session 1 started; JD fit reviewed.",
      jobOpportunityIds: [sprint.job.id],
      matchAnalysisIds: [sprint.match.id],
      interviewSessionIds: [sprint.interview.id],
      interviewPrepGoalIds: [sprint.goal.id],
      jobDescriptionVersionIds: [sprint.jd.id],
    });
    expect(loaded.state.acceptanceSnapshot.every((item) => item.passes === false)).toBe(true);
    expect(loaded.state.milestone).toBe("PREPARING");
    const kinds = (await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id })).map(
      (event) => event.kind,
    );
    expect(kinds).toContain("HANDOFF_COMMIT");
  });

  it("carries the previous handoff forward into the next prompt", async () => {
    await run(async () => GOOD_REPLY);
    let second = "";
    const result = await run(async ({ prompt }) => {
      second = prompt;
      return GOOD_REPLY;
    }, 1);
    expect(result).toMatchObject({ status: "committed", revision: 2 });
    expect(second).toContain("Previous handoff (JSON data)");
  });

  it("model-forged pointer ids cannot reach the state", async () => {
    const forged = JSON.stringify({
      summary: "s",
      nextActions: [{ action: "a" }],
      blocking: { isBlocked: false },
      matchAnalysisIds: ["forged"],
    });
    expect(await run(async () => forged)).toMatchObject({
      status: "validation_failed",
      stage: "prose",
    });
    expect(await prisma.agentTaskHandoff.count()).toBe(0);
  });

  it("returns validation_failed for non-JSON prose and records an ERROR event", async () => {
    const result = await run(async () => "I cannot do that.");
    expect(result).toMatchObject({ status: "validation_failed", stage: "prose" });
    const events = await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(events.find((event) => event.kind === "ERROR")?.payload).toMatchObject({
      source: "handoff",
      code: "prose_not_json",
    });
  });

  it("returns generation_failed when the model throws, committing nothing", async () => {
    const result = await run(async () => {
      throw new Error("provider down");
    });
    expect(result).toEqual({ status: "generation_failed", error: "provider down" });
    expect(await prisma.agentTaskHandoff.count()).toBe(0);
  });

  it("returns revision_conflict for a stale expectedRevision before calling the model", async () => {
    await run(async () => GOOD_REPLY);
    const generate = vi.fn(async () => GOOD_REPLY);
    expect(await run(generate, 0)).toEqual({ status: "revision_conflict" });
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns revision_conflict when another writer wins during generation", async () => {
    const result = await run(async () => {
      await prisma.agentTask.update({ where: { id: sprint.task.id }, data: { revision: 5 } });
      return GOOD_REPLY;
    });
    expect(result).toEqual({ status: "revision_conflict" });
    expect(await prisma.agentTaskHandoff.count()).toBe(0);
  });

  it("returns validation_failed (pointers) when an entity vanishes mid-run", async () => {
    const result = await run(async () => {
      await prisma.interviewSession.delete({ where: { id: sprint.interview.id } });
      return GOOD_REPLY;
    });
    // The pointer set was collected before generation, so the re-check fires.
    expect(result).toMatchObject({ status: "validation_failed", stage: "pointers" });
    expect(await prisma.agentTaskHandoff.count()).toBe(0);
  });

  it("returns not_found for an unknown task or a session not bound to the task", async () => {
    expect(
      await writeHandoffForSession({
        db: prisma,
        userId: sprint.userId,
        taskId: "nope",
        sessionId: sprint.conversation.id,
        expectedRevision: 0,
        generateProse: async () => GOOD_REPLY,
      }),
    ).toEqual({ status: "not_found", what: "task" });
    const unbound = await prisma.chatConversation.create({
      data: { userId: sprint.userId, messages: "[]", agentRole: "pilot" },
    });
    expect(
      await writeHandoffForSession({
        db: prisma,
        userId: sprint.userId,
        taskId: sprint.task.id,
        sessionId: unbound.id,
        expectedRevision: 0,
        generateProse: async () => GOOD_REPLY,
      }),
    ).toEqual({ status: "not_found", what: "session" });
  });
});

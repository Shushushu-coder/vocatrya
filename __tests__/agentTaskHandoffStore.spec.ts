// @vitest-environment node
/**
 * Handoff store against an isolated SQLite/Prisma database: revision CAS,
 * concurrent commits (one winner), pointer existence re-check, stateHash, and
 * tolerant reads of restored state with dangling ids.
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  commitHandoff,
  computeHandoffStateHash,
  loadLatestHandoff,
} from "@/lib/agent/task/agentTaskHandoffStore";
import {
  collectInterviewSprintPointers,
  findMissingPointers,
} from "@/lib/agent/task/agentTaskPointers";
import { listTaskEvents } from "@/lib/agent/task/agentTaskEvents";
import { getAgentTask } from "@/lib/agent/task/agentTaskStore";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";
import { handoffStateFor, seedSprint, type Sprint } from "./helpers/agentTaskHandoffFixtures";

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

const base = () => ({ userId: sprint.userId, taskId: sprint.task.id });

describe("stateHash", () => {
  it("is stable across key order and changes with content", () => {
    const state = handoffStateFor(sprint);
    const reordered = JSON.parse(
      JSON.stringify(Object.fromEntries(Object.entries(state).reverse())),
    );
    expect(computeHandoffStateHash(reordered)).toBe(computeHandoffStateHash(state));
    expect(
      computeHandoffStateHash({ ...state, milestone: "REVIEWING" }),
    ).not.toBe(computeHandoffStateHash(state));
  });
});

describe("commitHandoff", () => {
  it("commits revision 1, bumps the task revision and records the event", async () => {
    const result = await commitHandoff(prisma, {
      ...base(),
      expectedRevision: 0,
      state: handoffStateFor(sprint),
      sessionId: sprint.conversation.id,
      generationMs: 12,
    });
    expect(result).toMatchObject({ status: "committed", revision: 1 });
    expect((await getAgentTask(prisma, base()))?.revision).toBe(1);

    const loaded = await loadLatestHandoff(prisma, base());
    expect(loaded).toMatchObject({
      status: "ok",
      revision: 1,
      hashMatches: true,
      sessionId: sprint.conversation.id,
    });
    const events = await listTaskEvents(prisma, base());
    expect(events.map((event) => event.kind)).toContain("HANDOFF_COMMIT");
  });

  it("chains revisions and reads the latest", async () => {
    await commitHandoff(prisma, { ...base(), expectedRevision: 0, state: handoffStateFor(sprint) });
    await commitHandoff(prisma, {
      ...base(),
      expectedRevision: 1,
      state: handoffStateFor(sprint, { milestone: "REVIEWING" }),
    });
    const loaded = await loadLatestHandoff(prisma, base());
    expect(loaded).toMatchObject({ status: "ok", revision: 2 });
    if (loaded?.status === "ok") expect(loaded.state.milestone).toBe("REVIEWING");
  });

  it("rejects a stale expectedRevision without writing", async () => {
    await commitHandoff(prisma, { ...base(), expectedRevision: 0, state: handoffStateFor(sprint) });
    const stale = await commitHandoff(prisma, {
      ...base(),
      expectedRevision: 0,
      state: handoffStateFor(sprint, { milestone: "DONE" }),
    });
    expect(stale).toEqual({ status: "revision_conflict" });
    expect(await prisma.agentTaskHandoff.count({ where: { taskId: sprint.task.id } })).toBe(1);
    expect((await getAgentTask(prisma, base()))?.revision).toBe(1);
  });

  it("lets exactly one of several concurrent commits win", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        commitHandoff(prisma, {
          ...base(),
          expectedRevision: 0,
          state: handoffStateFor(sprint, {
            nextActions: [{ action: `attempt ${i}` }],
          }),
        }),
      ),
    );
    expect(results.filter((r) => r.status === "committed")).toHaveLength(1);
    expect(results.filter((r) => r.status === "revision_conflict")).toHaveLength(4);
    expect(await prisma.agentTaskHandoff.count({ where: { taskId: sprint.task.id } })).toBe(1);
    expect((await getAgentTask(prisma, base()))?.revision).toBe(1);
  }, 30_000);

  it("rejects a pointer id that no longer exists and writes nothing", async () => {
    const state = handoffStateFor(sprint);
    const result = await commitHandoff(prisma, {
      ...base(),
      expectedRevision: 0,
      state: {
        ...state,
        completedWork: { ...state.completedWork, matchAnalysisIds: [sprint.match.id, "ghost-analysis"] },
      },
    });
    expect(result).toEqual({
      status: "pointer_missing",
      missing: [{ key: "matchAnalysisIds", id: "ghost-analysis" }],
    });
    expect(await prisma.agentTaskHandoff.count()).toBe(0);
    expect((await getAgentTask(prisma, base()))?.revision).toBe(0);
  });

  it("treats another user's entity as missing (ids are not authority)", async () => {
    const other = await seedSprint(prisma);
    const state = handoffStateFor(sprint);
    const result = await commitHandoff(prisma, {
      ...base(),
      expectedRevision: 0,
      state: {
        ...state,
        completedWork: { ...state.completedWork, interviewSessionIds: [other.interview.id] },
      },
    });
    expect(result.status).toBe("pointer_missing");
  });

  it("rejects an invalid or mismatched state and another user's task", async () => {
    expect(
      (await commitHandoff(prisma, { ...base(), expectedRevision: 0, state: { nope: true } })).status,
    ).toBe("invalid");
    const mismatch = await commitHandoff(prisma, {
      ...base(),
      expectedRevision: 0,
      state: handoffStateFor(sprint, { taskId: "other-task" }),
    });
    expect(mismatch.status).toBe("invalid");
    const stranger = await seedAccount(prisma, "stranger@example.com");
    const foreign = await commitHandoff(prisma, {
      userId: stranger,
      taskId: sprint.task.id,
      expectedRevision: 0,
      state: handoffStateFor(sprint),
    });
    expect(foreign).toEqual({ status: "task_not_found" });
  });
});

describe("loadLatestHandoff", () => {
  it("is user-scoped and null when empty", async () => {
    expect(await loadLatestHandoff(prisma, base())).toBeNull();
    await commitHandoff(prisma, { ...base(), expectedRevision: 0, state: handoffStateFor(sprint) });
    const stranger = await seedAccount(prisma, "stranger2@example.com");
    expect(await loadLatestHandoff(prisma, { userId: stranger, taskId: sprint.task.id })).toBeNull();
  });

  it("reads restored-verbatim state with dangling ids and reports them", async () => {
    // Backup restore writes state verbatim; ids may not resolve afterwards.
    const state = handoffStateFor(sprint);
    const dangling = {
      ...state,
      completedWork: {
        ...state.completedWork,
        matchAnalysisIds: ["gone-1"],
        interviewSessionIds: [sprint.interview.id, "gone-2"],
      },
    };
    await prisma.agentTaskHandoff.create({
      data: {
        taskId: sprint.task.id,
        revision: 1,
        state: JSON.stringify(dangling),
        stateHash: computeHandoffStateHash(dangling),
      },
    });
    const loaded = await loadLatestHandoff(prisma, { ...base(), checkPointers: true });
    expect(loaded).toMatchObject({ status: "ok", hashMatches: true });
    if (loaded?.status !== "ok") throw new Error("expected ok");
    expect(loaded.missingPointers).toEqual([
      { key: "matchAnalysisIds", id: "gone-1" },
      { key: "interviewSessionIds", id: "gone-2" },
    ]);
  });

  it("flags a hash mismatch and reads a malformed state as corrupt", async () => {
    await prisma.agentTaskHandoff.create({
      data: {
        taskId: sprint.task.id,
        revision: 1,
        state: JSON.stringify(handoffStateFor(sprint)),
        stateHash: "deadbeef",
      },
    });
    expect(await loadLatestHandoff(prisma, base())).toMatchObject({ status: "ok", hashMatches: false });
    await prisma.agentTaskHandoff.create({
      data: { taskId: sprint.task.id, revision: 2, state: "{not json", stateHash: "x" },
    });
    expect(await loadLatestHandoff(prisma, base())).toEqual({ status: "corrupt", revision: 2 });
  });
});

describe("pointer helpers", () => {
  it("collects interview-sprint pointers by code from domain state", async () => {
    const pointers = await collectInterviewSprintPointers(prisma, {
      userId: sprint.userId,
      jobOpportunityId: sprint.task.jobOpportunityId,
      interviewPrepGoalId: sprint.task.interviewPrepGoalId,
    });
    expect(pointers).toEqual({
      jobOpportunityIds: [sprint.job.id],
      jobDescriptionVersionIds: [sprint.jd.id],
      interviewPrepGoalIds: [sprint.goal.id],
      matchAnalysisIds: [sprint.match.id],
      interviewSessionIds: [sprint.interview.id],
    });
    expect(await findMissingPointers(prisma, { userId: sprint.userId, pointers })).toEqual([]);
  });

  it("yields empty pointers for a task with nothing resolvable", async () => {
    expect(
      await collectInterviewSprintPointers(prisma, {
        userId: sprint.userId,
        jobOpportunityId: null,
        interviewPrepGoalId: null,
      }),
    ).toEqual({
      jobOpportunityIds: [],
      jobDescriptionVersionIds: [],
      interviewPrepGoalIds: [],
      matchAnalysisIds: [],
      interviewSessionIds: [],
    });
  });
});

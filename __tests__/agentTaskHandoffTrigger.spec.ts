// @vitest-environment node
/**
 * Turn-finish handoff trigger with an injected fake model: commit path,
 * managed operationKey forwarding, failure containment + backoff, and the
 * guards that keep a non-owner / legacy / archived session from writing.
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import {
  resetTaskHandoffStateForTests,
  runTaskHandoff,
  scheduleTaskHandoff,
  taskHandoffInFlight,
  type TaskHandoffTriggerDeps,
} from "@/lib/agent/task/agentTaskHandoffTrigger";
import {
  AGENT_TASK_STATUS,
  claimAgentTaskSession,
  getAgentTask,
  transitionAgentTaskStatus,
} from "@/lib/agent/task/agentTaskStore";
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
  resetTaskHandoffStateForTests();
  sprint = await seedSprint(prisma);
});

const GOOD = JSON.stringify({
  summary: "Mock session 1 started.",
  nextActions: [{ action: "Answer the first mock question" }],
  blocking: { isBlocked: false },
});

let clock = 1_000_000;
const executeText = vi.fn(async (_input: unknown) => ({ text: GOOD }));

function makeDeps(over: Partial<TaskHandoffTriggerDeps> = {}): TaskHandoffTriggerDeps {
  return {
    db: prisma,
    now: () => clock,
    loadSession: async () => ({
      messages: [],
      resolvedConnectionId: "conn-1",
      resolvedModel: "model-1",
      summary: null,
    }),
    executeText: executeText as TaskHandoffTriggerDeps["executeText"],
    ...over,
  };
}

const input = () => ({
  userId: sprint.userId,
  conversationId: sprint.conversation.id,
  taskId: sprint.task.id,
});

beforeEach(() => {
  clock = 1_000_000;
  executeText.mockReset();
  executeText.mockResolvedValue({ text: GOOD });
});

const events = async () =>
  (await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id })).map((e) => e);

describe("runTaskHandoff", () => {
  it("commits a handoff with a real generateProse call, derived milestone and the claim held", async () => {
    const result = await runTaskHandoff(input(), makeDeps());
    expect(result).toMatchObject({ status: "committed", revision: 1 });
    expect(executeText).toHaveBeenCalledTimes(1);
    const call = executeText.mock.calls[0][0] as Record<string, unknown>;
    expect(call).toMatchObject({ userId: sprint.userId, connectionId: "conn-1", model: "model-1" });
    expect(call.operationId).toBeUndefined();
    expect(String(call.prompt)).toContain("Let's practice system design.");

    const loaded = await loadLatestHandoff(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    if (loaded?.status !== "ok") throw new Error("expected ok");
    // Milestone and checklist were re-derived from domain state before writing.
    expect(loaded.state.milestone).toBe("PRACTICING");
    expect(loaded.state.acceptanceSnapshot.find((i) => i.key === "jd-fit-reviewed")?.passes).toBe(true);
    expect(loaded.sessionId).toBe(sprint.conversation.id);
    const task = await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(task?.activeSessionId).toBe(sprint.conversation.id);
    expect(task?.revision).toBe(1);
  });

  it("a second turn writes revision 2 on top of the first", async () => {
    await runTaskHandoff(input(), makeDeps());
    const second = await runTaskHandoff(input(), makeDeps());
    expect(second).toMatchObject({ status: "committed", revision: 2 });
    expect(String((executeText.mock.calls[1][0] as { prompt: string }).prompt)).toContain("Previous handoff");
  });

  it("forwards managed provenance and a deterministic task:<id>:handoff:<hash16> operationId", async () => {
    const managed = {
      connectionId: "conn-1",
      model: "model-1",
      provenance: { v: 1 } as never,
    };
    const deps = makeDeps({
      loadSession: async () => ({
        messages: [],
        resolvedConnectionId: "conn-1",
        resolvedModel: "model-1",
        managed,
        summary: null,
      }),
    });
    await runTaskHandoff(input(), deps);
    const call = executeText.mock.calls[0][0] as Record<string, unknown>;
    expect(call.operationId).toMatch(new RegExp(`^task:${sprint.task.id}:handoff:[0-9a-f]{16}$`));
    expect(call.managedAiProvenance).toBe(managed.provenance);
    expect(call.managedResource).toEqual({
      business: "CAREER_DIALOGUE",
      resourceKey: `conversation:${sprint.conversation.id}`,
    });
    expect(call.attemptIndex).toBe(0);
  });

  it("a model failure is contained, audited, and backs off; success afterwards clears it", async () => {
    executeText.mockRejectedValueOnce(new Error("provider down"));
    const failed = await runTaskHandoff(input(), makeDeps());
    expect(failed).toMatchObject({ status: "failed", reason: "generation", failureCount: 1 });
    expect((await events()).some((e) => e.kind === "ERROR")).toBe(true);
    expect(await prisma.agentTaskHandoff.count()).toBe(0);

    const backedOff = await runTaskHandoff(input(), makeDeps());
    expect(backedOff).toMatchObject({ status: "skipped", reason: "backoff" });
    expect(executeText).toHaveBeenCalledTimes(1);

    clock += 60 * 60 * 1000;
    const retried = await runTaskHandoff(input(), makeDeps());
    expect(retried).toMatchObject({ status: "committed", revision: 1 });
    // Counter cleared: an immediate next failure starts again from 1.
    executeText.mockRejectedValueOnce(new Error("again"));
    expect(await runTaskHandoff(input(), makeDeps())).toMatchObject({ failureCount: 1 });
  });

  it("invalid model output counts as a failure and never reaches the state", async () => {
    executeText.mockResolvedValue({ text: "I cannot do that." });
    const result = await runTaskHandoff(input(), makeDeps());
    expect(result).toMatchObject({ status: "failed", reason: "validation_prose", failureCount: 1 });
    expect(await prisma.agentTaskHandoff.count()).toBe(0);
  });

  it("an unexpected infrastructure error is returned, not thrown", async () => {
    const deps = makeDeps({
      loadSession: async () => {
        throw new Error("db exploded");
      },
    });
    await expect(runTaskHandoff(input(), deps)).resolves.toMatchObject({ status: "failed", reason: "unexpected" });
  });

  it("skips legacy-lock, archived and invalid-lock sessions without calling the model", async () => {
    const legacy = makeDeps({
      loadSession: async () => ({ messages: [], resolvedConnectionId: null, resolvedModel: null, summary: null }),
    });
    expect(await runTaskHandoff(input(), legacy)).toMatchObject({ status: "skipped", reason: "legacy" });
    const archived = makeDeps({
      loadSession: async () => ({ messages: [], resolvedConnectionId: null, resolvedModel: null, archived: true, summary: null }),
    });
    expect(await runTaskHandoff(input(), archived)).toMatchObject({ status: "skipped", reason: "archived" });
    const invalid = makeDeps({
      loadSession: async () => ({
        messages: [],
        resolvedConnectionId: "c",
        resolvedModel: "m",
        lockInvalid: "MANAGED_BINDING_UNAVAILABLE",
        summary: null,
      }),
    });
    expect(await runTaskHandoff(input(), invalid)).toMatchObject({
      status: "failed",
      reason: "MANAGED_BINDING_UNAVAILABLE",
    });
    expect(executeText).not.toHaveBeenCalled();
  });

  it("only the claim holder writes: another live session holding the claim skips", async () => {
    const other = await prisma.chatConversation.create({
      data: { userId: sprint.userId, messages: "[]", agentRole: "pilot", agentTaskId: sprint.task.id },
    });
    const claim = await claimAgentTaskSession(prisma, {
      userId: sprint.userId,
      taskId: sprint.task.id,
      sessionId: other.id,
    });
    expect(claim.ok).toBe(true);
    const result = await runTaskHandoff(input(), makeDeps());
    expect(result).toMatchObject({ status: "skipped", reason: "claim_held" });
    expect(executeText).not.toHaveBeenCalled();
  });

  it("a paused task writes nothing", async () => {
    await transitionAgentTaskStatus(prisma, { userId: sprint.userId, taskId: sprint.task.id, to: AGENT_TASK_STATUS.PAUSED });
    expect(await runTaskHandoff(input(), makeDeps())).toMatchObject({ status: "skipped", reason: "not_active" });
    expect(executeText).not.toHaveBeenCalled();
  });
});

describe("scheduleTaskHandoff", () => {
  const assistantDone = [
    { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
  ] as UIMessage[];

  it("is fire-and-forget, de-duplicated per task, and drains", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    executeText.mockImplementation(async () => {
      await gate;
      return { text: GOOD };
    });
    const results: string[] = [];
    const deps = makeDeps({ onResult: (r) => results.push(r.status) });
    expect(scheduleTaskHandoff({ ...input(), messages: assistantDone }, deps)).toEqual({ opened: true });
    expect(scheduleTaskHandoff({ ...input(), messages: assistantDone }, deps)).toEqual({ opened: false });
    release();
    await taskHandoffInFlight(sprint.task.id);
    expect(results).toEqual(["committed"]);
    expect(taskHandoffInFlight(sprint.task.id)).toBeUndefined();
  });

  it("does nothing unless the turn ended with a real assistant reply", () => {
    const userLast = assistantDone.slice(0, 1);
    expect(scheduleTaskHandoff({ ...input(), messages: userLast }, makeDeps())).toEqual({ opened: false });
    const empty = [{ id: "a", role: "assistant", parts: [{ type: "text", text: "  " }] }] as UIMessage[];
    expect(scheduleTaskHandoff({ ...input(), messages: empty }, makeDeps())).toEqual({ opened: false });
    expect(executeText).not.toHaveBeenCalled();
  });

  it("never throws and never rejects, even when everything underneath does", async () => {
    const deps = makeDeps({
      loadSession: async () => {
        throw new Error("boom");
      },
    });
    let outcome: unknown;
    expect(() => {
      outcome = scheduleTaskHandoff({ ...input(), messages: assistantDone }, deps);
    }).not.toThrow();
    expect(outcome).toEqual({ opened: true });
    await expect(taskHandoffInFlight(sprint.task.id)).resolves.toBeUndefined();
  });
});

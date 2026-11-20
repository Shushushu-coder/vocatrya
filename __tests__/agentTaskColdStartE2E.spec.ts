// @vitest-environment node
/**
 * End to end on an isolated database with a fake model: create task -> write
 * the handoff note from a session -> pause, change the world, "continue
 * task" -> the new session is bound, claimed, and its prompt carries the
 * DATABASE-VERIFIED status line (not just what the old note said).
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { runTaskHandoff, resetTaskHandoffStateForTests } from "@/lib/agent/task/agentTaskHandoffTrigger";
import { resumeAgentTaskSession } from "@/lib/agent/task/agentTaskResume";
import { resolveTaskSessionContext } from "@/lib/agent/task/agentTaskBootstrap";
import {
  AGENT_TASK_STATUS,
  getAgentTask,
  transitionAgentTaskStatus,
} from "@/lib/agent/task/agentTaskStore";
import { renderCareerDialoguePrompt } from "@/lib/agent/accountTurn";
import { buildAgentChatSystemPrompt } from "@/lib/agent/prompt";
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

const NOTE = JSON.stringify({
  summary: "Reviewed the JD fit and started mock session 1.",
  nextActions: [{ action: "Answer mock question 1 about system design" }],
  blocking: { isBlocked: false },
});

describe("create task -> write note -> new session sees the verified status line", () => {
  it("runs the whole cold-start path", async () => {
    await prisma.deepMatchDetail.create({
      data: { matchAnalysisId: sprint.match.id, overallSummary: "ok", overallScore: 88 },
    });

    // 1. A session works on the task; its turn finishes and the note is written.
    const written = await runTaskHandoff(
      { userId: sprint.userId, conversationId: sprint.conversation.id, taskId: sprint.task.id },
      {
        db: prisma,
        now: () => Date.now(),
        loadSession: async () => ({ messages: [], resolvedConnectionId: "c", resolvedModel: "m", summary: null }),
        executeText: async () => ({ text: NOTE }),
      },
    );
    expect(written).toMatchObject({ status: "committed", revision: 1 });

    // 2. Days pass: the task is paused; meanwhile the analysis goes stale.
    await transitionAgentTaskStatus(prisma, {
      userId: sprint.userId,
      taskId: sprint.task.id,
      to: AGENT_TASK_STATUS.PAUSED,
    });
    expect((await getAgentTask(prisma, { userId: sprint.userId, taskId: sprint.task.id }))?.activeSessionId).toBeNull();
    await prisma.matchAnalysis.update({ where: { id: sprint.match.id }, data: { isStale: true } });

    // 3. "Continue task": a NEW Pilot session is created, bound and claimed.
    const resumed = await resumeAgentTaskSession(prisma, {
      userId: sprint.userId,
      taskId: sprint.task.id,
      createConversation: async ({ task }) =>
        prisma.chatConversation.create({
          data: { userId: sprint.userId, messages: "[]", agentRole: "pilot", agentTaskId: task.id },
        }),
    });
    if (!resumed.ok) throw new Error(resumed.code);
    expect(resumed.created).toBe(true);
    expect(resumed.conversationId).not.toBe(sprint.conversation.id);
    expect(resumed.handoffRevision).toBe(1);
    // The old note's prose is carried, but the facts come from the database.
    expect(resumed.handoffLine).toContain("Reviewed the JD fit and started mock session 1.");
    expect(resumed.handoffLine).toContain("Answer mock question 1 about system design");
    expect(resumed.handoffLine).toContain("已失效");
    expect(resumed.handoffLine).not.toContain("88");
    expect(resumed.handoffLine).toContain("milestone=PREPARING");
    expect(resumed.handoffLine).toContain("[ ] jd-fit-reviewed");

    // 4. The route resolves the same session context for the new conversation...
    const session = await resolveTaskSessionContext(prisma, {
      userId: sprint.userId,
      agentTaskId: resumed.task.id,
      agentRole: "pilot",
    });
    expect(session?.taskId).toBe(sprint.task.id);
    expect(session?.extraTools).toEqual(["match_job", "get_resume"]);
    expect(session?.handoffLine).toContain("已失效");
    expect(session?.handoffLine).toContain("Answer mock question 1 about system design");

    // 5. ...and the prompt the model sees carries that line, for every profile.
    const messages = [
      { id: "u1", role: "user", parts: [{ type: "text", text: "继续推进这个任务。" }] },
    ] as never;
    for (const profile of ["FAST_CHAT", "AGENT_DECISION", "AGENT_RESPONSE"] as const) {
      const { prompt } = renderCareerDialoguePrompt({
        profile,
        systemPrompt: buildAgentChatSystemPrompt("zh-CN", {
          agentRole: "pilot",
          taskExtraTools: session!.extraTools,
        }),
        messages,
        agentRole: "pilot",
        agentTaskId: session!.taskId,
        handoffLine: session!.handoffLine,
        toolsBlock: "",
      });
      expect(prompt).toContain("Active task state (system-maintained, verified");
      expect(prompt).toContain("已失效");
      expect(prompt).toContain("long-running job-search task");
    }
  });

  it("an ordinary conversation bound to nothing resolves to no task session", async () => {
    const plain = await prisma.chatConversation.create({
      data: { userId: sprint.userId, messages: "[]", agentRole: "pilot" },
    });
    expect(
      await resolveTaskSessionContext(prisma, { userId: sprint.userId, agentTaskId: plain.agentTaskId, agentRole: "pilot" }),
    ).toBeNull();
  });

  it("a paused task degrades its bound session to an ordinary chat (no tools, no line)", async () => {
    await transitionAgentTaskStatus(prisma, {
      userId: sprint.userId,
      taskId: sprint.task.id,
      to: AGENT_TASK_STATUS.PAUSED,
    });
    expect(
      await resolveTaskSessionContext(prisma, { userId: sprint.userId, agentTaskId: sprint.task.id, agentRole: "pilot" }),
    ).toBeNull();
  });

  it("a grounding failure never fails the turn: tools stay, the line is omitted", async () => {
    const broken = new Proxy(prisma, {
      get(target, prop, receiver) {
        if (prop === "interviewPrepGoal") throw new Error("grounding db error");
        return Reflect.get(target, prop, receiver);
      },
    });
    const session = await resolveTaskSessionContext(broken, {
      userId: sprint.userId,
      agentTaskId: sprint.task.id,
      agentRole: "pilot",
    });
    expect(session).toMatchObject({ taskId: sprint.task.id, extraTools: ["match_job", "get_resume"] });
    expect(session?.handoffLine).toBeUndefined();
  });
});

// @vitest-environment node
/**
 * Grounding verifier (spec section 9) against an isolated database: stale
 * analysis, deleted evidence, dangling restored pointers, drift, line shape.
 * Deterministic code only: there is no model in this module.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { verifyTaskGrounding } from "@/lib/agent/task/agentTaskGrounding";
import { computeHandoffStateHash } from "@/lib/agent/task/agentTaskHandoffStore";
import { listTaskEvents } from "@/lib/agent/task/agentTaskEvents";
import { estimateContextTokens } from "@/lib/agent/contextBudget";
import { APP_CONSTANTS } from "@/lib/constants";
import type { AgentTaskHandoffState } from "@/models/agentTask.schema";
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

/** Insert a handoff row directly (bypasses the commit pointer gate, like a restored backup). */
async function insertHandoff(state: AgentTaskHandoffState, revision = 1, stateHash?: string) {
  await prisma.agentTaskHandoff.create({
    data: {
      taskId: sprint.task.id,
      revision,
      state: JSON.stringify(state),
      stateHash: stateHash ?? computeHandoffStateHash(state),
      sessionId: sprint.conversation.id,
    },
  });
}

const verify = (extra: Partial<Parameters<typeof verifyTaskGrounding>[1]> = {}) =>
  verifyTaskGrounding(prisma, { userId: sprint.userId, taskId: sprint.task.id, ...extra });

const codes = (g: NonNullable<Awaited<ReturnType<typeof verify>>>) =>
  g.discrepancies.map((d) => d.code);

describe("verifyTaskGrounding", () => {
  it("first run (no handoff yet): initial verified line from domain state", async () => {
    await prisma.deepMatchDetail.create({
      data: { matchAnalysisId: sprint.match.id, overallSummary: "ok", overallScore: 88 },
    });
    const g = (await verify())!;
    expect(g.handoffRevision).toBeNull();
    expect(g.milestone).toBe("PRACTICING");
    expect(g.discrepancies).toEqual([]);
    expect(g.verifiedLine).toContain("Active task state (system-maintained, verified ");
    expect(g.verifiedLine).toContain("milestone=PRACTICING");
    expect(g.verifiedLine).toContain("88");
    expect(g.verifiedLine).toContain("[x] prep-goal-active [x] jd-fit-reviewed [ ] mock-session-1 [ ] session-summary-reviewed");
    expect(g.verifiedLine).toContain("Next:");
  });

  it("with a consistent handoff: shows the note prose and the first next action, no discrepancies", async () => {
    await insertHandoff(
      handoffStateFor(sprint, {
        completedWork: {
          summary: "Reviewed JD fit; one mock session started.",
          jobOpportunityIds: [sprint.job.id],
          jobDescriptionVersionIds: [sprint.jd.id],
          interviewPrepGoalIds: [sprint.goal.id],
          matchAnalysisIds: [sprint.match.id],
          interviewSessionIds: [sprint.interview.id],
        },
        nextActions: [{ action: "Answer the first mock question." }, { action: "second" }],
        criticalConstraints: ["Remote only"],
      }),
    );
    const g = (await verify())!;
    expect(g.handoffRevision).toBe(1);
    expect(g.discrepancies).toEqual([]);
    expect(g.verifiedLine).toContain("Reviewed JD fit; one mock session started.");
    expect(g.verifiedLine).toContain("Next: Answer the first mock question.");
    expect(g.verifiedLine).not.toContain("second");
    expect(g.verifiedLine).toContain("Remote only");
  });

  it("never renders entity ids into the line", async () => {
    await insertHandoff(handoffStateFor(sprint));
    const g = (await verify())!;
    for (const id of [sprint.job.id, sprint.jd.id, sprint.goal.id, sprint.match.id, sprint.interview.id, sprint.task.id]) {
      expect(g.verifiedLine).not.toContain(id);
    }
  });

  it("flags a stale analysis as 已失效 instead of reusing the old conclusion (zh) and STALE (en)", async () => {
    await prisma.deepMatchDetail.create({
      data: { matchAnalysisId: sprint.match.id, overallSummary: "ok", overallScore: 91 },
    });
    await insertHandoff(handoffStateFor(sprint));
    await prisma.matchAnalysis.update({ where: { id: sprint.match.id }, data: { isStale: true } });
    const zh = (await verify())!;
    expect(codes(zh)).toContain("analysis_stale");
    expect(zh.verifiedLine).toContain("已失效");
    expect(zh.verifiedLine).not.toContain("91");
    expect(zh.milestone).toBe("PREPARING");
    expect(zh.verifiedLine).toContain("[ ] jd-fit-reviewed");

    const en = (await verify({ locale: "en" }))!;
    expect(en.verifiedLine).toContain("STALE");
    expect(en.verifiedLine).not.toContain("已失效");
  });

  it("flags a stale analysis even when no handoff exists", async () => {
    await prisma.matchAnalysis.update({ where: { id: sprint.match.id }, data: { isStale: true } });
    const g = (await verify())!;
    expect(codes(g)).toContain("analysis_stale");
    expect(g.verifiedLine).toContain("已失效");
  });

  it("evidence the note claims but the database cannot back falls back to not passed", async () => {
    await insertHandoff(
      handoffStateFor(sprint, {
        acceptanceSnapshot: [
          { key: "mock-session-1", passes: true, evidenceRef: sprint.interview.id },
          { key: "prep-goal-active", passes: true, evidenceRef: sprint.goal.id },
        ],
      }),
    );
    const g = (await verify())!;
    // prep-goal-active is real; mock-session-1 has no answered question.
    expect(g.discrepancies).toContainEqual({ code: "acceptance_revoked", key: "mock-session-1" });
    expect(g.discrepancies.some((d) => d.key === "prep-goal-active")).toBe(false);
    expect(g.verifiedLine).toContain("[ ] mock-session-1");
    expect(g.acceptanceItems.find((i) => i.key === "mock-session-1")).toMatchObject({ passes: false });
  });

  it("a deleted evidence entity is both a dangling pointer and a revoked item", async () => {
    await prisma.questionInstance.create({
      data: {
        sessionId: sprint.interview.id,
        displayOrder: 1,
        displayedText: "q",
        sourceKind: "USER_PROVIDED",
        status: "ANSWERED",
      },
    });
    await insertHandoff(
      handoffStateFor(sprint, {
        acceptanceSnapshot: [{ key: "mock-session-1", passes: true, evidenceRef: sprint.interview.id }],
      }),
    );
    expect((await verify())!.acceptanceItems.find((i) => i.key === "mock-session-1")?.passes).toBe(true);

    await prisma.questionInstance.deleteMany({ where: { sessionId: sprint.interview.id } });
    await prisma.interviewSession.delete({ where: { id: sprint.interview.id } });
    const g = (await verify())!;
    expect(g.discrepancies).toContainEqual({
      code: "pointer_missing",
      key: "interviewSessionIds",
      id: sprint.interview.id,
    });
    expect(codes(g)).toContain("acceptance_revoked");
    expect(g.acceptanceItems.find((i) => i.key === "mock-session-1")?.passes).toBe(false);
    expect(g.verifiedLine).toContain("interviewSessionIds");
    expect(g.verifiedLine).not.toContain(sprint.interview.id);
  });

  it("restored dangling ids surface as discrepancies instead of crashing, and are audited on request", async () => {
    await insertHandoff(
      handoffStateFor(sprint, {
        completedWork: {
          summary: "restored",
          jobOpportunityIds: [sprint.job.id, "gone-job"],
          jobDescriptionVersionIds: ["gone-jd"],
          interviewPrepGoalIds: [],
          matchAnalysisIds: ["gone-match"],
          interviewSessionIds: [],
        },
      }),
    );
    const quiet = (await verify())!;
    expect(quiet.discrepancies.filter((d) => d.code === "pointer_missing").map((d) => d.id).sort()).toEqual([
      "gone-jd",
      "gone-job",
      "gone-match",
    ]);
    let events = await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    expect(events.filter((e) => e.kind === "GROUNDING")).toHaveLength(0);

    await verify({ recordEvents: true });
    events = await listTaskEvents(prisma, { userId: sprint.userId, taskId: sprint.task.id });
    const grounding = events.filter((e) => e.kind === "GROUNDING");
    expect(grounding.length).toBeGreaterThanOrEqual(3);
    expect(grounding.map((e) => e.payload.code)).toContain("pointer_missing");
    expect(grounding[0].payload.handoffRevision).toBe(1);
  });

  it("note milestone that disagrees with the database is corrected and reported", async () => {
    await insertHandoff(handoffStateFor(sprint, { milestone: "REVIEWING" }));
    const g = (await verify())!;
    expect(g.milestone).toBe("PRACTICING");
    expect(codes(g)).toContain("milestone_drift");
    expect(g.verifiedLine).toContain("便签称 milestone=REVIEWING，实际 PRACTICING");
    expect(g.verifiedLine).toContain("milestone=PRACTICING");
  });

  it("closed / archived opportunity, ended goal, archived session, foreign-job JD version", async () => {
    const otherCompany = await prisma.company.findFirstOrThrow({});
    const otherJob = await prisma.jobOpportunity.create({
      data: { userId: sprint.userId, companyId: otherCompany.id, title: "Other" },
    });
    const otherJd = await prisma.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: otherJob.id,
        versionNumber: 1,
        rawContent: "o",
        capturedAt: new Date(),
        contentHash: `o-${randomUUID()}`,
      },
    });
    await insertHandoff(
      handoffStateFor(sprint, {
        completedWork: {
          summary: "s",
          jobOpportunityIds: [sprint.job.id],
          jobDescriptionVersionIds: [otherJd.id],
          interviewPrepGoalIds: [sprint.goal.id],
          matchAnalysisIds: [sprint.match.id],
          interviewSessionIds: [sprint.interview.id],
        },
      }),
    );
    await prisma.jobOpportunity.update({ where: { id: sprint.job.id }, data: { status: "CLOSED" } });
    await prisma.interviewPrepGoal.update({ where: { id: sprint.goal.id }, data: { status: "ENDED", liveSlot: null } });
    await prisma.interviewSession.update({ where: { id: sprint.interview.id }, data: { status: "ARCHIVED" } });
    const g = (await verify())!;
    expect(codes(g)).toEqual(
      expect.arrayContaining(["job_closed", "jd_version_mismatch", "prep_goal_ended", "session_archived"]),
    );

    await prisma.jobOpportunity.update({ where: { id: sprint.job.id }, data: { status: "OPEN", archivedAt: new Date() } });
    expect(codes((await verify())!)).toContain("job_archived");
  });

  it("an unreadable or tampered note is reported and its prose is not trusted", async () => {
    await prisma.agentTaskHandoff.create({
      data: { taskId: sprint.task.id, revision: 1, state: "{not json", stateHash: "x" },
    });
    const corrupt = (await verify())!;
    expect(codes(corrupt)).toEqual(["handoff_corrupt"]);
    expect(corrupt.verifiedLine).toContain("Next:");

    await prisma.agentTaskHandoff.deleteMany({});
    await insertHandoff(handoffStateFor(sprint), 1, "0".repeat(64));
    expect(codes((await verify())!)).toContain("hash_mismatch");
  });

  it("is ownership-scoped", async () => {
    const intruder = await seedAccount(prisma, `x-${randomUUID()}@example.com`);
    expect(await verifyTaskGrounding(prisma, { userId: intruder, taskId: sprint.task.id })).toBeNull();
  });

  it("keeps the line inside the handoff token budget even with maximal prose", async () => {
    await insertHandoff(
      handoffStateFor(sprint, {
        completedWork: {
          summary: "进展".repeat(750),
          jobOpportunityIds: [sprint.job.id],
          jobDescriptionVersionIds: [sprint.jd.id],
          interviewPrepGoalIds: [sprint.goal.id],
          matchAnalysisIds: [sprint.match.id],
          interviewSessionIds: [sprint.interview.id],
        },
        nextActions: [{ action: "下".repeat(300) }],
        criticalConstraints: Array.from({ length: 10 }, (_, i) => `约束${i}`.padEnd(200, "束")),
      }),
    );
    const g = (await verify())!;
    expect(estimateContextTokens(g.verifiedLine)).toBeLessThanOrEqual(APP_CONSTANTS.AGENT_TASK_HANDOFF_TOKENS);
  });
});

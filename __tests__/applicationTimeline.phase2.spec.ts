// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  CareerRuntimeError,
  COMPATIBILITY_PROCESS_STEPS,
  OpportunityService,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_SOURCE,
  PROCESS_STEP_STATUS,
  ResumeVariantService,
  writeInstanceMigrationState,
} from "@/lib/career";
import { syncApplicationFromUiStatus } from "@/lib/career/jobOpportunityAdapter";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true" };

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;
let companyId: string;

beforeAll(() => {
  pushSchema(ctx.url);
}, 120_000);

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
  userId = await seedAccount(prisma, `timeline-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `timeline-other-${Date.now()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-timeline-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
});

function services(ownerId = userId) {
  return {
    opportunities: new OpportunityService(prisma, ownerId, FEATURE_ON),
    applications: new ApplicationService(prisma, ownerId, FEATURE_ON),
    variants: new ResumeVariantService(prisma, ownerId, FEATURE_ON),
  };
}

async function createOpportunity() {
  const { opportunities } = services();
  return opportunities.create({ companyId, title: "Staff Engineer" });
}

describe("Application timeline read", () => {
  it("rejects a cross-user opportunity", async () => {
    const opportunity = await createOpportunity();
    const other = new ApplicationService(prisma, otherUserId, FEATURE_ON);
    await expect(other.getTimeline(opportunity.id)).rejects.toMatchObject({
      code: "OPPORTUNITY_NOT_FOUND",
    });
  });

  it("returns an empty attempts list when the opportunity has none", async () => {
    const opportunity = await createOpportunity();
    const timeline = await services().applications.getTimeline(opportunity.id);
    expect(timeline).toEqual({
      opportunityId: opportunity.id,
      attempts: [],
    });
  });

  it("returns one attempt with a null submitted resume", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts).toHaveLength(1);
    expect(timeline.attempts[0].id).toBe(attempt.id);
    expect(timeline.attempts[0].submittedResume).toBeNull();
    expect(timeline.attempts[0]).not.toHaveProperty("userId");
    expect(timeline.attempts[0]).not.toHaveProperty("submittedResumeVersionId");
  });

  it("returns bound submitted resume metadata without mapping a legacy resume", async () => {
    const { applications, variants } = services();
    const opportunity = await createOpportunity();
    const variant = await variants.createVariant({ name: "General" });
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Referral",
    });
    await applications.markSubmitted({
      attemptId: attempt.id,
      submittedResumeVersionId: variant.currentVersionId!,
    });
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts[0].submittedResume).toEqual({
      id: variant.currentVersionId,
      title: "General",
      versionNumber: 1,
    });
  });

  it("orders multiple attempts by submittedAt then createdAt", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const first = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "First",
    });
    const second = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Second",
    });
    await applications.markSubmitted({
      attemptId: first.id,
      submittedAt: new Date("2024-02-01T00:00:00.000Z"),
    });
    await applications.markSubmitted({
      attemptId: second.id,
      submittedAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts.map((row) => row.id)).toEqual([second.id, first.id]);
  });

  it("orders steps by sortOrder, then scheduledAt, then createdAt", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const late = await applications.upsertProcessStep({
      attemptId: attempt.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Late",
      sortOrder: 10,
      scheduledAt: new Date("2024-03-01T00:00:00.000Z"),
    });
    const early = await applications.upsertProcessStep({
      attemptId: attempt.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Early",
      sortOrder: 10,
      scheduledAt: new Date("2024-01-01T00:00:00.000Z"),
    });
    const first = await applications.upsertProcessStep({
      attemptId: attempt.id,
      category: PROCESS_STEP_CATEGORY.SCREENING,
      label: "Screen",
      sortOrder: 1,
    });
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts[0].steps.map((step) => step.id)).toEqual([
      first.id,
      early.id,
      late.id,
    ]);
  });
});

describe("Application process step writes", () => {
  it("creates a USER step with category, label, schedule and notes", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const scheduledAt = new Date("2024-05-01T12:00:00.000Z");
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Hiring manager",
      scheduledAt,
      notes: "Bring portfolio",
    });
    expect(step.source).toBe(PROCESS_STEP_SOURCE.USER);
    expect(step.category).toBe(PROCESS_STEP_CATEGORY.INTERVIEW);
    expect(step.label).toBe("Hiring manager");
    expect(step.status).toBe(PROCESS_STEP_STATUS.PENDING);
    expect(step.scheduledAt?.toISOString()).toBe(scheduledAt.toISOString());
    expect(step.notes).toBe("Bring portfolio");
    expect(step.sortOrder).toBe(10);
  });

  it("rejects create and update from another user", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Follow up",
    });
    const other = new ApplicationService(prisma, otherUserId, FEATURE_ON);
    await expect(
      other.createUserProcessStep({
        jobOpportunityId: opportunity.id,
        category: PROCESS_STEP_CATEGORY.OTHER,
        label: "Intruder",
      }),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
    await expect(
      other.updateUserProcessStep({ stepId: step.id, notes: "nope" }),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_NOT_FOUND" });
    await expect(other.completeProcessStep(step.id)).rejects.toMatchObject({
      code: "PROCESS_STEP_NOT_FOUND",
    });
    await expect(other.deleteUserProcessStep(step.id)).rejects.toMatchObject({
      code: "PROCESS_STEP_NOT_FOUND",
    });
    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).not.toBeNull();
  });

  it("completes a pending step without mutating attempt outcome", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Round 1",
    });
    const completed = await applications.completeProcessStep(step.id);
    expect(completed.status).toBe(PROCESS_STEP_STATUS.COMPLETED);
    expect(completed.completedAt).toBeInstanceOf(Date);
    const again = await applications.completeProcessStep(step.id);
    expect(again.completedAt?.toISOString()).toBe(
      completed.completedAt?.toISOString(),
    );
    const reread = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(reread.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(reread.currentStageCategory).toBe(ATTEMPT_STAGE.DRAFT);
    expect(await prisma.job.count()).toBe(0);
  });

  it("adding an Interview step does not advance Attempt stage or write Job", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    await applications.markSubmitted({ attemptId: attempt.id });
    await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Future interview",
      scheduledAt: new Date("2026-12-01T00:00:00.000Z"),
    });
    const reread = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(reread.currentStageCategory).toBe(ATTEMPT_STAGE.SUBMITTED);
    expect(reread.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(await prisma.job.count()).toBe(0);
  });

  it("lets a completed step keep notes/result edits without rewriting history", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Online test",
    });
    await applications.completeProcessStep(step.id);
    const updated = await applications.updateUserProcessStep({
      stepId: step.id,
      category: PROCESS_STEP_CATEGORY.OFFER,
      label: "should not apply",
      notes: "scored well",
      result: "pass",
    });
    expect(updated.category).toBe(PROCESS_STEP_CATEGORY.ASSESSMENT);
    expect(updated.label).toBe("Online test");
    expect(updated.status).toBe(PROCESS_STEP_STATUS.COMPLETED);
    expect(updated.notes).toBe("scored well");
    expect(updated.result).toBe("pass");
  });

  it("creates steps with scheduledAt only, deadlineAt only, both, or neither", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const scheduledAt = new Date("2026-10-01T00:00:00.000Z");
    const deadlineAt = new Date("2026-10-03T00:00:00.000Z");
    const scheduledOnly = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Scheduled only",
      scheduledAt,
    });
    const deadlineOnly = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Deadline only",
      deadlineAt,
    });
    const both = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Both times",
      scheduledAt,
      deadlineAt,
    });
    const neither = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Neither time",
    });
    expect(scheduledOnly.scheduledAt?.toISOString()).toBe(scheduledAt.toISOString());
    expect(scheduledOnly.deadlineAt).toBeNull();
    expect(deadlineOnly.scheduledAt).toBeNull();
    expect(deadlineOnly.deadlineAt?.toISOString()).toBe(deadlineAt.toISOString());
    expect(both.scheduledAt?.toISOString()).toBe(scheduledAt.toISOString());
    expect(both.deadlineAt?.toISOString()).toBe(deadlineAt.toISOString());
    expect(neither.scheduledAt).toBeNull();
    expect(neither.deadlineAt).toBeNull();
  });

  it("updates and clears deadlineAt, and serializes it on the timeline DTO", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Online test",
      deadlineAt: new Date("2026-10-05T00:00:00.000Z"),
    });
    const updated = await applications.updateUserProcessStep({
      stepId: step.id,
      deadlineAt: new Date("2026-10-08T00:00:00.000Z"),
    });
    expect(updated.deadlineAt?.toISOString()).toBe("2026-10-08T00:00:00.000Z");
    const cleared = await applications.updateUserProcessStep({
      stepId: step.id,
      deadlineAt: null,
    });
    expect(cleared.deadlineAt).toBeNull();
    const restored = await applications.updateUserProcessStep({
      stepId: step.id,
      deadlineAt: new Date("2026-10-09T00:00:00.000Z"),
    });
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts[0].steps[0].deadlineAt).toBe(
      restored.deadlineAt?.toISOString(),
    );
  });

  it("does not change deadlineAt when completing a step", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const deadlineAt = new Date("2026-10-04T00:00:00.000Z");
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Round 1",
      deadlineAt,
    });
    const completed = await applications.completeProcessStep(step.id);
    expect(completed.deadlineAt?.toISOString()).toBe(deadlineAt.toISOString());
    expect(completed.status).toBe(PROCESS_STEP_STATUS.COMPLETED);
  });

  it("does not let SYSTEM or completed steps change deadlineAt", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const system = await applications.ensureCompatibilityProcessStep({
      attemptId: attempt.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Interview",
      sortOrder: 20,
      status: PROCESS_STEP_STATUS.PENDING,
    });
    const user = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.ASSESSMENT,
      label: "Test",
      deadlineAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    await applications.completeProcessStep(user.id);
    const systemUpdated = await applications.updateUserProcessStep({
      stepId: system.id,
      deadlineAt: new Date("2026-10-02T00:00:00.000Z"),
    });
    const completedUpdated = await applications.updateUserProcessStep({
      stepId: user.id,
      deadlineAt: new Date("2026-10-03T00:00:00.000Z"),
    });
    expect(systemUpdated.deadlineAt).toBeNull();
    expect(completedUpdated.deadlineAt?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });
});

describe("Application process step delete", () => {
  async function createOwnedStep(input?: {
    status?: string;
    source?: string;
    category?: string;
    label?: string;
    deadlineAt?: Date | null;
  }) {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const source = input?.source ?? PROCESS_STEP_SOURCE.USER;
    const step =
      source === PROCESS_STEP_SOURCE.USER
        ? await applications.createUserProcessStep({
            jobOpportunityId: opportunity.id,
            category: input?.category ?? PROCESS_STEP_CATEGORY.INTERVIEW,
            label: input?.label ?? "Round 1",
            deadlineAt: input?.deadlineAt ?? null,
          })
        : await prisma.applicationProcessStep.create({
            data: {
              applicationAttemptId: attempt.id,
              category: input?.category ?? PROCESS_STEP_CATEGORY.INTERVIEW,
              label: input?.label ?? "Imported step",
              sortOrder: 40,
              status: PROCESS_STEP_STATUS.PENDING,
              source,
              deadlineAt: input?.deadlineAt ?? null,
            },
          });
    if (input?.status === PROCESS_STEP_STATUS.COMPLETED) {
      await applications.completeProcessStep(step.id);
    } else if (
      input?.status === PROCESS_STEP_STATUS.IN_PROGRESS &&
      source === PROCESS_STEP_SOURCE.USER
    ) {
      await prisma.applicationProcessStep.update({
        where: { id: step.id },
        data: { status: PROCESS_STEP_STATUS.IN_PROGRESS },
      });
    }
    const current = await prisma.applicationProcessStep.findUniqueOrThrow({
      where: { id: step.id },
    });
    return { applications, opportunity, attempt, step: current };
  }

  it("deletes a USER pending step and leaves the attempt", async () => {
    const { applications, opportunity, attempt, step } = await createOwnedStep();
    const before = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    await applications.deleteUserProcessStep(step.id);
    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).toBeNull();
    const after = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(after.currentStageCategory).toBe(before.currentStageCategory);
    expect(after.outcome).toBe(before.outcome);
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts).toHaveLength(1);
    expect(timeline.attempts[0].id).toBe(attempt.id);
    expect(timeline.attempts[0].steps).toEqual([]);
  });

  it("deletes a USER completed step after explicit delete", async () => {
    const { applications, attempt, step } = await createOwnedStep({
      status: PROCESS_STEP_STATUS.COMPLETED,
    });
    expect(step.status).toBe(PROCESS_STEP_STATUS.COMPLETED);
    await applications.deleteUserProcessStep(step.id);
    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).toBeNull();
    expect(
      await prisma.applicationAttempt.findUnique({ where: { id: attempt.id } }),
    ).not.toBeNull();
  });

  it("deletes a USER in-progress step", async () => {
    const { applications, step } = await createOwnedStep({
      status: PROCESS_STEP_STATUS.IN_PROGRESS,
    });
    await applications.deleteUserProcessStep(step.id);
    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).toBeNull();
  });

  it("rejects deleting a SYSTEM step and leaves the row", async () => {
    const { applications, step } = await createOwnedStep({
      source: PROCESS_STEP_SOURCE.SYSTEM,
      label: "Interview",
    });
    await expect(applications.deleteUserProcessStep(step.id)).rejects.toMatchObject({
      code: "PROCESS_STEP_DELETE_NOT_ALLOWED",
    });
    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).not.toBeNull();
  });

  it("rejects deleting IMPORT and AUTOMATION steps", async () => {
    const imported = await createOwnedStep({
      source: PROCESS_STEP_SOURCE.IMPORT,
      label: "Imported",
    });
    const automated = await createOwnedStep({
      source: PROCESS_STEP_SOURCE.AUTOMATION,
      label: "Automated",
    });
    await expect(
      imported.applications.deleteUserProcessStep(imported.step.id),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_DELETE_NOT_ALLOWED" });
    await expect(
      automated.applications.deleteUserProcessStep(automated.step.id),
    ).rejects.toMatchObject({ code: "PROCESS_STEP_DELETE_NOT_ALLOWED" });
    expect(
      await prisma.applicationProcessStep.findUnique({
        where: { id: imported.step.id },
      }),
    ).not.toBeNull();
    expect(
      await prisma.applicationProcessStep.findUnique({
        where: { id: automated.step.id },
      }),
    ).not.toBeNull();
  });

  it("does not change Attempt stage or outcome when deleting INTERVIEW or OFFER steps", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    await applications.updateStage(attempt.id, ATTEMPT_STAGE.INTERVIEW);
    await applications.recordOutcome(attempt.id, ATTEMPT_OUTCOME.OFFER);
    const interview = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "一面",
    });
    const offer = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OFFER,
      label: "Offer",
    });
    await applications.deleteUserProcessStep(interview.id);
    await applications.deleteUserProcessStep(offer.id);
    const after = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(after.currentStageCategory).toBe(ATTEMPT_STAGE.INTERVIEW);
    expect(after.outcome).toBe(ATTEMPT_OUTCOME.OFFER);
  });

  it("does not write a legacy Job when deleting a process step", async () => {
    const { applications, step } = await createOwnedStep();
    expect(await prisma.job.count()).toBe(0);
    await applications.deleteUserProcessStep(step.id);
    expect(await prisma.job.count()).toBe(0);
  });

  it("does not change TRANSFERRED outcome when a remaining step is deleted", async () => {
    const { applications, opportunity, attempt, step } = await createOwnedStep();
    await applications.recordOutcome(attempt.id, ATTEMPT_OUTCOME.TRANSFERRED);
    await applications.deleteUserProcessStep(step.id);
    const after = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(after.outcome).toBe(ATTEMPT_OUTCOME.TRANSFERRED);
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts[0].outcome).toBe(ATTEMPT_OUTCOME.TRANSFERRED);
    expect(timeline.attempts[0].steps).toEqual([]);
  });

  it("cascades attached interview detail because schema ON DELETE is Cascade", async () => {
    const { applications, attempt, step } = await createOwnedStep();
    await prisma.applicationInterviewDetail.create({
      data: { applicationProcessStepId: step.id, roundLabel: "一面" },
    });
    await applications.deleteUserProcessStep(step.id);
    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).toBeNull();
    expect(await prisma.applicationInterviewDetail.count()).toBe(0);
    expect(
      await prisma.applicationAttempt.findUnique({ where: { id: attempt.id } }),
    ).not.toBeNull();
  });
});

describe("Header status no longer creates compatibility ProcessSteps", () => {
  it("does not create an INTERVIEW ProcessStep when status becomes interview", async () => {
    const opportunity = await createOpportunity();
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    const attempt = await prisma.applicationAttempt.findFirstOrThrow();
    expect(attempt.currentStageCategory).toBe(ATTEMPT_STAGE.INTERVIEW);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("does not create an OFFER ProcessStep when status becomes offer", async () => {
    const opportunity = await createOpportunity();
    await syncApplicationFromUiStatus(prisma, userId, opportunity.id, "interview", {
      env: FEATURE_ON,
    });
    await syncApplicationFromUiStatus(prisma, userId, opportunity.id, "offer", {
      env: FEATURE_ON,
    });
    const attempt = await prisma.applicationAttempt.findFirstOrThrow();
    expect(attempt.currentStageCategory).toBe(ATTEMPT_STAGE.OFFER);
    expect(attempt.outcome).toBe(ATTEMPT_OUTCOME.OFFER);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });

  it("leaves an existing USER interview step alone when status becomes interview", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const userStep = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "一面",
    });
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    const steps = await prisma.applicationProcessStep.findMany();
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe(userStep.id);
    expect(steps[0].source).toBe(PROCESS_STEP_SOURCE.USER);
    expect(steps[0].label).toBe("一面");
  });

  it("still returns a historical SYSTEM compatibility step from getTimeline", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    await prisma.applicationProcessStep.create({
      data: {
        applicationAttemptId: attempt.id,
        category: COMPATIBILITY_PROCESS_STEPS.INTERVIEW.category,
        label: COMPATIBILITY_PROCESS_STEPS.INTERVIEW.label,
        sortOrder: COMPATIBILITY_PROCESS_STEPS.INTERVIEW.sortOrder,
        status: PROCESS_STEP_STATUS.IN_PROGRESS,
        source: PROCESS_STEP_SOURCE.SYSTEM,
      },
    });
    await syncApplicationFromUiStatus(
      prisma,
      userId,
      opportunity.id,
      "interview",
      { env: FEATURE_ON },
    );
    const timeline = await applications.getTimeline(opportunity.id);
    expect(timeline.attempts[0].steps).toHaveLength(1);
    expect(timeline.attempts[0].steps[0].source).toBe(PROCESS_STEP_SOURCE.SYSTEM);
    expect(timeline.attempts[0].steps[0].label).toBe(
      COMPATIBILITY_PROCESS_STEPS.INTERVIEW.label,
    );
    expect(await prisma.applicationProcessStep.count()).toBe(1);
  });

  it("does not allocate reserved compatibility sortOrder 20 or 30 to user steps", async () => {
    const { applications } = services();
    const opportunity = await createOpportunity();
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const first = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Prep",
    });
    const second = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Interview",
    });
    const third = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.OTHER,
      label: "Follow up",
    });
    expect(first.sortOrder).not.toBe(20);
    expect(first.sortOrder).not.toBe(30);
    expect(second.sortOrder).not.toBe(20);
    expect(second.sortOrder).not.toBe(30);
    expect(third.sortOrder).not.toBe(20);
    expect(third.sortOrder).not.toBe(30);
  });
});

describe("ApplicationService ownership", () => {
  it("throws CareerRuntimeError for an unknown opportunity", async () => {
    await expect(
      services().applications.getTimeline("missing-opportunity"),
    ).rejects.toBeInstanceOf(CareerRuntimeError);
  });
});

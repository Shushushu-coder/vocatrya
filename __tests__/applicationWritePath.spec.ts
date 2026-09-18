// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  CAREER_RUNTIME_MODE,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_SOURCE,
  PROCESS_STEP_STATUS,
  activateFreshAbNative,
  resolveCareerRuntimeMode,
} from "@/lib/career";
import {
  createOpportunityFromJobForm,
  syncApplicationFromUiStatus,
} from "@/lib/career/jobOpportunityAdapter";
import { createJobRecord } from "@/lib/jobs/createJobRecord";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true" };
const FEATURE_OFF = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "false" };
const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let companyId: string;
let titleId: string;
let locationId: string;
let sourceId: string;
let draftStatusId: string;
let appliedStatusId: string;

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
  userId = await seedAccount(prisma, `ab-write-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-write-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  titleId = (
    await prisma.jobTitle.create({
      data: {
        label: "Engineer",
        value: `eng-write-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  locationId = (
    await prisma.location.create({
      data: {
        label: "Remote",
        value: `remote-write-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  sourceId = (
    await prisma.jobSource.findFirstOrThrow({ where: { createdBy: userId } })
  ).id;
  draftStatusId = (
    await prisma.jobStatus.findFirstOrThrow({ where: { value: "draft" } })
  ).id;
  appliedStatusId = (
    await prisma.jobStatus.findFirstOrThrow({ where: { value: "applied" } })
  ).id;
});

async function enableAb() {
  await activateFreshAbNative(prisma);
}

async function createDraftOpportunity() {
  return createOpportunityFromJobForm(
    prisma,
    userId,
    {
      title: titleId,
      company: companyId,
      location: locationId,
      type: "FT",
      source: sourceId,
      status: draftStatusId,
      dueDate: new Date(),
      jobDescription: "Write-path role",
      applied: false,
    },
    FEATURE_ON,
  );
}

describe("A+B native Attempt status write", () => {
  it("writes stage/outcome onto ApplicationAttempt and never onto Job", async () => {
    await enableAb();
    const created = await createDraftOpportunity();
    expect(await prisma.job.count()).toBe(0);

    await syncApplicationFromUiStatus(prisma, userId, created.id, "applied", {
      applied: true,
      env: FEATURE_ON,
    });
    const submitted = await prisma.applicationAttempt.findFirstOrThrow();
    expect(submitted.currentStageCategory).toBe(ATTEMPT_STAGE.SUBMITTED);
    expect(submitted.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(submitted.submittedAt).toBeInstanceOf(Date);
    expect(await prisma.job.count()).toBe(0);

    await syncApplicationFromUiStatus(prisma, userId, created.id, "interview", {
      applied: true,
      env: FEATURE_ON,
    });
    const interviewing = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: submitted.id },
    });
    expect(interviewing.currentStageCategory).toBe(ATTEMPT_STAGE.INTERVIEW);
    expect(interviewing.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("does not create INTERVIEW or OFFER compatibility ProcessSteps", async () => {
    await enableAb();
    const created = await createDraftOpportunity();
    await syncApplicationFromUiStatus(prisma, userId, created.id, "interview", {
      applied: true,
      env: FEATURE_ON,
    });
    expect(await prisma.applicationProcessStep.count()).toBe(0);

    await syncApplicationFromUiStatus(prisma, userId, created.id, "offer", {
      env: FEATURE_ON,
    });
    const attempt = await prisma.applicationAttempt.findFirstOrThrow();
    expect(attempt.currentStageCategory).toBe(ATTEMPT_STAGE.OFFER);
    expect(attempt.outcome).toBe(ATTEMPT_OUTCOME.OFFER);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });
});

describe("Timeline isolation from Attempt summary and legacy Job", () => {
  it("create/update/complete ProcessStep do not write Job or advance stage/outcome", async () => {
    await enableAb();
    const created = await createDraftOpportunity();
    await syncApplicationFromUiStatus(prisma, userId, created.id, "applied", {
      applied: true,
      env: FEATURE_ON,
    });
    const applications = new ApplicationService(prisma, userId, FEATURE_ON);
    const before = await prisma.applicationAttempt.findFirstOrThrow();
    expect(before.currentStageCategory).toBe(ATTEMPT_STAGE.SUBMITTED);
    expect(before.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);

    const step = await applications.createUserProcessStep({
      jobOpportunityId: created.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Hiring manager",
      scheduledAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    expect(step.source).toBe(PROCESS_STEP_SOURCE.USER);

    await applications.updateUserProcessStep({
      stepId: step.id,
      notes: "Bring portfolio",
    });
    await applications.completeProcessStep(step.id);

    const after = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.currentStageCategory).toBe(ATTEMPT_STAGE.SUBMITTED);
    expect(after.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(after.submittedAt?.toISOString()).toBe(before.submittedAt?.toISOString());
    expect(await prisma.job.count()).toBe(0);
  });

  it("delete ProcessStep does not write Job or change stage/outcome", async () => {
    await enableAb();
    const created = await createDraftOpportunity();
    await syncApplicationFromUiStatus(prisma, userId, created.id, "applied", {
      applied: true,
      env: FEATURE_ON,
    });
    const applications = new ApplicationService(prisma, userId, FEATURE_ON);
    const before = await prisma.applicationAttempt.findFirstOrThrow();
    const step = await applications.createUserProcessStep({
      jobOpportunityId: created.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Hiring manager",
    });
    await applications.deleteUserProcessStep(step.id);
    const after = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: before.id },
    });
    expect(after.currentStageCategory).toBe(ATTEMPT_STAGE.SUBMITTED);
    expect(after.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(after.submittedAt?.toISOString()).toBe(before.submittedAt?.toISOString());
    expect(await prisma.applicationProcessStep.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("still returns historical SYSTEM compatibility steps from getTimeline", async () => {
    await enableAb();
    const created = await createDraftOpportunity();
    const applications = new ApplicationService(prisma, userId, FEATURE_ON);
    const attempt = await applications.createAttempt({
      jobOpportunityId: created.id,
      channelLabel: "USER",
    });
    const historical = await prisma.applicationProcessStep.create({
      data: {
        applicationAttemptId: attempt.id,
        category: ATTEMPT_STAGE.INTERVIEW,
        label: "Interview",
        sortOrder: 20,
        status: PROCESS_STEP_STATUS.IN_PROGRESS,
        source: PROCESS_STEP_SOURCE.SYSTEM,
      },
    });

    await syncApplicationFromUiStatus(prisma, userId, created.id, "offer", {
      env: FEATURE_ON,
    });
    expect(await prisma.applicationProcessStep.count()).toBe(1);

    const timeline = await applications.getTimeline(created.id);
    expect(timeline.attempts[0].steps.map((row) => row.id)).toEqual([
      historical.id,
    ]);
    expect(timeline.attempts[0].steps[0].source).toBe(PROCESS_STEP_SOURCE.SYSTEM);
    expect(timeline.attempts[0].steps[0].label).toBe("Interview");
  });
});

describe("runtime gates", () => {
  it("keeps AB_ENABLED Attempt writes available", async () => {
    await enableAb();
    const runtime = await resolveCareerRuntimeMode(prisma, { env: FEATURE_ON });
    expect(runtime.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    const created = await createDraftOpportunity();
    await syncApplicationFromUiStatus(prisma, userId, created.id, "applied", {
      applied: true,
      env: FEATURE_ON,
    });
    expect(await prisma.applicationAttempt.count()).toBe(1);
  });

  it("blocks ProcessStep delete in AB_READY_DISABLED", async () => {
    await enableAb();
    const created = await createDraftOpportunity();
    const enabled = new ApplicationService(prisma, userId, FEATURE_ON);
    await enabled.createAttempt({
      jobOpportunityId: created.id,
      channelLabel: "USER",
    });
    const step = await enabled.createUserProcessStep({
      jobOpportunityId: created.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Round 1",
    });
    const disabled = new ApplicationService(prisma, userId, FEATURE_OFF);
    await expect(disabled.deleteUserProcessStep(step.id)).rejects.toMatchObject({
      code: "AB_WRITES_NOT_ENABLED",
    });
    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).not.toBeNull();
  });

  it("blocks Attempt writes in AB_READY_DISABLED", async () => {
    await enableAb();
    const created = await createDraftOpportunity();
    const runtime = await resolveCareerRuntimeMode(prisma, { env: FEATURE_OFF });
    expect(runtime.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    await expect(
      syncApplicationFromUiStatus(prisma, userId, created.id, "interview", {
        applied: true,
        env: FEATURE_OFF,
      }),
    ).rejects.toMatchObject({ code: "AB_WRITES_NOT_ENABLED" });
    expect(await prisma.applicationAttempt.count()).toBe(0);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
  });

  it("keeps LEGACY_ONLY Job status/applied writes on the Job row", async () => {
    const runtime = await resolveCareerRuntimeMode(prisma, { env: FEATURE_OFF });
    expect(runtime.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    const job = await createJobRecord(
      {
        jobTitleId: titleId,
        companyId,
        statusId: draftStatusId,
        description: "Legacy role",
        jobType: "FT",
        userId,
        applied: false,
      },
      prisma,
    );
    const interviewStatus = await prisma.jobStatus.findFirstOrThrow({
      where: { value: "interview" },
    });
    const updated = await prisma.job.update({
      where: { id: job.id, userId },
      data: {
        statusId: interviewStatus.id,
        applied: true,
      },
    });
    expect(updated.statusId).toBe(interviewStatus.id);
    expect(updated.applied).toBe(true);
    expect(await prisma.jobOpportunity.count()).toBe(0);
    expect(await prisma.applicationAttempt.count()).toBe(0);

    const applied = await prisma.job.update({
      where: { id: job.id, userId },
      data: {
        statusId: appliedStatusId,
        applied: true,
        appliedDate: new Date("2026-02-01T00:00:00.000Z"),
      },
    });
    expect(applied.statusId).toBe(appliedStatusId);
    expect(applied.applied).toBe(true);
    expect(applied.appliedDate?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
    expect(await prisma.applicationAttempt.count()).toBe(0);
  });
});

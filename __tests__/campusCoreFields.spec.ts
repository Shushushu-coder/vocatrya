// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ApplicationService,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  CAREER_RUNTIME_MODE,
  CareerRuntimeError,
  isTerminalAttemptOutcome,
  listUpcomingApplicationEvents,
  OpportunityService,
  PROCESS_STEP_CATEGORY,
  ResumeVariantService,
  activateFreshAbNative,
  deriveUiStatus,
  planUiStatusWrite,
  resolveCareerRuntimeMode,
} from "@/lib/career";
import {
  createOpportunityFromJobForm,
  getOpportunityAsJob,
  listOpportunitiesAsJobs,
} from "@/lib/career/jobOpportunityAdapter";
import { createJobRecord } from "@/lib/jobs/createJobRecord";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };
const FEATURE_OFF = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "false" };
const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;
let companyId: string;
let otherCompanyId: string;
let titleId: string;
let locationId: string;
let sourceId: string;
let draftStatusId: string;

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
  userId = await seedAccount(prisma, `campus-core-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `campus-core-other-${Date.now()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Tencent",
        value: `tencent-campus-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  otherCompanyId = (
    await prisma.company.create({
      data: {
        label: "OtherCo",
        value: `other-campus-${Date.now()}`,
        createdBy: otherUserId,
      },
    })
  ).id;
  titleId = (
    await prisma.jobTitle.create({
      data: {
        label: "软件工程师",
        value: `swe-campus-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  locationId = (
    await prisma.location.create({
      data: {
        label: "深圳",
        value: `sz-campus-${Date.now()}`,
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
});

async function enableAb() {
  await activateFreshAbNative(prisma);
}

function opportunities(ownerId = userId) {
  return new OpportunityService(prisma, ownerId, FEATURE_ON);
}

function applications(ownerId = userId) {
  return new ApplicationService(prisma, ownerId, FEATURE_ON);
}

async function createOwnedOpportunity(
  title: string,
  ownerId = userId,
  company = ownerId === userId ? companyId : otherCompanyId,
) {
  return opportunities(ownerId).create({
    companyId: company,
    title,
  });
}

describe("JobOpportunity recruitment cohort and batch", () => {
  beforeEach(enableAb);

  it("creates with cohort and batch, and without them", async () => {
    const withFields = await opportunities().create({
      companyId,
      title: "软件工程师",
      recruitmentCohort: "2027届",
      recruitmentBatch: "秋招",
    });
    expect(withFields.recruitmentCohort).toBe("2027届");
    expect(withFields.recruitmentBatch).toBe("秋招");

    const withoutFields = await opportunities().create({
      companyId,
      title: "云计算工程师",
    });
    expect(withoutFields.recruitmentCohort).toBeNull();
    expect(withoutFields.recruitmentBatch).toBeNull();
  });

  it("updates, clears to null, and round-trips through the job read adapter", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "FT",
        source: sourceId,
        status: draftStatusId,
        dueDate: new Date("2026-09-20T00:00:00.000Z"),
        jobDescription: "Campus role description",
        applied: false,
        recruitmentCohort: "2027届",
        recruitmentBatch: "秋招",
      },
      FEATURE_ON,
    );
    const read = await getOpportunityAsJob(prisma, userId, created.id);
    expect(read?.recruitmentCohort).toBe("2027届");
    expect(read?.recruitmentBatch).toBe("秋招");

    const updated = await opportunities().updateSafe(created.id, {
      recruitmentCohort: "2026届",
      recruitmentBatch: "春招补录",
    });
    expect(updated.recruitmentCohort).toBe("2026届");
    expect(updated.recruitmentBatch).toBe("春招补录");

    const cleared = await opportunities().updateSafe(created.id, {
      recruitmentCohort: "   ",
      recruitmentBatch: "",
    });
    expect(cleared.recruitmentCohort).toBeNull();
    expect(cleared.recruitmentBatch).toBeNull();
  });

  it("does not infer cohort or batch from title, company, or deadline", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "FT",
        source: sourceId,
        status: draftStatusId,
        dueDate: new Date("2026-09-20T00:00:00.000Z"),
        jobDescription: "2027届秋招 软件工程师 at Tencent",
        applied: false,
      },
      FEATURE_ON,
    );
    expect(created.recruitmentCohort).toBeNull();
    expect(created.recruitmentBatch).toBeNull();
  });

  it("includes cohort and batch in text search without a new filter system", async () => {
    await opportunities().create({
      companyId,
      title: "搜索岗位",
      recruitmentCohort: "UniqueCohortToken2027",
      recruitmentBatch: "UniqueBatchTokenFall",
    });
    await opportunities().create({
      companyId,
      title: "其他岗位",
    });
    const byCohort = await listOpportunitiesAsJobs(prisma, userId, {
      search: "UniqueCohortToken2027",
    });
    expect(byCohort.total).toBe(1);
    expect(byCohort.data[0].JobTitle.label).toBe("搜索岗位");
    const byBatch = await listOpportunitiesAsJobs(prisma, userId, {
      search: "UniqueBatchTokenFall",
    });
    expect(byBatch.total).toBe(1);
  });
});

describe("TRANSFERRED identity", () => {
  beforeEach(enableAb);

  it("exists, is terminal, and is not a legacy JobStatus write", () => {
    expect(ATTEMPT_OUTCOME.TRANSFERRED).toBe("TRANSFERRED");
    expect(isTerminalAttemptOutcome(ATTEMPT_OUTCOME.TRANSFERRED)).toBe(true);
    expect(isTerminalAttemptOutcome(ATTEMPT_OUTCOME.ACTIVE)).toBe(false);
    expect(isTerminalAttemptOutcome(ATTEMPT_OUTCOME.OFFER)).toBe(false);
    expect(isTerminalAttemptOutcome(ATTEMPT_OUTCOME.WITHDRAWN)).toBe(true);
    expect(isTerminalAttemptOutcome(ATTEMPT_OUTCOME.REJECTED)).toBe(true);
    expect(isTerminalAttemptOutcome(ATTEMPT_OUTCOME.HIRED)).toBe(true);
    expect(planUiStatusWrite("transferred")).toEqual({ kind: "noop" });
    expect(
      deriveUiStatus({
        archivedAt: null,
        opportunityStatus: "UNKNOWN",
        attempt: {
          currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
          outcome: ATTEMPT_OUTCOME.TRANSFERRED,
          submittedAt: new Date("2026-01-01T00:00:00.000Z"),
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      }),
    ).toBe("transferred");
  });

  it("excludes TRANSFERRED attempts from Upcoming", async () => {
    const sourceOpp = await createOwnedOpportunity("原岗位");
    const apps = applications();
    const attempt = await apps.createAttempt({
      jobOpportunityId: sourceOpp.id,
      channelLabel: "USER",
    });
    await apps.createUserProcessStep({
      jobOpportunityId: sourceOpp.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Should vanish after transfer",
      scheduledAt: new Date("2026-10-20T00:00:00.000Z"),
    });
    await apps.recordOutcome(attempt.id, ATTEMPT_OUTCOME.TRANSFERRED);
    const events = await listUpcomingApplicationEvents(prisma, userId);
    expect(events.map((row) => row.label)).not.toContain(
      "Should vanish after transfer",
    );
  });
});

describe("createTransferredAttempt", () => {
  beforeEach(enableAb);

  it("marks the source TRANSFERRED and creates a new ACTIVE attempt on the target", async () => {
    const sourceOpp = await createOwnedOpportunity("软件工程师");
    const targetOpp = await createOwnedOpportunity("云计算工程师");
    const apps = applications();
    const source = await apps.createAttempt({
      jobOpportunityId: sourceOpp.id,
      channelLabel: "校园官网",
    });
    const target = await apps.createTransferredAttempt({
      sourceAttemptId: source.id,
      targetJobOpportunityId: targetOpp.id,
    });

    const sourceAfter = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(sourceAfter.outcome).toBe(ATTEMPT_OUTCOME.TRANSFERRED);
    expect(sourceAfter.jobOpportunityId).toBe(sourceOpp.id);
    expect(target.jobOpportunityId).toBe(targetOpp.id);
    expect(target.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(target.currentStageCategory).toBe(ATTEMPT_STAGE.DRAFT);
    expect(target.transferredFromAttemptId).toBe(source.id);
    expect(target.submittedResumeVersionId).toBeNull();

    const timeline = await apps.getTimeline(targetOpp.id);
    expect(timeline.attempts[0].transferredFromAttemptId).toBe(source.id);
    expect(timeline.attempts[0].transferredFrom).toEqual({
      attemptId: source.id,
      opportunityId: sourceOpp.id,
      title: "软件工程师",
      company: "Tencent",
    });
  });

  it("rolls back the source outcome when target create fails", async () => {
    const sourceOpp = await createOwnedOpportunity("原岗位");
    const targetOpp = await createOwnedOpportunity("目标岗位");
    const apps = applications();
    const source = await apps.createAttempt({
      jobOpportunityId: sourceOpp.id,
      channelLabel: "USER",
    });
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER fail_transferred_attempt_create
      BEFORE INSERT ON "ApplicationAttempt"
      WHEN NEW."transferredFromAttemptId" IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'simulated target create failure');
      END;
    `);
    try {
      await expect(
        apps.createTransferredAttempt({
          sourceAttemptId: source.id,
          targetJobOpportunityId: targetOpp.id,
        }),
      ).rejects.toBeTruthy();
    } finally {
      await prisma.$executeRawUnsafe(
        `DROP TRIGGER IF EXISTS fail_transferred_attempt_create`,
      );
    }
    const sourceAfter = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(sourceAfter.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(
      await prisma.applicationAttempt.count({
        where: { jobOpportunityId: targetOpp.id },
      }),
    ).toBe(0);
  });

  it("rejects cross-user source or target and same-opportunity transfers", async () => {
    const sourceOpp = await createOwnedOpportunity("我的岗位");
    const ownTarget = await createOwnedOpportunity("我的另一岗位");
    const foreignOpp = await createOwnedOpportunity(
      "别人的岗位",
      otherUserId,
    );
    const ownApps = applications();
    const foreignApps = applications(otherUserId);
    const ownAttempt = await ownApps.createAttempt({
      jobOpportunityId: sourceOpp.id,
      channelLabel: "USER",
    });
    const foreignAttempt = await foreignApps.createAttempt({
      jobOpportunityId: foreignOpp.id,
      channelLabel: "USER",
    });

    await expect(
      ownApps.createTransferredAttempt({
        sourceAttemptId: ownAttempt.id,
        targetJobOpportunityId: foreignOpp.id,
      }),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
    await expect(
      ownApps.createTransferredAttempt({
        sourceAttemptId: foreignAttempt.id,
        targetJobOpportunityId: ownTarget.id,
      }),
    ).rejects.toMatchObject({ code: "ATTEMPT_NOT_FOUND" });
    await expect(
      ownApps.createTransferredAttempt({
        sourceAttemptId: ownAttempt.id,
        targetJobOpportunityId: sourceOpp.id,
      }),
    ).rejects.toMatchObject({ code: "TRANSFER_SAME_OPPORTUNITY" });

    const sourceAfter = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: ownAttempt.id },
    });
    expect(sourceAfter.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
  });

  it("does not copy timeline steps or submitted resume provenance", async () => {
    const sourceOpp = await createOwnedOpportunity("原岗位");
    const targetOpp = await createOwnedOpportunity("目标岗位");
    const apps = applications();
    const variants = new ResumeVariantService(prisma, userId, FEATURE_ON);
    const variant = await variants.createVariant({ name: "校招简历" });
    const source = await apps.createAttempt({
      jobOpportunityId: sourceOpp.id,
      channelLabel: "USER",
    });
    await apps.markSubmitted({
      attemptId: source.id,
      submittedResumeVersionId: variant.currentVersionId!,
    });
    await apps.createUserProcessStep({
      jobOpportunityId: sourceOpp.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "一面",
      scheduledAt: new Date("2026-10-01T00:00:00.000Z"),
    });

    const target = await apps.createTransferredAttempt({
      sourceAttemptId: source.id,
      targetJobOpportunityId: targetOpp.id,
    });
    expect(target.submittedResumeVersionId).toBeNull();
    const sourceAfter = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: source.id },
    });
    expect(sourceAfter.submittedResumeVersionId).toBe(variant.currentVersionId);
    expect(
      await prisma.applicationProcessStep.count({
        where: { applicationAttemptId: target.id },
      }),
    ).toBe(0);
    expect(
      await prisma.applicationProcessStep.count({
        where: { applicationAttemptId: source.id },
      }),
    ).toBe(1);
  });

  it("nulls the transfer relation when the source attempt is deleted", async () => {
    const sourceOpp = await createOwnedOpportunity("原岗位");
    const targetOpp = await createOwnedOpportunity("目标岗位");
    const apps = applications();
    const source = await apps.createAttempt({
      jobOpportunityId: sourceOpp.id,
      channelLabel: "USER",
    });
    const target = await apps.createTransferredAttempt({
      sourceAttemptId: source.id,
      targetJobOpportunityId: targetOpp.id,
    });
    await prisma.applicationAttempt.delete({ where: { id: source.id } });
    const targetAfter = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(targetAfter.transferredFromAttemptId).toBeNull();
  });
});

describe("LEGACY_ONLY campus fields", () => {
  it("does not change legacy Job create/update, JobStatus, or dueDate", async () => {
    const runtime = await resolveCareerRuntimeMode(prisma, { env: FEATURE_OFF });
    expect(runtime.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
    const dueDate = new Date("2026-09-25T00:00:00.000Z");
    const job = await createJobRecord(
      {
        jobTitleId: titleId,
        companyId,
        statusId: draftStatusId,
        description: "Legacy campus role",
        jobType: "FT",
        userId,
        applied: false,
        dueDate,
      },
      prisma,
    );
    expect(job.dueDate?.toISOString()).toBe(dueDate.toISOString());
    expect(job.statusId).toBe(draftStatusId);
    const rejected = await prisma.jobStatus.findFirstOrThrow({
      where: { value: "rejected" },
    });
    const updated = await prisma.job.update({
      where: { id: job.id, userId },
      data: { statusId: rejected.id, dueDate: new Date("2026-10-01T00:00:00.000Z") },
    });
    expect(updated.statusId).toBe(rejected.id);
    expect(await prisma.jobOpportunity.count()).toBe(0);
    expect(await prisma.applicationAttempt.count()).toBe(0);
    await expect(
      new OpportunityService(prisma, userId, FEATURE_OFF).create({
        companyId,
        title: "Should not write in LEGACY_ONLY",
      }),
    ).rejects.toBeInstanceOf(CareerRuntimeError);
  });
});

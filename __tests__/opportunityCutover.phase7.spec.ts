// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  ATTEMPT_STAGE,
  activateFreshAbNative,
  OpportunityService,
} from "@/lib/career";
import {
  createOpportunityFromJobForm,
  listOpportunitiesAsJobs,
  syncApplicationFromUiStatus,
  updateOpportunityFromJobForm,
} from "@/lib/career/jobOpportunityAdapter";
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
let companyId: string;
let titleId: string;
let locationId: string;
let sourceId: string;
let draftStatusId: string;
let appliedStatusId: string;
let interviewStatusId: string;

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
  userId = await seedAccount(prisma, `phase7-opp-${Date.now()}@example.com`);
  await activateFreshAbNative(prisma);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-opp-${Date.now()}`, createdBy: userId },
    })
  ).id;
  titleId = (
    await prisma.jobTitle.create({
      data: { label: "Engineer", value: `eng-opp-${Date.now()}`, createdBy: userId },
    })
  ).id;
  locationId = (
    await prisma.location.create({
      data: { label: "Remote", value: `remote-${Date.now()}`, createdBy: userId },
    })
  ).id;
  sourceId = (await prisma.jobSource.findFirstOrThrow({ where: { createdBy: userId } }))
    .id;
  draftStatusId = (await prisma.jobStatus.findFirstOrThrow({ where: { value: "draft" } }))
    .id;
  appliedStatusId = (
    await prisma.jobStatus.findFirstOrThrow({ where: { value: "applied" } })
  ).id;
  interviewStatusId = (
    await prisma.jobStatus.findFirstOrThrow({ where: { value: "interview" } })
  ).id;
});

describe("Phase 7 opportunity/application cutover", () => {
  it("creates a JobOpportunity without an ApplicationAttempt", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "full-time",
        source: sourceId,
        status: draftStatusId,
        dueDate: new Date(),
        jobDescription: "Build analytical engines for campus hiring.",
        jobUrl: "https://example.com/jobs/1",
        applied: false,
      },
      FEATURE_ON,
    );

    expect(await prisma.jobOpportunity.count()).toBe(1);
    expect(await prisma.applicationAttempt.count()).toBe(0);
    expect(await prisma.job.count()).toBe(0);
    expect(created.status).toBe("UNKNOWN");
    expect(created.status).not.toBe("INTERVIEW");
    const attempt = await prisma.applicationAttempt.findFirst();
    expect(attempt).toBeNull();
  });

  it("rejects a legacy resume id instead of silently discarding it", async () => {
    await expect(
      createOpportunityFromJobForm(
        prisma,
        userId,
        {
          title: titleId,
          company: companyId,
          location: locationId,
          type: "full-time",
          source: sourceId,
          status: draftStatusId,
          dueDate: new Date(),
          jobDescription: "Legacy resume must be explicit.",
          jobUrl: "https://example.com/jobs/1",
          applied: false,
          resume: "legacy-resume-id",
        },
        FEATURE_ON,
      ),
    ).rejects.toMatchObject({ code: "LEGACY_RESUME_UNSUPPORTED" });
    expect(await prisma.jobOpportunity.count()).toBe(0);
    expect(await prisma.applicationAttempt.count()).toBe(0);
  });

  it("maps applied/dateApplied on create to an ApplicationAttempt without fake provenance", async () => {
    const appliedDate = new Date("2026-09-01T00:00:00.000Z");
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "full-time",
        source: sourceId,
        status: appliedStatusId,
        dueDate: new Date(),
        dateApplied: appliedDate,
        jobDescription: "Applied semantics must be preserved explicitly.",
        jobUrl: "https://example.com/jobs/applied-looking",
        applied: true,
      },
      FEATURE_ON,
    );

    expect(await prisma.jobOpportunity.count()).toBe(1);
    expect(await prisma.job.count()).toBe(0);
    expect(await prisma.applicationAttempt.count()).toBe(1);
    const attempt = await prisma.applicationAttempt.findFirstOrThrow();
    expect(attempt.jobOpportunityId).toBe(created.id);
    expect(attempt.currentStageCategory).toBe(ATTEMPT_STAGE.SUBMITTED);
    expect(attempt.submittedAt?.toISOString()).toBe(appliedDate.toISOString());
    // No reliable Job.resumeId -> submittedResumeVersionId mapping exists.
    expect(attempt.submittedResumeVersionId).toBeNull();

    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(listed.total).toBe(1);
    expect(listed.data[0].applied).toBe(true);
    expect(listed.data[0].resumeId).toBeNull();
    expect(listed.data[0].Resume).toBeNull();
    expect(listed.data[0].abCompat.resumeUnsupported).toBe(true);
  });

  it("marks submitted as an ApplicationAttempt without resume provenance", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "full-time",
        source: sourceId,
        status: draftStatusId,
        dueDate: new Date(),
        jobDescription: "N/A",
        applied: false,
      },
      FEATURE_ON,
    );

    await syncApplicationFromUiStatus(prisma, userId, created.id, "applied", {
      applied: true,
      env: FEATURE_ON,
    });

    expect(await prisma.job.count()).toBe(0);
    expect(await prisma.applicationAttempt.count()).toBe(1);
    const attempt = await prisma.applicationAttempt.findFirstOrThrow();
    expect(attempt.jobOpportunityId).toBe(created.id);
    expect(attempt.currentStageCategory).toBe(ATTEMPT_STAGE.SUBMITTED);
    expect(attempt.submittedResumeVersionId).toBeNull();
    expect(attempt.submittedResumeVersionId).not.toBe("legacy-resume-id");
  });

  it("stores interview as application process data, not opportunity status", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "full-time",
        source: sourceId,
        status: appliedStatusId,
        dueDate: new Date(),
        jobDescription: "N/A",
        applied: true,
      },
      FEATURE_ON,
    );

    await syncApplicationFromUiStatus(prisma, userId, created.id, "interview", {
      env: FEATURE_ON,
    });

    const opportunity = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(opportunity.status).not.toBe("INTERVIEW");
    expect(["UNKNOWN", "ACTIVE", "CLOSED", "EXPIRED"]).toContain(opportunity.status);

    const attempt = await prisma.applicationAttempt.findFirstOrThrow();
    expect(attempt.currentStageCategory).toBe(ATTEMPT_STAGE.INTERVIEW);
    expect(await prisma.applicationProcessStep.count()).toBe(1);
    const step = await prisma.applicationProcessStep.findFirstOrThrow();
    expect(step.category).toBe(ATTEMPT_STAGE.INTERVIEW);
    expect(await prisma.job.count()).toBe(0);
  });

  it("does not dual-write legacy Job from OpportunityService", async () => {
    const opportunities = new OpportunityService(prisma, userId, FEATURE_ON);
    await opportunities.create({ companyId, title: "Staff Engineer" });
    expect(await prisma.jobOpportunity.count()).toBe(1);
    expect(await prisma.job.count()).toBe(0);
    expect(await prisma.applicationAttempt.count()).toBe(0);
  });

  it("creates a new attempt when applying again after a terminal outcome", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "full-time",
        source: sourceId,
        status: draftStatusId,
        jobDescription: "N/A",
      },
      FEATURE_ON,
    );
    await syncApplicationFromUiStatus(prisma, userId, created.id, "applied", {
      applied: true,
      env: FEATURE_ON,
    });
    await syncApplicationFromUiStatus(prisma, userId, created.id, "rejected", {
      env: FEATURE_ON,
    });
    await syncApplicationFromUiStatus(prisma, userId, created.id, "applied", {
      applied: true,
      env: FEATURE_ON,
    });

    const attempts = await prisma.applicationAttempt.findMany({
      where: { jobOpportunityId: created.id },
      orderBy: { createdAt: "asc" },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[0].outcome).toBe("REJECTED");
    expect(attempts[1].currentStageCategory).toBe(ATTEMPT_STAGE.SUBMITTED);
  });

  it("updates company and applies list filters before pagination", async () => {
    const otherCompany = await prisma.company.create({
      data: {
        label: "Beta",
        value: `beta-opp-${Date.now()}`,
        createdBy: userId,
      },
    });
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "full-time",
        source: sourceId,
        status: draftStatusId,
        jobDescription: "First",
      },
      FEATURE_ON,
    );
    await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "part-time",
        source: sourceId,
        status: draftStatusId,
        jobDescription: "Second",
      },
      FEATURE_ON,
    );
    await updateOpportunityFromJobForm(
      prisma,
      userId,
      {
        id: created.id,
        title: titleId,
        company: otherCompany.id,
        location: locationId,
        type: "full-time",
        source: sourceId,
        status: draftStatusId,
        jobDescription: "First updated",
      },
      FEATURE_ON,
    );

    const stored = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.companyId).toBe(otherCompany.id);

    const filtered = await listOpportunitiesAsJobs(prisma, userId, {
      companyValue: otherCompany.value,
      skip: 0,
      take: 1,
    });
    expect(filtered.total).toBe(1);
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0].id).toBe(created.id);

    const paged = await listOpportunitiesAsJobs(prisma, userId, {
      skip: 0,
      take: 1,
    });
    expect(paged.total).toBe(2);
    expect(paged.data).toHaveLength(1);
  });
});

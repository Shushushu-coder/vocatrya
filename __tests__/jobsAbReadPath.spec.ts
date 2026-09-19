// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  activateFreshAbNative,
  deriveUiStatus,
} from "@/lib/career";
import {
  archiveOpportunity,
  createOpportunityFromJobForm,
  getOpportunityAsJob,
  listOpportunitiesAsJobs,
  syncApplicationFromUiStatus,
} from "@/lib/career/jobOpportunityAdapter";
import {
  getJob,
  iterateJobs,
  listJobs,
  loadDashboardJobCounts,
  loadJobsAppliedDateCounts,
  loadRecentJobs,
} from "@/lib/career/jobsReadDispatch";
import { isAbHiddenJobFilter } from "@/lib/career/jobsReadCapabilities";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };
const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;
let companyId: string;
let titleId: string;
let locationId: string;
let sourceId: string;
let draftStatusId: string;
let appliedStatusId: string;
let interviewStatusId: string;
let offerStatusId: string;

beforeAll(() => {
  pushSchema(ctx.url);
  // eslint-disable-next-line no-console
  console.log("DATABASE_URL", ctx.url);
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
  userId = await seedAccount(prisma, `ab-read-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `ab-read-other-${Date.now()}@example.com`,
  );
  await activateFreshAbNative(prisma);
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-read-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  titleId = (
    await prisma.jobTitle.create({
      data: {
        label: "Engineer",
        value: `eng-read-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  locationId = (
    await prisma.location.create({
      data: {
        label: "Remote",
        value: `remote-read-${Date.now()}`,
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
  interviewStatusId = (
    await prisma.jobStatus.findFirstOrThrow({ where: { value: "interview" } })
  ).id;
  offerStatusId = (
    await prisma.jobStatus.findFirstOrThrow({ where: { value: "offer" } })
  ).id;
});

async function createDraftOpportunity(description = "Role description") {
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
      jobDescription: description,
      applied: false,
    },
    FEATURE_ON,
  );
}

describe("PHASE 2 A+B jobs read layer", () => {
  it("Test A: Opportunity + 1 Attempt maps the DTO status from deriveUiStatus", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "FT",
        source: sourceId,
        status: appliedStatusId,
        dueDate: new Date(),
        jobDescription: "Applied role",
        applied: true,
        dateApplied: new Date("2026-09-01T00:00:00.000Z"),
      },
      FEATURE_ON,
    );
    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(listed.total).toBe(1);
    expect(listed.data[0].id).toBe(created.id);
    expect(listed.data[0].abCompat.uiStatus).toBe("applied");
    expect(listed.data[0].Status.value).toBe("applied");
    const attempt = await prisma.applicationAttempt.findFirstOrThrow();
    expect(
      deriveUiStatus({
        archivedAt: null,
        opportunityStatus: created.status,
        attempt,
      }),
    ).toBe("applied");
  });

  it("Test B: Opportunity with no Attempt maps to draft / saved", async () => {
    const created = await createDraftOpportunity();
    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].id).toBe(created.id);
    expect(listed.data[0].abCompat.uiStatus).toBe("draft");
    expect(listed.data[0].abCompat.hasApplicationAttempt).toBe(false);
    expect(listed.data[0].Status.value).toBe("draft");
  });

  it("does not invent a dueDate when JobOpportunity.deadline is null", async () => {
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
        jobDescription: "No deadline role",
        applied: false,
      },
      FEATURE_ON,
    );
    expect(created.deadline).toBeNull();
    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    const detail = await getOpportunityAsJob(prisma, userId, created.id);
    expect(listed.data[0].dueDate).toBeNull();
    expect(detail?.dueDate).toBeNull();
    expect(detail?.dueDate).not.toEqual(created.createdAt);
  });

  it("Test C: multiple Attempts pick max(submittedAt ?? createdAt)", async () => {
    const created = await createDraftOpportunity();
    await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: created.id,
        channelLabel: "older",
        submittedAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
        outcome: ATTEMPT_OUTCOME.ACTIVE,
      },
    });
    await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: created.id,
        channelLabel: "newer",
        submittedAt: new Date("2026-06-01T00:00:00.000Z"),
        createdAt: new Date("2026-02-01T00:00:00.000Z"),
        currentStageCategory: ATTEMPT_STAGE.INTERVIEW,
        outcome: ATTEMPT_OUTCOME.ACTIVE,
      },
    });
    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(listed.data).toHaveLength(1);
    expect(listed.data[0].abCompat.uiStatus).toBe("interview");
    expect(listed.data[0].appliedDate?.toISOString()).toBe(
      "2026-06-01T00:00:00.000Z",
    );
  });

  it("Test D: archived Opportunity is excluded from the default list", async () => {
    const created = await createDraftOpportunity();
    await archiveOpportunity(prisma, userId, created.id, FEATURE_ON);
    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(listed.total).toBe(0);
    expect(listed.data).toHaveLength(0);
    const stored = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.archivedAt).not.toBeNull();
  });

  it("Test E: users cannot read each other's opportunities", async () => {
    const created = await createDraftOpportunity();
    const listed = await listOpportunitiesAsJobs(prisma, otherUserId, {});
    expect(listed.total).toBe(0);
    const detail = await getOpportunityAsJob(prisma, otherUserId, created.id);
    expect(detail).toBeNull();
  });

  it("Test F: pagination is by Opportunity and does not duplicate on Attempt join", async () => {
    const first = await createDraftOpportunity("First");
    const second = await createDraftOpportunity("Second");
    await prisma.applicationAttempt.createMany({
      data: [
        {
          userId,
          jobOpportunityId: first.id,
          channelLabel: "a",
          currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
        },
        {
          userId,
          jobOpportunityId: first.id,
          channelLabel: "b",
          currentStageCategory: ATTEMPT_STAGE.INTERVIEW,
        },
      ],
    });
    const page1 = await listOpportunitiesAsJobs(prisma, userId, {
      skip: 0,
      take: 1,
    });
    const page2 = await listOpportunitiesAsJobs(prisma, userId, {
      skip: 1,
      take: 1,
    });
    expect(page1.total).toBe(2);
    expect(page1.data).toHaveLength(1);
    expect(page2.data).toHaveLength(1);
    expect(page1.data[0].id).not.toBe(page2.data[0].id);
    expect([first.id, second.id]).toContain(page1.data[0].id);
    expect([first.id, second.id]).toContain(page2.data[0].id);
  });
});

describe("PHASE 3 list + detail wiring", () => {
  it("create is immediately visible and detail uses Opportunity id", async () => {
    const created = await createDraftOpportunity("Visible immediately");
    const listed = await listJobs(prisma, userId, {}, FEATURE_ON);
    expect(listed.blocked).toBe(false);
    if (listed.blocked) return;
    expect(listed.data.some((row: { id: string }) => row.id === created.id)).toBe(
      true,
    );
    const detail = await getJob(prisma, userId, created.id, FEATURE_ON);
    expect(detail.blocked).toBe(false);
    expect(detail.job?.id).toBe(created.id);
  });

  it("search, supported filters, and hidden filters work", async () => {
    await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "FT",
        source: sourceId,
        status: interviewStatusId,
        dueDate: new Date(),
        jobDescription: "SearchableUniqueToken",
        applied: true,
      },
      FEATURE_ON,
    );
    await createDraftOpportunity("Other role");
    const searched = await listOpportunitiesAsJobs(prisma, userId, {
      search: "SearchableUniqueToken",
    });
    expect(searched.total).toBe(1);
    const interviews = await listOpportunitiesAsJobs(prisma, userId, {
      filter: "interview",
    });
    expect(interviews.total).toBe(1);
    expect(interviews.data[0].abCompat.uiStatus).toBe("interview");
    const drafts = await listOpportunitiesAsJobs(prisma, userId, {
      filter: "draft",
    });
    expect(drafts.total).toBe(1);
    expect(isAbHiddenJobFilter("accepted")).toBe(true);
    expect(isAbHiddenJobFilter("dismissed")).toBe(true);
    const hidden = await listOpportunitiesAsJobs(prisma, userId, {
      filter: "dismissed",
    });
    expect(hidden.total).toBe(0);
    expect(hidden.data).toHaveLength(0);
  });

  it("status filter uses latest Attempt, not an older one", async () => {
    const created = await createDraftOpportunity();
    await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: created.id,
        channelLabel: "old-applied",
        submittedAt: new Date("2026-01-01T00:00:00.000Z"),
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
        outcome: ATTEMPT_OUTCOME.ACTIVE,
      },
    });
    await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: created.id,
        channelLabel: "new-interview",
        submittedAt: new Date("2026-06-01T00:00:00.000Z"),
        createdAt: new Date("2026-06-01T00:00:00.000Z"),
        currentStageCategory: ATTEMPT_STAGE.INTERVIEW,
        outcome: ATTEMPT_OUTCOME.ACTIVE,
      },
    });
    const applied = await listOpportunitiesAsJobs(prisma, userId, {
      filter: "applied",
    });
    const interview = await listOpportunitiesAsJobs(prisma, userId, {
      filter: "interview",
    });
    expect(applied.total).toBe(0);
    expect(interview.total).toBe(1);
    expect(interview.data[0].id).toBe(created.id);
  });
});

describe("PHASE 4 archive", () => {
  it("A+B delete archives the Opportunity and keeps Attempt/Step rows", async () => {
    const created = await createOpportunityFromJobForm(
      prisma,
      userId,
      {
        title: titleId,
        company: companyId,
        location: locationId,
        type: "FT",
        source: sourceId,
        status: interviewStatusId,
        dueDate: new Date(),
        jobDescription: "To archive",
        applied: true,
      },
      FEATURE_ON,
    );
    const attemptCount = await prisma.applicationAttempt.count();
    const stepCount = await prisma.applicationProcessStep.count();
    expect(attemptCount).toBeGreaterThan(0);
    await archiveOpportunity(prisma, userId, created.id, FEATURE_ON);
    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(listed.total).toBe(0);
    const stored = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.archivedAt).not.toBeNull();
    expect(await prisma.applicationAttempt.count()).toBe(attemptCount);
    expect(await prisma.applicationProcessStep.count()).toBe(stepCount);
  });
});

describe("PHASE 5 dashboard + CSV", () => {
  const now = new Date();
  const range = {
    start: new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000),
    end: new Date(now.getTime() + 24 * 60 * 60 * 1000),
    priorStart: new Date(now.getTime() - 13 * 24 * 60 * 60 * 1000),
  };

  async function seedStatus(uiStatus: string) {
    const created = await createDraftOpportunity(`status-${uiStatus}`);
    await syncApplicationFromUiStatus(prisma, userId, created.id, uiStatus, {
      applied: uiStatus !== "draft",
      appliedDate: now,
      env: FEATURE_ON,
    });
    return created;
  }

  it("classifies dashboard counts with the same deriveUiStatus mapping", async () => {
    await seedStatus("applied");
    const interviewing = await seedStatus("interview");
    await seedStatus("offer");
    const archived = await seedStatus("applied");
    await archiveOpportunity(prisma, userId, archived.id, FEATURE_ON);

    const counts = await loadDashboardJobCounts(
      prisma,
      userId,
      range,
      FEATURE_ON,
    );
    expect(counts.jobsApplied).toBe(3);
    expect(counts.jobsInterview).toBe(1);
    expect(counts.jobsOffer).toBe(1);

    const interviewAttempt = await prisma.applicationAttempt.findFirstOrThrow({
      where: { jobOpportunityId: interviewing.id },
    });
    expect(
      deriveUiStatus({
        archivedAt: null,
        opportunityStatus: interviewing.status,
        attempt: interviewAttempt,
      }),
    ).toBe("interview");
  });

  it("weekly chart and recent jobs exclude archived opportunities", async () => {
    const visible = await seedStatus("applied");
    const archived = await seedStatus("applied");
    await archiveOpportunity(prisma, userId, archived.id, FEATURE_ON);
    const daily = await loadJobsAppliedDateCounts(
      prisma,
      userId,
      { start: range.start, end: range.end },
      FEATURE_ON,
    );
    const total = daily.reduce((sum, row) => sum + row.count, 0);
    expect(total).toBe(1);
    const recent = await loadRecentJobs(prisma, userId, 10, FEATURE_ON);
    expect(recent.map((row: { id: string }) => row.id)).toEqual([visible.id]);
  });

  it("CSV iterates one row per unarchived Opportunity", async () => {
    await createDraftOpportunity("csv-1");
    await createDraftOpportunity("csv-2");
    const archived = await createDraftOpportunity("csv-archived");
    await archiveOpportunity(prisma, userId, archived.id, FEATURE_ON);
    const rows: unknown[] = [];
    for await (const chunk of iterateJobs(
      prisma,
      userId,
      undefined,
      200,
      FEATURE_ON,
    )) {
      rows.push(...chunk);
    }
    expect(rows).toHaveLength(2);
  });
});

describe("PHASE 7 action-integration smoke", () => {
  it("create → list → detail → interview → dashboard → archive", async () => {
    // eslint-disable-next-line no-console
    console.log("SMOKE DATABASE_URL", ctx.url);
    expect(ctx.url.startsWith("file:")).toBe(true);
    expect(ctx.dir.includes("jobsync-backup-") || ctx.dir.length > 0).toBe(
      true,
    );

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
        dueDate: new Date(),
        jobDescription: "Smoke role",
        applied: false,
      },
      FEATURE_ON,
    );
    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(listed.data.map((row) => row.id)).toContain(created.id);

    const detail = await getOpportunityAsJob(prisma, userId, created.id);
    expect(detail?.id).toBe(created.id);

    await syncApplicationFromUiStatus(prisma, userId, created.id, "interview", {
      applied: true,
      env: FEATURE_ON,
    });
    const interviewAttempt = await prisma.applicationAttempt.findFirstOrThrow({
      where: { jobOpportunityId: created.id },
    });
    expect(interviewAttempt.currentStageCategory).toBe(ATTEMPT_STAGE.INTERVIEW);
    expect(await prisma.applicationProcessStep.count()).toBe(0);

    const now = new Date();
    const counts = await loadDashboardJobCounts(
      prisma,
      userId,
      {
        start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        end: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        priorStart: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      },
      FEATURE_ON,
    );
    expect(counts.jobsInterview).toBe(1);

    await archiveOpportunity(prisma, userId, created.id, FEATURE_ON);
    const after = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(after.total).toBe(0);
    const afterCounts = await loadDashboardJobCounts(
      prisma,
      userId,
      {
        start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        end: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        priorStart: new Date(now.getTime() - 48 * 60 * 60 * 1000),
      },
      FEATURE_ON,
    );
    expect(afterCounts.jobsInterview).toBe(0);
    const stored = await prisma.jobOpportunity.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.archivedAt).not.toBeNull();
    expect(await prisma.applicationAttempt.count()).toBeGreaterThan(0);
    expect(await prisma.applicationProcessStep.count()).toBe(0);
  });
});

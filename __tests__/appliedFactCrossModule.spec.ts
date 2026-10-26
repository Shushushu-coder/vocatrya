// @vitest-environment node
//
// Cross-module integration spec for the converged ever-applied fact. Every
// assertion below runs against ONE disposable database inside THIS merged
// worktree: the dictionary statistics (jobtitle/jobLocation/jobSource
// actions), the company rollup, the My Jobs read path, Upcoming, and the
// Dashboard aggregates must all agree on the same APPLIED_ATTEMPT_WHERE
// contract — no per-branch result stitching.
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  AB_INSTANCE_SCOPE_KEY,
  AB_MIGRATION_KEY,
  AB_MIGRATION_STATUS,
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  OPPORTUNITY_STATUS,
  UPCOMING_EVENT_KIND,
  activateFreshAbNative,
} from "@/lib/career";
import {
  LEGACY,
  PHASE3_MIGRATION_VERSION,
  TARGET,
} from "@/lib/legacy-migration/identities";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

// The server actions resolve the prisma singleton at import time; bind the
// disposable database explicitly so the worktree needs no production .env.
const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const ctx = helpers.makeTestDbUrl();
  helpers.pushSchema(ctx.url);
  return ctx;
});
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { getCurrentUser } from "@/utils/user.utils";
import { getCompanyDetails, getCompanyList } from "@/actions/company.actions";
import { getJobTitleList } from "@/actions/jobtitle.actions";
import { getJobLocationsList } from "@/actions/jobLocation.actions";
import { getJobSourceList } from "@/actions/jobSource.actions";
import { getJobsList } from "@/actions/job/queries";
import { DEFAULT_LOCALE } from "@/i18n/config";
import { translate } from "@/i18n/translate";
import { listOpportunitiesAsJobs } from "@/lib/career/jobOpportunityAdapter";
import {
  listJobs,
  loadDashboardJobCounts,
  loadJobsAppliedDateCounts,
} from "@/lib/career/jobsReadDispatch";
import { listUpcomingApplicationEvents } from "@/lib/career/upcomingReadModel";

let prisma: PrismaClient;
let userId: string;
let otherUserId: string;
let companyAId: string;
let companyBId: string;

beforeAll(async () => {
  const dbMod = await import("@/lib/db");
  prisma = dbMod.default;
}, 120_000);

afterAll(async () => {
  await prisma?.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `xmod-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `xmod-other-${Date.now()}@example.com`,
  );
  (getCurrentUser as any).mockResolvedValue({ id: userId });
  companyAId = (await createCompany({ label: "Acme" })).id;
  companyBId = (await createCompany({ label: "Beta" })).id;
});

function enableFull() {
  vi.stubEnv(AB_RUNTIME_FEATURE_ENV, "true");
  vi.stubEnv(AB_ROLLOUT_SCOPE_ENV, "full");
}

async function freshAb() {
  enableFull();
  await activateFreshAbNative(prisma);
}

async function migratedAb() {
  enableFull();
  await prisma.abMigrationState.create({
    data: {
      scopeKey: AB_INSTANCE_SCOPE_KEY,
      migrationKey: AB_MIGRATION_KEY,
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    },
  });
}

async function blockedMigration() {
  await prisma.abMigrationState.create({
    data: {
      scopeKey: AB_INSTANCE_SCOPE_KEY,
      migrationKey: AB_MIGRATION_KEY,
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
    },
  });
}

async function createCompany(o: { label?: string; createdBy?: string } = {}) {
  return prisma.company.create({
    data: {
      label: o.label ?? "Acme",
      value: `co-${randomUUID()}`,
      createdBy: o.createdBy ?? userId,
    },
  });
}

async function createTitle(label: string, createdBy = userId) {
  return prisma.jobTitle.create({
    data: { label, value: `t-${randomUUID()}`, createdBy },
  });
}

async function createLocation(label: string, createdBy = userId) {
  return prisma.location.create({
    data: { label, value: `l-${randomUUID()}`, createdBy },
  });
}

async function createOpportunity(
  o: {
    userId?: string;
    companyId?: string;
    title?: string;
    locationText?: string | null;
    sourceLabel?: string | null;
    deadline?: Date | null;
    status?: string;
    archived?: boolean;
    createdAt?: Date;
  } = {},
) {
  return prisma.jobOpportunity.create({
    data: {
      userId: o.userId ?? userId,
      companyId: o.companyId ?? companyAId,
      title: o.title ?? "Engineer",
      locationText: o.locationText ?? null,
      sourceLabel: o.sourceLabel ?? null,
      status: o.status ?? OPPORTUNITY_STATUS.ACTIVE,
      deadline: o.deadline ?? null,
      archivedAt: o.archived ? new Date() : null,
      createdAt: o.createdAt ?? new Date(),
    },
  });
}

async function createAttempt(
  jobOpportunityId: string,
  o: {
    userId?: string;
    submittedAt?: Date | null;
    createdAt?: Date;
    stage?: string;
    outcome?: string;
    archived?: boolean;
  } = {},
) {
  return prisma.applicationAttempt.create({
    data: {
      userId: o.userId ?? userId,
      jobOpportunityId,
      channelLabel: "TEST",
      submittedAt: o.submittedAt ?? null,
      createdAt: o.createdAt ?? new Date(),
      currentStageCategory: o.stage ?? ATTEMPT_STAGE.DRAFT,
      outcome: o.outcome ?? ATTEMPT_OUTCOME.ACTIVE,
      archivedAt: o.archived ? new Date() : null,
    },
  });
}

async function createLegacyJob(
  o: {
    companyId: string;
    jobTitleId: string;
    applied?: boolean;
    appliedDate?: Date | null;
  },
) {
  const status = await prisma.jobStatus.findFirstOrThrow({
    where: { value: "new" },
  });
  return prisma.job.create({
    data: {
      userId,
      companyId: o.companyId,
      jobTitleId: o.jobTitleId,
      statusId: status.id,
      jobType: "FT",
      description: "keep",
      applied: o.applied ?? false,
      appliedDate: o.applied ? (o.appliedDate ?? new Date()) : null,
      createdAt: new Date(),
    },
  });
}

async function mapJobToOpportunity(jobId: string, opportunityId: string) {
  return prisma.legacyMigrationMap.create({
    data: {
      userId,
      legacyEntityType: LEGACY.JOB,
      legacyEntityId: jobId,
      targetEntityType: TARGET.JOB_OPPORTUNITY,
      targetEntityId: opportunityId,
      migrationVersion: PHASE3_MIGRATION_VERSION,
    },
  });
}

const rowByLabel = (list: any, label: string) =>
  list.data.find((row: any) => row.label === label);

// My Jobs applied reads, both spellings of the same fact filter.
async function myJobsAppliedTotal(options: {
  titleValue?: string;
  locationValue?: string;
  sourceValue?: string;
  companyValue?: string;
}) {
  const byChip = await getJobsList(
    1,
    100,
    undefined,
    undefined,
    options.companyValue,
    true,
    options.titleValue,
    options.locationValue,
    options.sourceValue,
  );
  const byFilter = await getJobsList(
    1,
    100,
    "applied",
    undefined,
    options.companyValue,
    undefined,
    options.titleValue,
    options.locationValue,
    options.sourceValue,
  );
  expect(byChip?.success).toBe(true);
  expect(byFilter?.success).toBe(true);
  return { byChip, byFilter };
}

describe("A. applied matrix — one contract for every consumer", () => {
  it.each([
    // [label, stage, submittedAt, archived, expectedApplied, expectedDate]
    ["DRAFT + null submittedAt", ATTEMPT_STAGE.DRAFT, null, false, false, null],
    ["SUBMITTED + null submittedAt", ATTEMPT_STAGE.SUBMITTED, null, false, true, null],
    ["INTERVIEW + null submittedAt", ATTEMPT_STAGE.INTERVIEW, null, false, true, null],
    ["OFFER + null submittedAt", ATTEMPT_STAGE.OFFER, null, false, true, null],
  ] as const)(
    "%s → applied=%s, appliedDate=%s, identical across list/stats/upcoming",
    async (_label, stage, submittedAt, archived, expectedApplied, _expectedDate) => {
      await freshAb();
      await createTitle("Engineer");
      const opp = await createOpportunity({ title: "Engineer" });
      await createAttempt(opp.id, {
        stage,
        submittedAt,
        archived,
      });

      const listed = await listOpportunitiesAsJobs(prisma, userId, {});
      const row = listed.data.find((r) => r.id === opp.id)!;
      expect(row.applied).toBe(expectedApplied);
      expect(row.appliedDate).toBeNull();

      const appliedList = await listOpportunitiesAsJobs(prisma, userId, {
        appliedOnly: true,
      });
      expect(appliedList.total).toBe(expectedApplied ? 1 : 0);

      // Same fact through the My Jobs action and the title dictionary stat.
      const myJobs = await myJobsAppliedTotal({
        titleValue: (await prisma.jobTitle.findFirstOrThrow({
          where: { label: "Engineer", createdBy: userId },
        })).value,
      });
      expect(myJobs.byChip.total).toBe(expectedApplied ? 1 : 0);
      expect(myJobs.byFilter.total).toBe(expectedApplied ? 1 : 0);

      const titles = await getJobTitleList(1, 10, "applied");
      expect(rowByLabel(titles, "Engineer")._count.jobs).toBe(
        expectedApplied ? 1 : 0,
      );
      const companies = await getCompanyList(1, 10, "applied");
      expect(rowByLabel(companies, "Acme")._count.jobsApplied).toBe(
        expectedApplied ? 1 : 0,
      );
    },
  );

  it("real submittedAt → applied with the first real date; later draft keeps it", async () => {
    await freshAb();
    const first = new Date("2026-03-01T00:00:00.000Z");
    const second = new Date("2026-06-01T00:00:00.000Z");
    const opp = await createOpportunity({ title: "Engineer" });
    await createAttempt(opp.id, {
      submittedAt: first,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    await createAttempt(opp.id, {
      submittedAt: second,
      createdAt: new Date("2026-06-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    // Re-application draft after two formal submissions: applied fact
    // survives and the FIRST real submission stays the appliedDate.
    await createAttempt(opp.id, {
      submittedAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.DRAFT,
    });

    const listed = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    // Position-level dedup: three attempts, one position.
    expect(listed.total).toBe(1);
    expect(listed.data[0].appliedDate?.toISOString()).toBe(
      first.toISOString(),
    );

    await createTitle("Engineer");
    const titles = await getJobTitleList(1, 10, "applied");
    expect(rowByLabel(titles, "Engineer")._count.jobs).toBe(1);
    const companies = await getCompanyList(1, 10, "applied");
    expect(rowByLabel(companies, "Acme")._count.jobsApplied).toBe(1);
  });

  it("archived-only attempts → not applied anywhere", async () => {
    await freshAb();
    await createTitle("Engineer");
    const opp = await createOpportunity({ title: "Engineer" });
    await createAttempt(opp.id, {
      submittedAt: new Date("2026-04-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      archived: true,
    });

    const row = (
      await listOpportunitiesAsJobs(prisma, userId, {})
    ).data.find((r) => r.id === opp.id)!;
    expect(row.applied).toBe(false);
    expect(row.appliedDate).toBeNull();

    const titles = await getJobTitleList(1, 10, "applied");
    expect(rowByLabel(titles, "Engineer")._count.jobs).toBe(0);
    const companies = await getCompanyList(1, 10, "applied");
    expect(rowByLabel(companies, "Acme")._count.jobsApplied).toBe(0);
  });
});

describe("B. shared fixture — every module reads the same fact", () => {
  // Company A:
  //   dated      Engineer/Remote/Indeed   submitted 2026-09-02        applied
  //   stageOnly  Engineer/Remote/Indeed   INTERVIEW, no submittedAt   applied
  //   draft      Designer/Onsite/Linkedin DRAFT null                  not applied
  //   archived   Engineer                 archived submitted attempt  not applied
  //   resubmit   Engineer/Remote/Indeed   submitted 2026-03-01 +
  //                                       later draft                 applied
  //   twice      Designer                 submitted 2026-09-03 +
  //                                       submitted 2026-09-05        applied×1
  // Company B:  foreign-scope Engineer    submitted 2026-09-04        applied
  // Other user: Engineer                  submitted                   never seen
  async function seedSharedFixture() {
    await createTitle("Engineer");
    await createTitle("Designer");
    await createLocation("Remote");
    await createLocation("Onsite");
    const indeed = await prisma.jobSource.findFirstOrThrow({
      where: { label: "Indeed", createdBy: userId },
    });
    const linkedin = await prisma.jobSource.findFirstOrThrow({
      where: { label: "Linkedin", createdBy: userId },
    });

    const dated = await createOpportunity({
      title: "Engineer",
      locationText: "Remote",
      sourceLabel: "Indeed",
    });
    await createAttempt(dated.id, {
      submittedAt: new Date("2026-09-02T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    const stageOnly = await createOpportunity({
      title: "Engineer",
      locationText: "Remote",
      sourceLabel: "Indeed",
    });
    await createAttempt(stageOnly.id, {
      submittedAt: null,
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    const draft = await createOpportunity({
      title: "Designer",
      locationText: "Onsite",
      sourceLabel: "Linkedin",
    });
    await createAttempt(draft.id, { submittedAt: null });
    const archivedAttempt = await createOpportunity({ title: "Engineer" });
    await createAttempt(archivedAttempt.id, {
      submittedAt: new Date("2026-09-06T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      archived: true,
    });
    const resubmit = await createOpportunity({
      title: "Engineer",
      locationText: "Remote",
      sourceLabel: "Indeed",
    });
    await createAttempt(resubmit.id, {
      submittedAt: new Date("2026-03-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      outcome: ATTEMPT_OUTCOME.REJECTED,
    });
    await createAttempt(resubmit.id, {
      submittedAt: null,
      createdAt: new Date("2026-09-07T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.DRAFT,
    });
    const twice = await createOpportunity({ title: "Designer" });
    await createAttempt(twice.id, {
      submittedAt: new Date("2026-09-03T00:00:00.000Z"),
      createdAt: new Date("2026-09-03T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    await createAttempt(twice.id, {
      submittedAt: new Date("2026-09-05T00:00:00.000Z"),
      createdAt: new Date("2026-09-04T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    const beta = await createOpportunity({
      companyId: companyBId,
      title: "Engineer",
    });
    await createAttempt(beta.id, {
      submittedAt: new Date("2026-09-04T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    const foreignCo = await createCompany({ createdBy: otherUserId });
    const foreign = await createOpportunity({
      userId: otherUserId,
      companyId: foreignCo.id,
      title: "Engineer",
    });
    await createAttempt(foreign.id, {
      userId: otherUserId,
      submittedAt: new Date("2026-09-04T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });

    return {
      dated,
      stageOnly,
      draft,
      archivedAttempt,
      resubmit,
      twice,
      beta,
      indeed,
      linkedin,
    };
  }

  it("company jobsApplied equals the companyId+appliedOnly My Jobs count", async () => {
    await freshAb();
    const f = await seedSharedFixture();

    const companies = await getCompanyList(1, 10, "applied");
    const acme = rowByLabel(companies, "Acme");
    const beta = rowByLabel(companies, "Beta");
    // Acme applied set: dated, stageOnly, resubmit, twice → 4.
    expect(acme._count.jobsApplied).toBe(4);
    expect(beta._count.jobsApplied).toBe(1);

    const acmeAdapter = await listOpportunitiesAsJobs(prisma, userId, {
      companyId: companyAId,
      appliedOnly: true,
    });
    expect(acmeAdapter.total).toBe(4);
    expect(acmeAdapter.data.map((r) => r.id).sort()).toEqual(
      [f.dated.id, f.stageOnly.id, f.resubmit.id, f.twice.id].sort(),
    );
    const companyA = await prisma.company.findUniqueOrThrow({
      where: { id: companyAId },
    });
    const acmeJobs = await myJobsAppliedTotal({
      companyValue: companyA.value,
    });
    expect(acmeJobs.byChip.total).toBe(4);
    expect(acmeJobs.byFilter.total).toBe(4);

    // Company details rollup agrees with the same applied basis.
    const details = await getCompanyDetails(companyAId);
    expect(details.appliedCount).toBe(4);
  });

  it("dictionary jobsApplied equals the value-filtered My Jobs count", async () => {
    await freshAb();
    const f = await seedSharedFixture();

    const titles = await getJobTitleList(1, 10, "applied");
    // Engineer applied: dated, stageOnly, resubmit (A) + beta (B) → 4.
    // Designer applied: twice → 1.
    expect(rowByLabel(titles, "Engineer")._count.jobs).toBe(4);
    expect(rowByLabel(titles, "Designer")._count.jobs).toBe(1);
    const engineer = await prisma.jobTitle.findFirstOrThrow({
      where: { label: "Engineer", createdBy: userId },
    });
    const designer = await prisma.jobTitle.findFirstOrThrow({
      where: { label: "Designer", createdBy: userId },
    });
    for (const [titleValue, expected] of [
      [engineer.value, 4],
      [designer.value, 1],
    ] as const) {
      const r = await myJobsAppliedTotal({ titleValue });
      expect(r.byChip.total).toBe(expected);
      expect(r.byFilter.total).toBe(expected);
    }

    const locations = await getJobLocationsList(1, 10, "applied");
    // Remote applied: dated, stageOnly, resubmit → 3. Onsite: draft only → 0.
    expect(rowByLabel(locations, "Remote")._count.jobsApplied).toBe(3);
    expect(rowByLabel(locations, "Onsite")._count.jobsApplied).toBe(0);
    const remote = await prisma.location.findFirstOrThrow({
      where: { label: "Remote", createdBy: userId },
    });
    const remoteJobs = await myJobsAppliedTotal({
      locationValue: remote.value,
    });
    expect(remoteJobs.byChip.total).toBe(3);
    expect(remoteJobs.byFilter.total).toBe(3);

    const sources = await getJobSourceList(1, 20, "applied");
    // Indeed applied: dated, stageOnly, resubmit → 3. Linkedin: 0.
    expect(rowByLabel(sources, "Indeed")._count.jobsApplied).toBe(3);
    expect(rowByLabel(sources, "Linkedin")._count.jobsApplied).toBe(0);
    const indeedJobs = await myJobsAppliedTotal({
      sourceValue: f.indeed.value,
    });
    expect(indeedJobs.byChip.total).toBe(3);
    expect(indeedJobs.byFilter.total).toBe(3);

    // The stage-only INTERVIEW position (no submittedAt) is inside every
    // applied read, and the post-submit draft never splits it out.
    const remoteList = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    const ids = remoteList.data.map((r) => r.id);
    expect(remoteList.total).toBe(5);
    expect(ids).toContain(f.stageOnly.id);
    expect(ids).toContain(f.resubmit.id);
    expect(ids).not.toContain(f.draft.id);
    expect(ids).not.toContain(f.archivedAttempt.id);
    const resubmitRow = remoteList.data.find((r) => r.id === f.resubmit.id)!;
    expect(resubmitRow.appliedDate?.toISOString()).toBe(
      "2026-03-01T00:00:00.000Z",
    );
  });

  it("legacy and AB rows coexist after migration without double counting", async () => {
    const engineer = await createTitle("Engineer");
    const jobA = await createLegacyJob({
      companyId: companyAId,
      jobTitleId: engineer.id,
      applied: true,
    });
    const jobB = await createLegacyJob({
      companyId: companyAId,
      jobTitleId: engineer.id,
      applied: true,
    });
    const oppA = await createOpportunity({ title: "Engineer" });
    await createAttempt(oppA.id, {
      submittedAt: new Date("2026-08-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    const oppB = await createOpportunity({ title: "Engineer" });
    await mapJobToOpportunity(jobA.id, oppA.id);
    await mapJobToOpportunity(jobB.id, oppB.id);
    await migratedAb();

    const titles = await getJobTitleList(1, 10, "applied");
    const eng = rowByLabel(titles, "Engineer");
    expect(eng._count.jobsTotal).toBe(2);
    expect(eng._count.jobs).toBe(1);
    const companies = await getCompanyList(1, 10, "applied");
    expect(rowByLabel(companies, "Acme")._count.jobsApplied).toBe(1);
    const myJobs = await listJobs(prisma, userId, { appliedOnly: true }, {
      ...process.env,
      [AB_RUNTIME_FEATURE_ENV]: "true",
      [AB_ROLLOUT_SCOPE_ENV]: "full",
    });
    expect(myJobs.blocked).toBe(false);
    if (myJobs.blocked) return;
    expect(myJobs.total).toBe(1);
  });

  it("upcoming deadline prompts share the stage-aware suppression", async () => {
    await freshAb();
    const deadline = new Date("2026-11-01T00:00:00.000Z");
    await createOpportunity({ title: "Pending", deadline });
    const stageOnly = await createOpportunity({
      title: "Stage applied",
      deadline,
    });
    await createAttempt(stageOnly.id, {
      submittedAt: null,
      stage: ATTEMPT_STAGE.OFFER,
    });
    const submitted = await createOpportunity({
      title: "Submitted",
      deadline,
    });
    await createAttempt(submitted.id, {
      submittedAt: new Date("2026-09-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      outcome: ATTEMPT_OUTCOME.REJECTED,
    });
    // A draft re-application must not resurrect the deadline prompt.
    await createAttempt(submitted.id, {
      submittedAt: null,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    const draft = await createOpportunity({ title: "Draft", deadline });
    await createAttempt(draft.id, { submittedAt: null });

    const titles = (
      await listUpcomingApplicationEvents(prisma, userId)
    )
      .filter((e) => e.kind === UPCOMING_EVENT_KIND.APPLICATION_DEADLINE)
      .map((e) => e.roleTitle);
    expect(titles).toContain("Pending");
    expect(titles).toContain("Draft");
    expect(titles).not.toContain("Stage applied");
    expect(titles).not.toContain("Submitted");
  });

  it("dashboard windows and buckets attribute the FIRST real submission only", async () => {
    await freshAb();
    const f = await seedSharedFixture();
    const range = {
      start: new Date("2026-09-01T00:00:00.000Z"),
      end: new Date("2026-09-30T23:59:59.000Z"),
      priorStart: new Date("2026-08-01T00:00:00.000Z"),
    };
    const counts = await loadDashboardJobCounts(prisma, userId, range, {
      ...process.env,
      [AB_RUNTIME_FEATURE_ENV]: "true",
      [AB_ROLLOUT_SCOPE_ENV]: "full",
    });
    // In-window first submissions: dated (09-02), twice (09-03), beta (09-04)
    // → 3. resubmit's first is 03-01 → not even prior (before priorStart).
    // stageOnly/archivedAttempt carry no real submittedAt → never counted.
    expect(counts.jobsApplied).toBe(3);
    expect(counts.priorJobs).toBe(0);

    const daily = await loadJobsAppliedDateCounts(
      prisma,
      userId,
      { start: range.start, end: range.end },
      {
        ...process.env,
        [AB_RUNTIME_FEATURE_ENV]: "true",
        [AB_ROLLOUT_SCOPE_ENV]: "full",
      },
    );
    expect(
      daily
        .map((row) => [row.appliedDate.toISOString(), row.count])
        .sort(),
    ).toEqual([
      ["2026-09-02T00:00:00.000Z", 1],
      ["2026-09-03T00:00:00.000Z", 1],
      ["2026-09-04T00:00:00.000Z", 1],
    ]);
    // The stage-only row still belongs to the applied set — fact and date
    // stay independent dimensions.
    expect(f.stageOnly.id).toBeTruthy();
    const applied = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    expect(applied.data.find((r) => r.id === f.stageOnly.id)?.appliedDate).toBeNull();
  });

  it("blocked read family fails closed on every surface — never an empty list", async () => {
    const engineer = await createTitle("Engineer");
    await createLegacyJob({
      companyId: companyAId,
      jobTitleId: engineer.id,
      applied: true,
    });
    await blockedMigration();

    for (const res of [
      await getCompanyList(1, 10, "applied"),
      await getJobTitleList(1, 10, "applied"),
      await getJobLocationsList(1, 10, "applied"),
      await getJobSourceList(1, 20, "applied"),
    ]) {
      expect(res?.success).toBe(false);
      expect(res?.message).toMatch(/cannot be read/i);
      expect(res?.data).toBeUndefined();
    }
    const jobsRes = await getJobsList(1, 100);
    expect(jobsRes?.success).toBe(false);
    expect(jobsRes?.message).toBe(
      translate(DEFAULT_LOCALE, "errors.careerJobsUnavailable"),
    );
    expect(jobsRes?.data).toBeUndefined();
  });
});

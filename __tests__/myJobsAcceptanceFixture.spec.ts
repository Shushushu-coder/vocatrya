// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
} from "@/lib/career";
import { OPPORTUNITY_STATUS } from "@/lib/career/identities";
import { listJobs } from "@/lib/career/jobsReadDispatch";
import {
  ACCEPTANCE_APPLIED_DATE,
  ACCEPTANCE_DESCRIPTION,
  ACCEPTANCE_JOB_COUNT,
  ACCEPTANCE_JOB_TYPE,
  ACCEPTANCE_LOCATION_LABEL,
  ACCEPTANCE_SALARY,
  ACCEPTANCE_WORKPLACE,
  cleanupMyJobsAcceptanceFixture,
  seedMyJobsAcceptanceFixture,
} from "../e2e/support/myJobsAcceptanceFixture";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

function envWithoutAbFlags(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env[AB_RUNTIME_FEATURE_ENV];
  delete env[AB_ROLLOUT_SCOPE_ENV];
  return env;
}

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
});

async function ownedCounts(userId: string, companyId: string) {
  const opportunities = await prisma.jobOpportunity.findMany({
    where: { userId, companyId },
    select: { id: true },
  });
  const opportunityIds = opportunities.map((row) => row.id);
  const [jobs, attempts] = await Promise.all([
    prisma.job.count({ where: { userId, companyId } }),
    opportunityIds.length === 0
      ? Promise.resolve(0)
      : prisma.applicationAttempt.count({
          where: { jobOpportunityId: { in: opportunityIds } },
        }),
  ]);
  return { jobs, opportunities: opportunityIds.length, attempts };
}

describe("My Jobs acceptance fixture read family", () => {
  it("seeds legacy Job rows and cleans only that company", async () => {
    const userId = await seedAccount(prisma, "fixture-legacy@example.com");
    const otherCompany = await prisma.company.create({
      data: { label: "Other", value: "other-legacy", createdBy: userId },
    });
    const title = await prisma.jobTitle.create({
      data: { label: "Other title", value: "other-title", createdBy: userId },
    });
    const status = await prisma.jobStatus.findUniqueOrThrow({ where: { value: "new" } });
    const kept = await prisma.job.create({
      data: {
        userId,
        companyId: otherCompany.id,
        jobTitleId: title.id,
        statusId: status.id,
        jobType: "FT",
        description: "keep",
        createdAt: new Date(),
      },
    });
    const seeded = await seedMyJobsAcceptanceFixture(prisma, {
      userId,
      marker: "legacy-marker",
      env: envWithoutAbFlags(),
    });

    expect(seeded.family).toBe("legacy");
    expect(seeded.singletonFilterLabel).toBe("新建");
    expect(seeded.resetFilterLabel).toBe("全部（不含已忽略）");
    expect(await ownedCounts(userId, seeded.catalog.company.id)).toEqual({
      jobs: ACCEPTANCE_JOB_COUNT,
      opportunities: 0,
      attempts: 0,
    });
    const listed = await listJobs(
      prisma,
      userId,
      { filter: "new", search: "legacy-marker" },
      envWithoutAbFlags(),
    );
    expect(listed.blocked).toBe(false);
    if (!listed.blocked) expect(listed.total).toBe(1);

    await cleanupMyJobsAcceptanceFixture(prisma, seeded);
    expect(await prisma.job.findUnique({ where: { id: kept.id } })).not.toBeNull();
    expect(await prisma.company.findUnique({ where: { id: seeded.catalog.company.id } })).toBeNull();
    expect(await prisma.jobSource.findUnique({ where: { id: seeded.catalog.source.id } })).toBeNull();
  });

  it("seeds JobOpportunity plus the latest attempt and projects visible status", async () => {
    const userId = await seedAccount(prisma, "fixture-ab@example.com");
    await activateFreshAbNative(prisma);
    const env = envWithoutAbFlags();
    const otherCompany = await prisma.company.create({
      data: { label: "Kept Co", value: "kept-co", createdBy: userId },
    });
    const kept = await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: otherCompany.id,
        title: "Kept role",
        status: OPPORTUNITY_STATUS.UNKNOWN,
      },
    });
    const seeded = await seedMyJobsAcceptanceFixture(prisma, {
      userId,
      marker: "ab-marker",
      env,
    });

    expect(seeded.family).toBe("ab");
    expect(seeded.singletonFilterLabel).toBe("草稿");
    expect(seeded.resetFilterLabel).toBe("全部职位");
    expect(await ownedCounts(userId, seeded.catalog.company.id)).toEqual({
      jobs: 0,
      opportunities: ACCEPTANCE_JOB_COUNT,
      attempts: ACCEPTANCE_JOB_COUNT - 1,
    });

    const listed = await listJobs(prisma, userId, { search: "ab-marker" }, env);
    expect(listed.blocked).toBe(false);
    if (listed.blocked) return;
    expect(listed.total).toBe(ACCEPTANCE_JOB_COUNT);
    const views = listed.data.flatMap((row) => ("abCompat" in row ? [row] : []));
    expect(views).toHaveLength(ACCEPTANCE_JOB_COUNT);
    const drafts = views.filter((row) => row.Status?.value === "draft");
    const interviews = views.filter((row) => row.Status?.value === "interview");
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.applied).toBe(false);
    expect(drafts[0]?.appliedDate).toBeNull();
    expect(interviews).toHaveLength(ACCEPTANCE_JOB_COUNT - 1);
    for (const row of interviews) {
      expect(row.applied).toBe(true);
      expect(row.appliedDate).toEqual(ACCEPTANCE_APPLIED_DATE);
      expect(row.Company?.label).toBe(seeded.catalog.company.label);
      expect(row.JobTitle?.label).toBe(seeded.catalog.title.label);
      expect(row.Location?.label).toBe(ACCEPTANCE_LOCATION_LABEL);
      expect(row.JobSource?.label).toBe(seeded.catalog.source.label);
      expect(row.jobType).toBe(ACCEPTANCE_JOB_TYPE);
      expect(row.workplaceType).toBe(ACCEPTANCE_WORKPLACE);
      expect(row.description).toBe(ACCEPTANCE_DESCRIPTION);
      expect(row.salaryRange).toBe(ACCEPTANCE_SALARY);
    }
    const draftFilter = await listJobs(prisma, userId, { filter: "draft", search: "ab-marker" }, env);
    const newFilter = await listJobs(prisma, userId, { filter: "new", search: "ab-marker" }, env);
    expect(draftFilter.blocked).toBe(false);
    expect(newFilter.blocked).toBe(false);
    if (!draftFilter.blocked) expect(draftFilter.total).toBe(1);
    if (!newFilter.blocked) expect(newFilter.total).toBe(0);

    await cleanupMyJobsAcceptanceFixture(prisma, seeded);
    expect(await prisma.jobOpportunity.findUnique({ where: { id: kept.id } })).not.toBeNull();
    expect(await prisma.company.findUnique({ where: { id: otherCompany.id } })).not.toBeNull();
    expect(await prisma.company.findUnique({ where: { id: seeded.catalog.company.id } })).toBeNull();
    expect(await prisma.jobTitle.findUnique({ where: { id: seeded.catalog.title.id } })).toBeNull();
    expect(await prisma.location.findUnique({ where: { id: seeded.catalog.location.id } })).toBeNull();
    expect(await ownedCounts(userId, seeded.catalog.company.id)).toEqual({
      jobs: 0,
      opportunities: 0,
      attempts: 0,
    });
  });

  it("follows a non-full AB_ENABLED runtime back to legacy Job rows", async () => {
    const userId = await seedAccount(prisma, "fixture-scope@example.com");
    await activateFreshAbNative(prisma);
    const env = envWithoutAbFlags();
    env[AB_RUNTIME_FEATURE_ENV] = "true";
    env[AB_ROLLOUT_SCOPE_ENV] = "none";
    const seeded = await seedMyJobsAcceptanceFixture(prisma, {
      userId,
      marker: "scope-marker",
      env,
    });

    expect(seeded.family).toBe("legacy");
    expect(await ownedCounts(userId, seeded.catalog.company.id)).toEqual({
      jobs: ACCEPTANCE_JOB_COUNT,
      opportunities: 0,
      attempts: 0,
    });
    await cleanupMyJobsAcceptanceFixture(prisma, seeded);
  });
});

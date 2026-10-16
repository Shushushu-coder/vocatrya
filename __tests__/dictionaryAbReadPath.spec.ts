// @vitest-environment node
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
  activateFreshAbNative,
} from "@/lib/career";
import {
  LEGACY,
  PHASE3_MIGRATION_VERSION,
  TARGET,
} from "@/lib/legacy-migration/identities";
import { JOB_SOURCES } from "@/lib/constants";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

// The dictionary actions import the prisma singleton before module body env
// assignment. Bind the disposable database explicitly so a worktree needs no
// production .env.
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
import { getJobTitleList } from "@/actions/jobtitle.actions";
import { getJobLocationsList } from "@/actions/jobLocation.actions";
import { getJobSourceList } from "@/actions/jobSource.actions";
import { listJobs } from "@/lib/career/jobsReadDispatch";

let prisma: PrismaClient;
let userId: string;
let otherUserId: string;

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
  userId = await seedAccount(prisma, `dict-ab-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `dict-ab-other-${Date.now()}@example.com`,
  );
  (getCurrentUser as any).mockResolvedValue({ id: userId });
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

async function sourceByLabel(label: string, createdBy = userId) {
  // seedAccount already seeds the JOB_SOURCES catalog for every account.
  return prisma.jobSource.findFirstOrThrow({ where: { label, createdBy } });
}

async function createOpportunity(
  companyId: string,
  o: {
    userId?: string;
    title?: string;
    locationText?: string | null;
    sourceLabel?: string | null;
    archived?: boolean;
  } = {},
) {
  return prisma.jobOpportunity.create({
    data: {
      userId: o.userId ?? userId,
      companyId,
      title: o.title ?? "Engineer",
      locationText: o.locationText ?? null,
      sourceLabel: o.sourceLabel ?? null,
      status: "ACTIVE",
      archivedAt: o.archived ? new Date() : null,
    },
  });
}

async function createAttempt(
  jobOpportunityId: string,
  o: {
    userId?: string;
    channelLabel?: string;
    submittedAt?: Date | null;
    // Stage is set independently of submittedAt: migrated attempts can carry
    // a post-DRAFT stage with no recorded submission timestamp, and a null
    // timestamp must not force the row back to DRAFT.
    stage?: string;
    createdAt?: Date;
    archived?: boolean;
  } = {},
) {
  return prisma.applicationAttempt.create({
    data: {
      userId: o.userId ?? userId,
      jobOpportunityId,
      // channelLabel is the delivery channel; it must never feed back into a
      // JobSource (discovery-provenance) statistic.
      channelLabel: o.channelLabel ?? "TEST",
      submittedAt: o.submittedAt ?? null,
      createdAt: o.createdAt ?? new Date(),
      currentStageCategory:
        o.stage ??
        (o.submittedAt ? ATTEMPT_STAGE.SUBMITTED : ATTEMPT_STAGE.DRAFT),
      outcome: ATTEMPT_OUTCOME.ACTIVE,
      archivedAt: o.archived ? new Date() : null,
    },
  });
}

async function createLegacyJob(
  o: {
    companyId: string;
    jobTitleId: string;
    locationId?: string | null;
    jobSourceId?: string | null;
    applied?: boolean;
    // Explicit override for migrated rows recorded as applied without a
    // submission date (applied=true, appliedDate=null).
    appliedDate?: Date | null;
    userId?: string;
  },
) {
  const status = await prisma.jobStatus.findFirstOrThrow({
    where: { value: "new" },
  });
  return prisma.job.create({
    data: {
      userId: o.userId ?? userId,
      companyId: o.companyId,
      jobTitleId: o.jobTitleId,
      statusId: status.id,
      locationId: o.locationId ?? null,
      jobSourceId: o.jobSourceId ?? null,
      jobType: "FT",
      description: "keep",
      applied: o.applied ?? false,
      appliedDate:
        o.appliedDate !== undefined
          ? o.appliedDate
          : o.applied
            ? new Date()
            : null,
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

describe("dictionary stats — legacy read family stays untouched", () => {
  it("job titles keep legacy Job counts", async () => {
    const company = await createCompany();
    const engineer = await createTitle("Engineer");
    const designer = await createTitle("Designer");
    await createLegacyJob({ companyId: company.id, jobTitleId: engineer.id, applied: true });
    await createLegacyJob({ companyId: company.id, jobTitleId: engineer.id, applied: true });
    await createLegacyJob({ companyId: company.id, jobTitleId: engineer.id });
    await createLegacyJob({ companyId: company.id, jobTitleId: designer.id });

    const result = await getJobTitleList(1, 10, "applied");

    expect(result.success).not.toBe(false);
    const eng = rowByLabel(result, "Engineer");
    const des = rowByLabel(result, "Designer");
    expect(eng._count.jobsTotal).toBe(3);
    expect(eng._count.jobs).toBe(2);
    expect(des._count.jobsTotal).toBe(1);
    expect(des._count.jobs).toBe(0);
  });

  it("locations keep legacy Job counts", async () => {
    const company = await createCompany();
    const title = await createTitle("Engineer");
    const remote = await createLocation("Remote");
    await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      locationId: remote.id,
      applied: true,
    });
    await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      locationId: remote.id,
    });
    // Jobs with no location must not leak into any dictionary row.
    await createLegacyJob({ companyId: company.id, jobTitleId: title.id });

    const result = await getJobLocationsList(1, 10, "applied");

    const row = rowByLabel(result, "Remote");
    expect(row._count.jobsTotal).toBe(2);
    expect(row._count.jobsApplied).toBe(1);
  });

  it("job sources keep legacy Job counts", async () => {
    const company = await createCompany();
    const title = await createTitle("Engineer");
    const indeed = await sourceByLabel("Indeed");
    await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      jobSourceId: indeed.id,
      applied: true,
    });
    await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      jobSourceId: indeed.id,
    });
    await createLegacyJob({ companyId: company.id, jobTitleId: title.id });

    const result = await getJobSourceList(1, 20, "applied");

    const row = rowByLabel(result, "Indeed");
    expect(row._count.jobsTotal).toBe(2);
    expect(row._count.jobsApplied).toBe(1);
  });
});

describe("job titles — A+B read family", () => {
  it("counts non-archived opportunities by exact title label", async () => {
    await freshAb();
    const company = await createCompany();
    await createTitle("Engineer");
    await createTitle("Designer");
    const applied = await createOpportunity(company.id, { title: "Engineer" });
    await createAttempt(applied.id, { submittedAt: new Date() });
    await createOpportunity(company.id, { title: "Engineer" });
    await createOpportunity(company.id, { title: "Designer" });
    // No dictionary row with this label — contributes to no row.
    await createOpportunity(company.id, { title: "Unlisted" });

    const result = await getJobTitleList(1, 10, "applied");

    const eng = rowByLabel(result, "Engineer");
    const des = rowByLabel(result, "Designer");
    expect(eng._count.jobsTotal).toBe(2);
    expect(eng._count.jobs).toBe(1);
    expect(des._count.jobsTotal).toBe(1);
    expect(des._count.jobs).toBe(0);
  });

  it("counts one opportunity once even with several submitted attempts", async () => {
    await freshAb();
    const company = await createCompany();
    await createTitle("Engineer");
    const opp = await createOpportunity(company.id);
    await createAttempt(opp.id, {
      submittedAt: new Date("2026-01-01"),
      createdAt: new Date("2026-01-01"),
    });
    await createAttempt(opp.id, {
      submittedAt: new Date("2026-03-01"),
      createdAt: new Date("2026-03-01"),
    });

    const result = await getJobTitleList(1, 10, "applied");

    const eng = rowByLabel(result, "Engineer");
    expect(eng._count.jobsTotal).toBe(1);
    expect(eng._count.jobs).toBe(1);
  });

  it("a draft after a submitted attempt still counts as applied", async () => {
    await freshAb();
    const company = await createCompany();
    await createTitle("Engineer");
    const opp = await createOpportunity(company.id);
    await createAttempt(opp.id, {
      submittedAt: new Date("2026-01-01"),
      createdAt: new Date("2026-01-01"),
    });
    await createAttempt(opp.id, {
      submittedAt: null,
      createdAt: new Date("2026-06-01"),
    });
    // A draft-only attempt alone never marks the position applied.
    const draftOnly = await createOpportunity(company.id, { title: "Designer" });
    await createTitle("Designer");
    await createAttempt(draftOnly.id, { submittedAt: null });

    const result = await getJobTitleList(1, 10, "applied");

    expect(rowByLabel(result, "Engineer")._count.jobs).toBe(1);
    expect(rowByLabel(result, "Designer")._count.jobs).toBe(0);
    expect(rowByLabel(result, "Designer")._count.jobsTotal).toBe(1);
  });

  it("excludes archived opportunities (and their attempts) from stats", async () => {
    await freshAb();
    const company = await createCompany();
    await createTitle("Engineer");
    await createOpportunity(company.id);
    const archived = await createOpportunity(company.id, { archived: true });
    await createAttempt(archived.id, { submittedAt: new Date() });

    const result = await getJobTitleList(1, 10, "applied");

    const eng = rowByLabel(result, "Engineer");
    expect(eng._count.jobsTotal).toBe(1);
    expect(eng._count.jobs).toBe(0);
  });

  it("matches by exact label — no canonicalized value or case folding", async () => {
    await freshAb();
    const company = await createCompany();
    // Dictionary value is the canonical key; A+B stores the label text.
    // A differently-cased title matches neither this row nor My Jobs' filter.
    await createTitle("Engineer");
    await createOpportunity(company.id, { title: "engineer" });

    const result = await getJobTitleList(1, 10, "applied");

    const eng = rowByLabel(result, "Engineer");
    expect(eng._count.jobsTotal).toBe(0);
    expect(eng._count.jobs).toBe(0);
  });

  it("aggregates the same title across different companies", async () => {
    await freshAb();
    const acme = await createCompany({ label: "Acme" });
    const globex = await createCompany({ label: "Globex" });
    await createTitle("Engineer");
    await createOpportunity(acme.id);
    const applied = await createOpportunity(globex.id);
    await createAttempt(applied.id, { submittedAt: new Date() });

    const result = await getJobTitleList(1, 10, "applied");

    const eng = rowByLabel(result, "Engineer");
    expect(eng._count.jobsTotal).toBe(2);
    expect(eng._count.jobs).toBe(1);
  });

  it("never aggregates another user's titles or opportunities", async () => {
    await freshAb();
    const mine = await createTitle("Mine");
    await createTitle("Theirs", otherUserId);
    const foreignCo = await createCompany({ createdBy: otherUserId });
    const foreign = await createOpportunity(foreignCo.id, {
      userId: otherUserId,
      title: "Mine",
    });
    await createAttempt(foreign.id, {
      userId: otherUserId,
      submittedAt: new Date(),
    });

    const result = await getJobTitleList(1, 10, "applied");

    expect(result.data.map((r: any) => r.label)).toEqual(["Mine"]);
    const row = rowByLabel(result, "Mine");
    expect(row._count.jobsTotal).toBe(0);
    expect(row._count.jobs).toBe(0);
  });

  it("migrated databases never double-count legacy Job plus Opportunity", async () => {
    const company = await createCompany();
    const engineer = await createTitle("Engineer");
    // jobA migrated to an applied position; jobB migrated to a saved one.
    const jobA = await createLegacyJob({
      companyId: company.id,
      jobTitleId: engineer.id,
      applied: true,
    });
    const jobB = await createLegacyJob({
      companyId: company.id,
      jobTitleId: engineer.id,
      applied: true,
    });
    const oppA = await createOpportunity(company.id);
    await createAttempt(oppA.id, { submittedAt: new Date() });
    const oppB = await createOpportunity(company.id);
    await mapJobToOpportunity(jobA.id, oppA.id);
    await mapJobToOpportunity(jobB.id, oppB.id);
    await migratedAb();

    const result = await getJobTitleList(1, 10, "applied");

    const eng = rowByLabel(result, "Engineer");
    // Two positions, one applied — the frozen legacy rows never add on.
    expect(eng._count.jobsTotal).toBe(2);
    expect(eng._count.jobs).toBe(1);
  });

  it("fails closed instead of reading frozen legacy stats when blocked", async () => {
    const company = await createCompany();
    const engineer = await createTitle("Engineer");
    await createLegacyJob({
      companyId: company.id,
      jobTitleId: engineer.id,
      applied: true,
    });
    await blockedMigration();

    const result = await getJobTitleList(1, 10, "applied");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/unavailable/i);
    expect(result.data).toBeUndefined();
  });
});

describe("job locations — A+B read family", () => {
  it("counts non-archived opportunities by exact locationText", async () => {
    await freshAb();
    const company = await createCompany();
    await createLocation("Remote");
    await createLocation("New York");
    const applied = await createOpportunity(company.id, {
      locationText: "Remote",
    });
    await createAttempt(applied.id, { submittedAt: new Date() });
    await createOpportunity(company.id, { locationText: "Remote" });
    // Opportunities without a location belong to no dictionary row.
    await createOpportunity(company.id, { locationText: null });

    const result = await getJobLocationsList(1, 10, "applied");

    const remote = rowByLabel(result, "Remote");
    const nyc = rowByLabel(result, "New York");
    expect(remote._count.jobsTotal).toBe(2);
    expect(remote._count.jobsApplied).toBe(1);
    expect(nyc._count.jobsTotal).toBe(0);
    expect(nyc._count.jobsApplied).toBe(0);
  });

  it("matches by exact label — no canonicalized value or case folding", async () => {
    await freshAb();
    const company = await createCompany();
    await createLocation("Remote");
    await createOpportunity(company.id, { locationText: "remote" });

    const result = await getJobLocationsList(1, 10, "applied");

    expect(rowByLabel(result, "Remote")._count.jobsTotal).toBe(0);
  });

  it("never aggregates another user's locations or opportunities", async () => {
    await freshAb();
    await createLocation("Remote");
    await createLocation("Foreign", otherUserId);
    const foreignCo = await createCompany({ createdBy: otherUserId });
    const foreign = await createOpportunity(foreignCo.id, {
      userId: otherUserId,
      locationText: "Remote",
    });
    await createAttempt(foreign.id, {
      userId: otherUserId,
      submittedAt: new Date(),
    });

    const result = await getJobLocationsList(1, 10, "applied");

    expect(result.data.map((r: any) => r.label)).toEqual(["Remote"]);
    const remote = rowByLabel(result, "Remote");
    expect(remote._count.jobsTotal).toBe(0);
    expect(remote._count.jobsApplied).toBe(0);
  });

  it("excludes archived opportunities from stats", async () => {
    await freshAb();
    const company = await createCompany();
    await createLocation("Remote");
    await createOpportunity(company.id, { locationText: "Remote" });
    const archived = await createOpportunity(company.id, {
      locationText: "Remote",
      archived: true,
    });
    await createAttempt(archived.id, { submittedAt: new Date() });

    const result = await getJobLocationsList(1, 10, "applied");

    const remote = rowByLabel(result, "Remote");
    expect(remote._count.jobsTotal).toBe(1);
    expect(remote._count.jobsApplied).toBe(0);
  });

  it("migrated databases never double-count legacy Job plus Opportunity", async () => {
    const company = await createCompany();
    const title = await createTitle("Engineer");
    const remote = await createLocation("Remote");
    const jobA = await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      locationId: remote.id,
      applied: true,
    });
    const jobB = await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      locationId: remote.id,
      applied: true,
    });
    const oppA = await createOpportunity(company.id, { locationText: "Remote" });
    await createAttempt(oppA.id, { submittedAt: new Date() });
    const oppB = await createOpportunity(company.id, { locationText: "Remote" });
    await mapJobToOpportunity(jobA.id, oppA.id);
    await mapJobToOpportunity(jobB.id, oppB.id);
    await migratedAb();

    const result = await getJobLocationsList(1, 10, "applied");

    const remoteRow = rowByLabel(result, "Remote");
    expect(remoteRow._count.jobsTotal).toBe(2);
    expect(remoteRow._count.jobsApplied).toBe(1);
  });

  it("fails closed instead of reading frozen legacy stats when blocked", async () => {
    const company = await createCompany();
    const title = await createTitle("Engineer");
    const remote = await createLocation("Remote");
    await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      locationId: remote.id,
      applied: true,
    });
    await blockedMigration();

    const result = await getJobLocationsList(1, 10, "applied");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/unavailable/i);
    expect(result.data).toBeUndefined();
  });
});

describe("job sources — A+B read family", () => {
  it("counts non-archived opportunities by exact sourceLabel", async () => {
    await freshAb();
    const company = await createCompany();
    const applied = await createOpportunity(company.id, {
      sourceLabel: "Indeed",
    });
    await createAttempt(applied.id, { submittedAt: new Date() });
    await createOpportunity(company.id, { sourceLabel: "Indeed" });
    await createOpportunity(company.id, { sourceLabel: null });
    // Unknown labels aggregate nowhere — they match no dictionary row.
    await createOpportunity(company.id, { sourceLabel: "Unlisted Board" });

    const result = await getJobSourceList(1, 20, "applied");

    const indeed = rowByLabel(result, "Indeed");
    const linkedin = rowByLabel(result, "Linkedin");
    expect(indeed._count.jobsTotal).toBe(2);
    expect(indeed._count.jobsApplied).toBe(1);
    expect(linkedin._count.jobsTotal).toBe(0);
    expect(linkedin._count.jobsApplied).toBe(0);
  });

  it("never maps discovery provenance onto an attempt's delivery channel", async () => {
    await freshAb();
    const company = await createCompany();
    const opp = await createOpportunity(company.id, { sourceLabel: "Indeed" });
    // The attempt went out through a referral — JobSource stats still read
    // the opportunity's own sourceLabel, not the channel.
    await createAttempt(opp.id, {
      channelLabel: "REFERRAL",
      submittedAt: new Date(),
    });

    const result = await getJobSourceList(1, 20, "applied");

    const indeed = rowByLabel(result, "Indeed");
    expect(indeed._count.jobsTotal).toBe(1);
    expect(indeed._count.jobsApplied).toBe(1);
    expect(rowByLabel(result, "Referral Group")._count.jobsTotal).toBe(0);
  });

  it("matches by exact label — no canonicalized value or case folding", async () => {
    await freshAb();
    const company = await createCompany();
    await createOpportunity(company.id, { sourceLabel: "indeed" });

    const result = await getJobSourceList(1, 20, "applied");

    expect(rowByLabel(result, "Indeed")._count.jobsTotal).toBe(0);
  });

  it("never aggregates another user's sources or opportunities", async () => {
    await freshAb();
    const foreignCo = await createCompany({ createdBy: otherUserId });
    const foreign = await createOpportunity(foreignCo.id, {
      userId: otherUserId,
      sourceLabel: "Indeed",
    });
    await createAttempt(foreign.id, {
      userId: otherUserId,
      submittedAt: new Date(),
    });

    const result = await getJobSourceList(1, 20, "applied");

    // Both accounts seed the same JOB_SOURCES catalog — a createdBy leak
    // would double the row count and duplicate every label.
    expect(result.total).toBe(JOB_SOURCES.length);
    expect(
      new Set(result.data.map((r: any) => r.label)).size,
    ).toBe(result.data.length);
    const indeed = rowByLabel(result, "Indeed");
    expect(indeed._count.jobsTotal).toBe(0);
    expect(indeed._count.jobsApplied).toBe(0);
  });

  it("migrated databases never double-count legacy Job plus Opportunity", async () => {
    const company = await createCompany();
    const title = await createTitle("Engineer");
    const indeed = await sourceByLabel("Indeed");
    const jobA = await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      jobSourceId: indeed.id,
      applied: true,
    });
    const jobB = await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      jobSourceId: indeed.id,
      applied: true,
    });
    const oppA = await createOpportunity(company.id, { sourceLabel: "Indeed" });
    await createAttempt(oppA.id, { submittedAt: new Date() });
    const oppB = await createOpportunity(company.id, { sourceLabel: "Indeed" });
    await mapJobToOpportunity(jobA.id, oppA.id);
    await mapJobToOpportunity(jobB.id, oppB.id);
    await migratedAb();

    const result = await getJobSourceList(1, 20, "applied");

    const row = rowByLabel(result, "Indeed");
    expect(row._count.jobsTotal).toBe(2);
    expect(row._count.jobsApplied).toBe(1);
  });

  it("fails closed instead of reading frozen legacy stats when blocked", async () => {
    const company = await createCompany();
    const title = await createTitle("Engineer");
    const indeed = await sourceByLabel("Indeed");
    await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      jobSourceId: indeed.id,
      applied: true,
    });
    await blockedMigration();

    const result = await getJobSourceList(1, 20, "applied");

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/unavailable/i);
    expect(result.data).toBeUndefined();
  });
});

// Stage-aware applied fact: a position counts once when ANY live attempt
// carries a real submittedAt OR already sits at a post-DRAFT stage —
// covering migrated history that never recorded a submission timestamp.
// Every case asserts the identical count through all three dictionary
// actions, not just the mocked groupBy shape.
describe("stage-aware applied predicate — A+B read family", () => {
  // Seeds one opportunity carrying a label in all three dictionaries, then
  // attaches each attempt spec in order.
  async function seedLabeledOpportunity(
    attempts: Array<Parameters<typeof createAttempt>[1]>,
  ) {
    const company = await createCompany();
    await createTitle("Engineer");
    await createLocation("Remote");
    const opp = await createOpportunity(company.id, {
      title: "Engineer",
      locationText: "Remote",
      sourceLabel: "Indeed",
    });
    for (const attempt of attempts) {
      await createAttempt(opp.id, attempt);
    }
    return opp;
  }

  async function appliedCounts() {
    const [titles, locations, sources] = await Promise.all([
      getJobTitleList(1, 50, "applied"),
      getJobLocationsList(1, 50, "applied"),
      getJobSourceList(1, 50, "applied"),
    ]);
    return {
      titles: rowByLabel(titles, "Engineer")._count.jobs as number,
      locations: rowByLabel(locations, "Remote")._count.jobsApplied as number,
      sources: rowByLabel(sources, "Indeed")._count.jobsApplied as number,
    };
  }

  it("does not count a live draft with no submission history", async () => {
    await freshAb();
    await seedLabeledOpportunity([
      { stage: ATTEMPT_STAGE.DRAFT, submittedAt: null },
    ]);

    expect(await appliedCounts()).toEqual({
      titles: 0,
      locations: 0,
      sources: 0,
    });
    // The opportunity itself is still live — only the applied count is zero.
    const titles = await getJobTitleList(1, 50, "applied");
    expect(rowByLabel(titles, "Engineer")._count.jobsTotal).toBe(1);
  });

  it("counts a SUBMITTED-stage attempt with no recorded timestamp", async () => {
    await freshAb();
    const opp = await seedLabeledOpportunity([
      { stage: ATTEMPT_STAGE.SUBMITTED, submittedAt: null },
    ]);

    expect(await appliedCounts()).toEqual({
      titles: 1,
      locations: 1,
      sources: 1,
    });
    // The stage-aware predicate reads the stage; it must never fabricate a
    // submission date on the attempt or on the projected job view.
    const attempt = await prisma.applicationAttempt.findFirstOrThrow({
      where: { jobOpportunityId: opp.id },
    });
    expect(attempt.submittedAt).toBeNull();
    const list = await listJobs(prisma, userId);
    if (list.blocked) throw new Error("jobs read unexpectedly blocked");
    expect(
      list.data.find((job: any) => job.id === opp.id)?.appliedDate,
    ).toBeNull();
  });

  it("counts an INTERVIEW-stage attempt with no recorded timestamp", async () => {
    await freshAb();
    await seedLabeledOpportunity([
      { stage: ATTEMPT_STAGE.INTERVIEW, submittedAt: null },
    ]);

    expect(await appliedCounts()).toEqual({
      titles: 1,
      locations: 1,
      sources: 1,
    });
  });

  it("counts an OFFER-stage attempt with no recorded timestamp", async () => {
    await freshAb();
    await seedLabeledOpportunity([
      { stage: ATTEMPT_STAGE.OFFER, submittedAt: null },
    ]);

    expect(await appliedCounts()).toEqual({
      titles: 1,
      locations: 1,
      sources: 1,
    });
  });

  it("counts the position once across submitted and stage-only attempts", async () => {
    await freshAb();
    await seedLabeledOpportunity([
      { submittedAt: new Date("2026-01-01"), createdAt: new Date("2026-01-01") },
      {
        stage: ATTEMPT_STAGE.INTERVIEW,
        submittedAt: null,
        createdAt: new Date("2026-03-01"),
      },
    ]);

    expect(await appliedCounts()).toEqual({
      titles: 1,
      locations: 1,
      sources: 1,
    });
  });

  it("ignores attempts that are themselves archived", async () => {
    await freshAb();
    // Both OR branches satisfied — archivedAt still wins.
    await seedLabeledOpportunity([
      {
        stage: ATTEMPT_STAGE.INTERVIEW,
        submittedAt: new Date(),
        archived: true,
      },
    ]);

    expect(await appliedCounts()).toEqual({
      titles: 0,
      locations: 0,
      sources: 0,
    });
  });

  it("counts migrated applied rows whose submission date was never recorded", async () => {
    const company = await createCompany();
    const title = await createTitle("Engineer");
    await createLocation("Remote");
    // Legacy row frozen as applied with no date — the pre-migration shape
    // that produced stage-only ApplicationAttempt history.
    const legacy = await createLegacyJob({
      companyId: company.id,
      jobTitleId: title.id,
      applied: true,
      appliedDate: null,
    });
    const opp = await createOpportunity(company.id, {
      title: "Engineer",
      locationText: "Remote",
      sourceLabel: "Indeed",
    });
    await createAttempt(opp.id, {
      stage: ATTEMPT_STAGE.SUBMITTED,
      submittedAt: null,
    });
    await mapJobToOpportunity(legacy.id, opp.id);
    await migratedAb();

    expect(await appliedCounts()).toEqual({
      titles: 1,
      locations: 1,
      sources: 1,
    });
    const titles = await getJobTitleList(1, 50, "applied");
    expect(rowByLabel(titles, "Engineer")._count.jobsTotal).toBe(1);
  });
});

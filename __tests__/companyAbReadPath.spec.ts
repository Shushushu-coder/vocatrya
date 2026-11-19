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
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

// The company actions import the prisma singleton before module body env
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
import {
  deleteCompanyById,
  getCompanyDetails,
  getCompanyList,
} from "@/actions/company.actions";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";

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
  userId = await seedAccount(prisma, `company-ab-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `company-ab-other-${Date.now()}@example.com`,
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

async function createCompany(o: { label?: string; createdBy?: string } = {}) {
  return prisma.company.create({
    data: {
      label: o.label ?? "Acme",
      value: `co-${randomUUID()}`,
      createdBy: o.createdBy ?? userId,
    },
  });
}

async function createOpportunity(
  companyId: string,
  o: { userId?: string; title?: string; archived?: boolean } = {},
) {
  return prisma.jobOpportunity.create({
    data: {
      userId: o.userId ?? userId,
      companyId,
      title: o.title ?? "Engineer",
      status: "ACTIVE",
      archivedAt: o.archived ? new Date() : null,
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
      currentStageCategory:
        o.stage ??
        (o.submittedAt ? ATTEMPT_STAGE.SUBMITTED : ATTEMPT_STAGE.DRAFT),
      outcome: ATTEMPT_OUTCOME.ACTIVE,
      archivedAt: o.archived ? new Date() : null,
    },
  });
}

async function createLegacyJob(
  companyId: string,
  o: { applied?: boolean; statusValue?: string; userId?: string } = {},
) {
  const owner = o.userId ?? userId;
  const title = await prisma.jobTitle.create({
    data: {
      label: "Engineer",
      value: `title-${randomUUID()}`,
      createdBy: owner,
    },
  });
  const status = await prisma.jobStatus.findFirstOrThrow({
    where: { value: o.statusValue ?? "new" },
  });
  return prisma.job.create({
    data: {
      userId: owner,
      companyId,
      jobTitleId: title.id,
      statusId: status.id,
      jobType: "FT",
      description: "keep",
      applied: o.applied ?? false,
      appliedDate: o.applied ? new Date() : null,
      createdAt: new Date(),
    },
  });
}

describe("company list — legacy read family stays untouched", () => {
  it("keeps legacy Job statistics in legacy mode", async () => {
    const company = await createCompany();
    await createLegacyJob(company.id, { applied: true, statusValue: "applied" });
    await createLegacyJob(company.id, { statusValue: "rejected" });
    await createLegacyJob(company.id, { statusValue: "draft" });
    await prisma.contact.create({
      data: { name: "Dave", createdBy: userId, companyId: company.id },
    });

    const result = await getCompanyList(1, 10, "applied");

    expect(result.success).not.toBe(false);
    const row = result.data.find((c: any) => c.id === company.id);
    expect(row._count.jobsApplied).toBe(1);
    expect(row._count.jobsRejected).toBe(1);
    expect(row._count.jobsTotal).toBe(3);
    expect(row._count.contacts).toBe(1);
  });
});

describe("company list — A+B read family", () => {
  it("counts non-archived opportunities and submitted-attempt positions", async () => {
    await freshAb();
    const company = await createCompany();
    const applied = await createOpportunity(company.id);
    await createAttempt(applied.id, { submittedAt: new Date() });
    await createOpportunity(company.id, { title: "Unapplied" });
    await prisma.contact.create({
      data: { name: "Dave", createdBy: userId, companyId: company.id },
    });

    const result = await getCompanyList(1, 10, "applied");

    const row = result.data.find((c: any) => c.id === company.id);
    expect(row._count.jobsTotal).toBe(2);
    expect(row._count.jobsApplied).toBe(1);
    expect(row._count.contacts).toBe(1);
    // Rejected is not computed in A+B — no fake zero leaks into the row.
    expect(row._count.jobsRejected).toBeUndefined();
  });

  it("counts one opportunity once even with several submitted attempts", async () => {
    await freshAb();
    const company = await createCompany();
    const opp = await createOpportunity(company.id);
    await createAttempt(opp.id, {
      submittedAt: new Date("2026-01-01"),
      createdAt: new Date("2026-01-01"),
    });
    await createAttempt(opp.id, {
      submittedAt: new Date("2026-03-01"),
      createdAt: new Date("2026-03-01"),
    });

    const result = await getCompanyList(1, 10, "applied");

    const row = result.data.find((c: any) => c.id === company.id);
    expect(row._count.jobsTotal).toBe(1);
    expect(row._count.jobsApplied).toBe(1);
  });

  it("a stage-only attempt without submittedAt still counts as applied", async () => {
    await freshAb();
    const company = await createCompany();
    // Migrated-history shape: a formal stage, no provable submission date.
    const stageOnly = await createOpportunity(company.id);
    await createAttempt(stageOnly.id, {
      submittedAt: null,
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    const draft = await createOpportunity(company.id, { title: "Draft" });
    await createAttempt(draft.id, { submittedAt: null });

    const result = await getCompanyList(1, 10, "applied");

    const row = result.data.find((c: any) => c.id === company.id);
    expect(row._count.jobsTotal).toBe(2);
    expect(row._count.jobsApplied).toBe(1);

    const details = await getCompanyDetails(company.id);
    expect(details.appliedCount).toBe(1);
    const stageOnlyRow = details.jobs.find((j: any) => j.id === stageOnly.id);
    expect(stageOnlyRow.applied).toBe(true);
    expect(stageOnlyRow.appliedDate).toBeNull();
  });

  it("a draft after a submitted attempt still counts as applied", async () => {
    await freshAb();
    const company = await createCompany();
    const opp = await createOpportunity(company.id);
    await createAttempt(opp.id, {
      submittedAt: new Date("2026-01-01"),
      createdAt: new Date("2026-01-01"),
    });
    await createAttempt(opp.id, {
      submittedAt: null,
      createdAt: new Date("2026-06-01"),
    });

    const result = await getCompanyList(1, 10, "applied");

    const row = result.data.find((c: any) => c.id === company.id);
    expect(row._count.jobsApplied).toBe(1);
  });

  it("archived opportunities (and their attempts) stay out of display stats", async () => {
    await freshAb();
    const company = await createCompany();
    await createOpportunity(company.id);
    const archived = await createOpportunity(company.id, { archived: true });
    await createAttempt(archived.id, { submittedAt: new Date() });

    const result = await getCompanyList(1, 10, "applied");

    const row = result.data.find((c: any) => c.id === company.id);
    expect(row._count.jobsTotal).toBe(1);
    expect(row._count.jobsApplied).toBe(0);
  });

  it("does not treat opportunity lifecycle status as application state", async () => {
    await freshAb();
    const company = await createCompany();
    // ACTIVE/CLOSED describe the posting, not a submission — with no attempt
    // the applied count must stay zero.
    await prisma.jobOpportunity.create({
      data: { userId, companyId: company.id, title: "A", status: "ACTIVE" },
    });
    await prisma.jobOpportunity.create({
      data: { userId, companyId: company.id, title: "C", status: "CLOSED" },
    });

    const result = await getCompanyList(1, 10, "applied");

    const row = result.data.find((c: any) => c.id === company.id);
    expect(row._count.jobsTotal).toBe(2);
    expect(row._count.jobsApplied).toBe(0);
  });

  it("never aggregates another user's companies or opportunities", async () => {
    await freshAb();
    const mine = await createCompany({ label: "Mine" });
    await createOpportunity(mine.id);
    const theirs = await createCompany({ createdBy: otherUserId });
    const foreign = await createOpportunity(theirs.id, { userId: otherUserId });
    await createAttempt(foreign.id, {
      userId: otherUserId,
      submittedAt: new Date(),
    });

    const result = await getCompanyList(1, 10, "applied");

    expect(result.data.map((c: any) => c.id)).toEqual([mine.id]);
    const row = result.data.find((c: any) => c.id === mine.id);
    expect(row._count.jobsTotal).toBe(1);
    expect(row._count.jobsApplied).toBe(0);
  });

  it("migrated databases never double-count legacy Job plus Opportunity", async () => {
    const company = await createCompany();
    const job = await createLegacyJob(company.id, { applied: true });
    const opp = await createOpportunity(company.id);
    await createAttempt(opp.id, { submittedAt: new Date() });
    await prisma.legacyMigrationMap.create({
      data: {
        userId,
        legacyEntityType: LEGACY.JOB,
        legacyEntityId: job.id,
        targetEntityType: TARGET.JOB_OPPORTUNITY,
        targetEntityId: opp.id,
        migrationVersion: PHASE3_MIGRATION_VERSION,
      },
    });
    await migratedAb();

    const result = await getCompanyList(1, 10, "applied");

    const row = result.data.find((c: any) => c.id === company.id);
    // One migrated position, counted once — legacy row never adds to it.
    expect(row._count.jobsTotal).toBe(1);
    expect(row._count.jobsApplied).toBe(1);
  });
});

describe("company details — A+B read family", () => {
  it("shows the company's real opportunities in the Jobs tab", async () => {
    await freshAb();
    const company = await createCompany();
    const applied = await createOpportunity(company.id, { title: "Applied" });
    await createAttempt(applied.id, {
      submittedAt: new Date("2026-09-01"),
      createdAt: new Date("2026-09-01"),
    });
    const draft = await createOpportunity(company.id, { title: "Saved" });
    await createOpportunity(company.id, { title: "Archived", archived: true });

    const details = await getCompanyDetails(company.id);

    expect(details.success).not.toBe(false);
    expect(details.jobs.map((j: any) => j.id)).toEqual(
      expect.arrayContaining([applied.id, draft.id]),
    );
    expect(details.jobs).toHaveLength(2); // archived row excluded
    // Same total scope as the list row.
    const list = await getCompanyList(1, 10, "applied");
    expect(list.data[0]._count.jobsTotal).toBe(details.jobs.length);
    // Applied count uses any-submitted-attempt semantics, not latest-only.
    expect(details.appliedCount).toBe(1);
    // Dismissed is explicitly unsupported in A+B — never a fake zero.
    expect(details.dismissedJobsCount).toBeNull();
    expect(details.jobs[0].abCompat).toBeDefined();
    expect(details.jobs[0].Status.value).toBeDefined();
  });

  it("returns an empty Jobs tab for a company with no opportunities", async () => {
    await freshAb();
    const company = await createCompany();

    const details = await getCompanyDetails(company.id);

    expect(details.success).not.toBe(false);
    expect(details.jobs).toEqual([]);
    expect(details.appliedCount).toBe(0);
    expect(details.dismissedJobsCount).toBeNull();
  });

  it("keeps contacts and company fields intact in A+B", async () => {
    await freshAb();
    const company = await createCompany({ label: "Stripe" });
    await prisma.contact.create({
      data: { name: "Dave", createdBy: userId, companyId: company.id },
    });
    await prisma.contact.create({
      data: {
        name: "Priya",
        createdBy: userId,
        workedAtCompanyId: company.id,
      },
    });

    const details = await getCompanyDetails(company.id);

    expect(details.label).toBe("Stripe");
    expect(details.currentContacts).toHaveLength(1);
    expect(details.formerContacts).toHaveLength(1);
  });
});

describe("company deletion guard", () => {
  it("blocks deleting a company referenced by an active opportunity", async () => {
    await freshAb();
    const company = await createCompany();
    await createOpportunity(company.id);

    const result = await deleteCompanyById(company.id);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/job opportunit/i);
    expect(
      await prisma.company.findUnique({ where: { id: company.id } }),
    ).not.toBeNull();
  });

  it("blocks deleting a company referenced only by an archived opportunity", async () => {
    await freshAb();
    const company = await createCompany();
    await createOpportunity(company.id, { archived: true });

    // The display stats already show zero — the guard must not trust that.
    const list = await getCompanyList(1, 10, "applied");
    expect(list.data[0]._count.jobsTotal).toBe(0);

    const result = await deleteCompanyById(company.id);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/opportunit/i);
    expect(
      await prisma.company.findUnique({ where: { id: company.id } }),
    ).not.toBeNull();
  });

  it("blocks deleting a company referenced by a recruitment campaign", async () => {
    await freshAb();
    const company = await createCompany();
    await prisma.recruitmentCampaign.create({
      data: { userId, companyId: company.id, name: "Spring" },
    });

    const result = await deleteCompanyById(company.id);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/campaign/i);
    expect(
      await prisma.company.findUnique({ where: { id: company.id } }),
    ).not.toBeNull();
  });

  it("still blocks on contacts and legacy jobs under the A+B family", async () => {
    await freshAb();
    const withContact = await createCompany({ label: "Contacted" });
    await prisma.contact.create({
      data: { name: "Dave", createdBy: userId, companyId: withContact.id },
    });

    const blocked = await deleteCompanyById(withContact.id);
    expect(blocked.success).toBe(false);
    expect(blocked.message).toMatch(/contact/i);
    expect(
      await prisma.company.findUnique({ where: { id: withContact.id } }),
    ).not.toBeNull();
  });

  it("keeps the legacy job guard intact in legacy mode", async () => {
    const company = await createCompany();
    await createLegacyJob(company.id);

    const result = await deleteCompanyById(company.id);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/associated jobs/i);
    expect(
      await prisma.company.findUnique({ where: { id: company.id } }),
    ).not.toBeNull();
  });

  it("deletes a company with no references", async () => {
    await freshAb();
    const company = await createCompany();

    const result = await deleteCompanyById(company.id);

    expect(result.success).toBe(true);
    expect(
      await prisma.company.findUnique({ where: { id: company.id } }),
    ).toBeNull();
  });
});

describe("blocked read family", () => {
  it("fails the list instead of silently reading legacy Job rows", async () => {
    const company = await createCompany();
    await createLegacyJob(company.id, { applied: true });
    await prisma.abMigrationState.create({
      data: {
        scopeKey: AB_INSTANCE_SCOPE_KEY,
        migrationKey: AB_MIGRATION_KEY,
        status: "IN_PROGRESS",
      },
    });

    const result = await getCompanyList(1, 10, "applied");

    expect(result.success).toBe(false);
    expect(result.message).toBe(CAREER_JOBS_UNAVAILABLE_MESSAGE);
  });

  it("fails details instead of masquerading as an empty Jobs tab", async () => {
    const company = await createCompany();
    await createLegacyJob(company.id);
    await prisma.abMigrationState.create({
      data: {
        scopeKey: AB_INSTANCE_SCOPE_KEY,
        migrationKey: AB_MIGRATION_KEY,
        status: "IN_PROGRESS",
      },
    });

    const result = await getCompanyDetails(company.id);

    expect(result).toEqual(
      expect.objectContaining({ success: false }),
    );
    expect(result.jobs).toBeUndefined();
  });
});

// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
} from "@/lib/career";
import { listJobs } from "@/lib/career/jobsReadDispatch";
import { applyJobOrderChange } from "@/lib/career/jobOrderService";
import { createOpportunityFromJobForm } from "@/lib/career/jobOpportunityAdapter";
import {
  JobOrderError,
  applyOrderChange,
  applyPinLocally,
  insertJobAfter,
  orderRowsForDisplay,
  resolveAfterJobId,
  type JobOrderRow,
} from "@/lib/jobs/jobOrder";
import { BackupDataSchema } from "@/lib/backup/schema";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};
const LEGACY_ENV = (() => {
  const env = { ...process.env };
  delete env[AB_RUNTIME_FEATURE_ENV];
  delete env[AB_ROLLOUT_SCOPE_ENV];
  return env;
})();

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

const row = (
  id: string,
  createdAt: string,
  sortOrder: number | null = null,
  pinnedAt: Date | null = null,
): JobOrderRow => ({
  id,
  createdAt: new Date(createdAt),
  sortOrder,
  pinnedAt,
});

const NOW = new Date("2026-01-01T00:00:00.000Z");

describe("jobOrder pure contract", () => {
  it("keeps the pre-feature createdAt-desc order when nothing is positioned", () => {
    const rows = [
      row("old", "2024-01-01"),
      row("new", "2024-03-01"),
      row("mid", "2024-02-01"),
    ];
    expect(orderRowsForDisplay(rows).map((r) => r.id)).toEqual([
      "new",
      "mid",
      "old",
    ]);
  });

  it("orders pinned first, then unpositioned, then positioned", () => {
    const rows = [
      row("positioned", "2024-01-01", 0),
      row("pinned", "2024-01-02", 0, NOW),
      row("unpositioned", "2024-03-01"),
    ];
    expect(orderRowsForDisplay(rows).map((r) => r.id)).toEqual([
      "pinned",
      "unpositioned",
      "positioned",
    ]);
  });

  it("move reorders inside a section and materializes every unpositioned row", () => {
    const rows = [row("a", "2024-01-03"), row("b", "2024-01-02"), row("c", "2024-01-01")];
    const { orderedIds, updates } = applyOrderChange(rows, {
      kind: "move",
      jobId: "c",
      afterJobId: "a",
    });
    expect(orderedIds).toEqual(["a", "c", "b"]);
    // First write materializes all three rows into dense positions.
    expect(updates).toHaveLength(3);
    expect(updates.find((u) => u.id === "c")).toMatchObject({
      sortOrder: 1,
      pinnedAt: null,
    });
  });

  it("move to the front uses afterJobId=null", () => {
    const rows = [
      row("a", "2024-01-03", 0),
      row("b", "2024-01-02", 1),
      row("c", "2024-01-01", 2),
    ];
    const { orderedIds, updates } = applyOrderChange(rows, {
      kind: "move",
      jobId: "c",
      afterJobId: null,
    });
    expect(orderedIds).toEqual(["c", "a", "b"]);
    expect(updates.find((u) => u.id === "c")?.sortOrder).toBe(0);
  });

  it("pin lands at the front of the pinned section; unpin at the front of the normal section", () => {
    const rows = [
      row("p1", "2024-01-04", 0, NOW),
      row("a", "2024-01-03", 0),
      row("b", "2024-01-02", 1),
      row("c", "2024-01-01", 2),
    ];
    const pinned = applyOrderChange(rows, { kind: "pin", jobId: "b" });
    expect(pinned.orderedIds).toEqual(["b", "p1", "a", "c"]);
    expect(
      pinned.updates.find((u) => u.id === "b")?.pinnedAt,
    ).toBeInstanceOf(Date);

    const unpinned = applyOrderChange(
      [
        row("p1", "2024-01-04", 0, NOW),
        row("b", "2024-01-02", 1, NOW),
        row("a", "2024-01-03", 0),
        row("c", "2024-01-01", 1),
      ],
      { kind: "unpin", jobId: "p1" },
    );
    expect(unpinned.orderedIds).toEqual(["b", "p1", "a", "c"]);
    expect(unpinned.updates.find((u) => u.id === "p1")).toMatchObject({
      sortOrder: 0,
      pinnedAt: null,
    });
  });

  it("rejects cross-section moves and unknown ids", () => {
    const rows = [
      row("p", "2024-01-02", 0, NOW),
      row("n", "2024-01-01", 0),
    ];
    expect(() =>
      applyOrderChange(rows, {
        kind: "move",
        jobId: "n",
        afterJobId: "p",
      }),
    ).toThrowError(JobOrderError);
    expect(() =>
      applyOrderChange(rows, {
        kind: "move",
        jobId: "p",
        afterJobId: "n",
      }),
    ).toThrowError(/pinned boundary/);
    expect(() =>
      applyOrderChange(rows, { kind: "pin", jobId: "missing" }),
    ).toThrowError(/not found/i);
  });

  it("a no-change move produces no updates", () => {
    const rows = [row("a", "2024-01-02", 0), row("b", "2024-01-01", 1)];
    const { updates } = applyOrderChange(rows, {
      kind: "move",
      jobId: "a",
      afterJobId: null,
    });
    expect(updates).toEqual([]);
  });

  it("resolveAfterJobId maps drag ends to the insert-after contract", () => {
    const ids = ["a", "b", "c", "d"];
    // Drag down: c dropped on d lands after d.
    expect(resolveAfterJobId(ids, "c", "d")).toBe("d");
    // Drag up: d dropped on a lands at the front (afterJobId null).
    expect(resolveAfterJobId(ids, "d", "a")).toBeNull();
    // Drag up onto b: lands before b = after a.
    expect(resolveAfterJobId(ids, "d", "b")).toBe("a");
    // Same id or foreign section is a no-op.
    expect(resolveAfterJobId(ids, "a", "a")).toBeUndefined();
    expect(resolveAfterJobId(ids, "a", "x")).toBeUndefined();
  });

  it("client optimistic helpers mirror the server contract", () => {
    const items = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(
      insertJobAfter(items, "c", "a").map((i) => i.id),
    ).toEqual(["a", "c", "b"]);
    expect(
      insertJobAfter(items, "a", null).map((i) => i.id),
    ).toEqual(["a", "b", "c"]);

    const jobs = [
      { id: "p", pinnedAt: NOW },
      { id: "a", pinnedAt: null },
      { id: "b", pinnedAt: null },
    ];
    expect(
      applyPinLocally(jobs, "b", true).map((i) => i.id),
    ).toEqual(["b", "p", "a"]);
    expect(
      applyPinLocally(jobs, "p", false).map((i) => i.id),
    ).toEqual(["p", "a", "b"]);
    expect(
      applyPinLocally(jobs, "p", false)[0].pinnedAt,
    ).toBeNull();
  });
});

async function seedLegacyUser(email: string) {
  const userId = await seedAccount(prisma, email);
  const company = await prisma.company.create({
    data: { label: "Acme", value: `acme-${userId}`, createdBy: userId },
  });
  const title = await prisma.jobTitle.create({
    data: { label: "Engineer", value: `eng-${userId}`, createdBy: userId },
  });
  const status = await prisma.jobStatus.findUniqueOrThrow({
    where: { value: "draft" },
  });
  return { userId, company, title, status };
}

async function createLegacyJob(
  seed: Awaited<ReturnType<typeof seedLegacyUser>>,
  createdAt: Date,
  extra: Record<string, unknown> = {},
) {
  return prisma.job.create({
    data: {
      userId: seed.userId,
      companyId: seed.company.id,
      jobTitleId: seed.title.id,
      statusId: seed.status.id,
      jobType: "FT",
      description: "jd",
      createdAt,
      ...extra,
    },
  });
}

const idsOf = (result: { data?: Array<{ id: string }> }) =>
  (result.data ?? []).map((job) => job.id);

describe("legacy job ordering (isolated DB)", () => {
  it("first custom view preserves the existing createdAt-desc order", async () => {
    const seed = await seedLegacyUser("order-legacy-1@example.com");
    const a = await createLegacyJob(seed, new Date("2024-01-03"));
    const b = await createLegacyJob(seed, new Date("2024-01-02"));
    const c = await createLegacyJob(seed, new Date("2024-01-01"));

    const listed = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      LEGACY_ENV,
    );
    expect(idsOf(listed)).toEqual([a.id, b.id, c.id]);
    // Read-only: the query must not write ordering columns.
    const stored = await prisma.job.findMany({
      where: { userId: seed.userId },
      select: { sortOrder: true, pinnedAt: true },
    });
    expect(stored.every((row) => row.sortOrder === null && row.pinnedAt === null)).toBe(true);
  });

  it("reorder persists and keeps other rows' relative order", async () => {
    const seed = await seedLegacyUser("order-legacy-2@example.com");
    const a = await createLegacyJob(seed, new Date("2024-01-04"));
    const b = await createLegacyJob(seed, new Date("2024-01-03"));
    const c = await createLegacyJob(seed, new Date("2024-01-02"));
    const d = await createLegacyJob(seed, new Date("2024-01-01"));

    await applyJobOrderChange(prisma, "legacy", seed.userId, {
      kind: "move",
      jobId: d.id,
      afterJobId: a.id,
    });
    const listed = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      LEGACY_ENV,
    );
    expect(idsOf(listed)).toEqual([a.id, d.id, b.id, c.id]);

    // Re-read after save returns the persisted order.
    const reread = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      LEGACY_ENV,
    );
    expect(idsOf(reread)).toEqual([a.id, d.id, b.id, c.id]);
    // Date sort still available and unaffected.
    const dateSorted = await listJobs(prisma, seed.userId, {}, LEGACY_ENV);
    expect(idsOf(dateSorted)).toEqual([a.id, b.id, c.id, d.id]);
  });

  it("pin lands before every ordinary job; unpin returns to the front of the normal section", async () => {
    const seed = await seedLegacyUser("order-legacy-3@example.com");
    const a = await createLegacyJob(seed, new Date("2024-01-03"));
    const b = await createLegacyJob(seed, new Date("2024-01-02"));
    const c = await createLegacyJob(seed, new Date("2024-01-01"));

    await applyJobOrderChange(prisma, "legacy", seed.userId, {
      kind: "pin",
      jobId: c.id,
    });
    let listed = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      LEGACY_ENV,
    );
    expect(idsOf(listed)).toEqual([c.id, a.id, b.id]);
    expect(
      (listed.data ?? []).find((job) => job.id === c.id)?.pinnedAt,
    ).not.toBeNull();

    await applyJobOrderChange(prisma, "legacy", seed.userId, {
      kind: "unpin",
      jobId: c.id,
    });
    listed = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      LEGACY_ENV,
    );
    expect(idsOf(listed)).toEqual([c.id, a.id, b.id]);
    expect(
      (listed.data ?? []).find((job) => job.id === c.id)?.pinnedAt,
    ).toBeNull();
  });

  it("a new job lands at the front of the ordinary section, after pinned jobs", async () => {
    const seed = await seedLegacyUser("order-legacy-4@example.com");
    const pinned = await createLegacyJob(seed, new Date("2024-01-03"));
    const a = await createLegacyJob(seed, new Date("2024-01-02"));
    await applyJobOrderChange(prisma, "legacy", seed.userId, {
      kind: "pin",
      jobId: pinned.id,
    });
    const fresh = await createLegacyJob(seed, new Date("2024-02-01"));
    const listed = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      LEGACY_ENV,
    );
    expect(idsOf(listed)).toEqual([pinned.id, fresh.id, a.id]);
  });

  it("a page-local move leaves the relative order on other pages untouched", async () => {
    const seed = await seedLegacyUser("order-legacy-5@example.com");
    // j1..j6 created oldest→newest, so the display order is j6..j1.
    const jobs = [] as Array<{ id: string }>;
    for (let i = 1; i <= 6; i += 1) {
      jobs.push(
        await createLegacyJob(seed, new Date(`2024-01-0${i}`)),
      );
    }
    const [j1, j2, j3, j4, j5, j6] = jobs;
    // Pre-move display: j6 j5 j4 j3 j2 j1. Move j5 (page 1) after j3:
    // → j6 j4 j3 j5 j2 j1.
    await applyJobOrderChange(prisma, "legacy", seed.userId, {
      kind: "move",
      jobId: j5.id,
      afterJobId: j3.id,
    });
    const page1 = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom", skip: 0, take: 2 },
      LEGACY_ENV,
    );
    expect(idsOf(page1)).toEqual([j6.id, j4.id]);
    const page2 = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom", skip: 2, take: 2 },
      LEGACY_ENV,
    );
    expect(idsOf(page2)).toEqual([j3.id, j5.id]);
    const page3 = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom", skip: 4, take: 2 },
      LEGACY_ENV,
    );
    // The two rows nobody dragged keep their original relative order.
    expect(idsOf(page3)).toEqual([j2.id, j1.id]);
  });

  it("scoped writes never touch another user's jobs", async () => {
    const mine = await seedLegacyUser("order-legacy-6@example.com");
    const theirs = await seedLegacyUser("order-legacy-7@example.com");
    const mineA = await createLegacyJob(mine, new Date("2024-01-02"));
    const mineB = await createLegacyJob(mine, new Date("2024-01-01"));
    const theirJob = await createLegacyJob(theirs, new Date("2024-01-03"));

    // A foreign afterJobId is not in the user's ordering universe.
    await expect(
      applyJobOrderChange(prisma, "legacy", mine.userId, {
        kind: "move",
        jobId: mineA.id,
        afterJobId: theirJob.id,
      }),
    ).rejects.toThrowError(/not found/i);
    // A foreign jobId cannot be pinned either.
    await expect(
      applyJobOrderChange(prisma, "legacy", mine.userId, {
        kind: "pin",
        jobId: theirJob.id,
      }),
    ).rejects.toThrowError(/not found/i);

    await applyJobOrderChange(prisma, "legacy", mine.userId, {
      kind: "pin",
      jobId: mineB.id,
    });
    const theirsListed = await listJobs(
      prisma,
      theirs.userId,
      { sortBy: "custom" },
      LEGACY_ENV,
    );
    expect(
      (theirsListed.data ?? []).find((job) => job.id === theirJob.id)
        ?.pinnedAt,
    ).toBeNull();
    const mineListed = await listJobs(
      prisma,
      mine.userId,
      { sortBy: "custom" },
      LEGACY_ENV,
    );
    expect(idsOf(mineListed)).toEqual([mineB.id, mineA.id]);
  });
});

describe("A+B job ordering (isolated DB)", () => {
  async function seedAbUser(email: string) {
    const userId = await seedAccount(prisma, email);
    await activateFreshAbNative(prisma);
    const company = await prisma.company.create({
      data: { label: "Acme", value: `ab-co-${userId}`, createdBy: userId },
    });
    const title = await prisma.jobTitle.create({
      data: { label: "Engineer", value: `ab-eng-${userId}`, createdBy: userId },
    });
    const status = await prisma.jobStatus.findUniqueOrThrow({
      where: { value: "draft" },
    });
    return { userId, company, title, status };
  }

  async function createOpportunity(
    seed: Awaited<ReturnType<typeof seedAbUser>>,
    title = "Engineer",
  ) {
    return createOpportunityFromJobForm(
      prisma,
      seed.userId,
      {
        title: seed.title.id,
        company: seed.company.id,
        type: "FT",
        status: seed.status.id,
        jobDescription: "<p>jd</p>",
        applied: false,
      },
      FEATURE_ON,
    );
  }

  it("first custom view preserves createdAt-desc; pin and move persist", async () => {
    const seed = await seedAbUser("order-ab-1@example.com");
    const a = await createOpportunity(seed);
    const b = await createOpportunity(seed);
    const c = await createOpportunity(seed);
    // Same-second createdAt rows still order newest-first (id tie-break
    // aside, they are all unpositioned so the contract is createdAt desc).
    const first = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      FEATURE_ON,
    );
    const firstIds = idsOf(first);
    expect(new Set(firstIds)).toEqual(new Set([a.id, b.id, c.id]));
    expect(firstIds[0]).toBe(c.id); // last created = newest

    await applyJobOrderChange(prisma, "ab", seed.userId, {
      kind: "pin",
      jobId: a.id,
    });
    const pinned = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      FEATURE_ON,
    );
    expect(idsOf(pinned)[0]).toBe(a.id);
    expect(
      (pinned.data ?? []).find((job) => job.id === a.id)?.pinnedAt,
    ).not.toBeNull();

    await applyJobOrderChange(prisma, "ab", seed.userId, {
      kind: "move",
      jobId: c.id,
      afterJobId: b.id,
    });
    const moved = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      FEATURE_ON,
    );
    const movedIds = idsOf(moved);
    expect(movedIds[0]).toBe(a.id); // pinned stays on top
    expect(movedIds.indexOf(c.id)).toBeGreaterThan(
      movedIds.indexOf(b.id),
    );

    // Persistence on re-read.
    const reread = await listJobs(
      prisma,
      seed.userId,
      { sortBy: "custom" },
      FEATURE_ON,
    );
    expect(idsOf(reread)).toEqual(movedIds);
  });
});

describe("backup schema compatibility", () => {
  it("accepts ordering fields and tolerates their absence", () => {
    const jobRow = {
      id: "job-1",
      jobUrl: null,
      description: "jd",
      jobType: "FT",
      workplaceType: null,
      createdAt: new Date().toISOString(),
      applied: false,
      appliedDate: null,
      dueDate: null,
      statusValue: "draft",
      jobTitleId: "title-1",
      companyId: "company-1",
      jobSourceId: null,
      salaryRange: null,
      locationId: null,
      resumeId: null,
      coverLetterId: null,
      automationId: null,
      matchScore: null,
      matchData: null,
      discoveryStatus: null,
      discoveredAt: null,
      createdVia: null,
      descriptionCompleteness: null,
      sortOrder: 2,
      pinnedAt: new Date().toISOString(),
    };
    const withOrder = BackupDataSchema.safeParse({ Job: [jobRow] });
    expect(withOrder.success).toBe(true);
    if (withOrder.success) {
      expect(withOrder.data.Job[0].sortOrder).toBe(2);
      expect(withOrder.data.Job[0].pinnedAt).toBeInstanceOf(Date);
    }

    // A pre-feature backup row has no such keys at all — still importable.
    const { sortOrder: _s, pinnedAt: _p, ...legacyRow } = jobRow;
    const withoutOrder = BackupDataSchema.safeParse({ Job: [legacyRow] });
    expect(withoutOrder.success).toBe(true);
    if (withoutOrder.success) {
      expect(withoutOrder.data.Job[0].sortOrder).toBeUndefined();
      expect(withoutOrder.data.Job[0].pinnedAt).toBeUndefined();
    }
  });
});

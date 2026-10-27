// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  APPLIED_ATTEMPT_WHERE,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  OPPORTUNITY_STATUS,
  UPCOMING_EVENT_KIND,
  activateFreshAbNative,
} from "@/lib/career";
import {
  getOpportunityAsJob,
  listOpportunitiesAsJobs,
} from "@/lib/career/jobOpportunityAdapter";
import {
  iterateJobs,
  listJobs,
  loadDashboardJobCounts,
  loadJobsAppliedDateCounts,
  loadRecentJobs,
} from "@/lib/career/jobsReadDispatch";
import { listUpcomingApplicationEvents } from "@/lib/career/upcomingReadModel";
import { runtimeTimeZone } from "@/lib/datetime";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};
const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;
let companyId: string;
let otherCompanyId: string;

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
  userId = await seedAccount(prisma, `truth-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `truth-other-${Date.now()}@example.com`,
  );
  await activateFreshAbNative(prisma);
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-truth-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  otherCompanyId = (
    await prisma.company.create({
      data: {
        label: "OtherCo",
        value: `other-truth-${Date.now()}`,
        createdBy: otherUserId,
      },
    })
  ).id;
});

async function createOpportunity(
  o: {
    userId?: string;
    companyId?: string;
    title?: string;
    deadline?: Date | null;
    status?: string;
    archived?: boolean;
    createdAt?: Date;
  } = {},
) {
  return prisma.jobOpportunity.create({
    data: {
      userId: o.userId ?? userId,
      companyId: o.companyId ?? companyId,
      title: o.title ?? "Engineer",
      status: o.status ?? OPPORTUNITY_STATUS.UNKNOWN,
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
    channelLabel?: string;
  } = {},
) {
  return prisma.applicationAttempt.create({
    data: {
      userId: o.userId ?? userId,
      jobOpportunityId,
      channelLabel: o.channelLabel ?? "TEST",
      submittedAt: o.submittedAt ?? null,
      createdAt: o.createdAt ?? new Date(),
      currentStageCategory: o.stage ?? ATTEMPT_STAGE.DRAFT,
      outcome: o.outcome ?? ATTEMPT_OUTCOME.ACTIVE,
      archivedAt: o.archived ? new Date() : null,
    },
  });
}

async function upcomingDeadlineTitles(uid = userId) {
  const { events } = await listUpcomingApplicationEvents(prisma, uid, runtimeTimeZone());
  return events
    .filter((row) => row.kind === UPCOMING_EVENT_KIND.APPLICATION_DEADLINE)
    .map((row) => row.roleTitle);
}

describe("applied fact — DTO, list and detail agree", () => {
  it("no attempt: never applied, no date, absent from applied reads", async () => {
    const created = await createOpportunity({ title: "Saved role" });
    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    const row = listed.data.find((r) => r.id === created.id)!;
    expect(row.applied).toBe(false);
    expect(row.appliedDate).toBeNull();
    expect(row.abCompat.uiStatus).toBe("draft");
    expect(row.abCompat.hasApplicationAttempt).toBe(false);

    for (const options of [
      { appliedOnly: true },
      { filter: "applied" },
    ] as const) {
      const filtered = await listOpportunitiesAsJobs(prisma, userId, options);
      expect(filtered.total).toBe(0);
    }
    const detail = await getOpportunityAsJob(prisma, userId, created.id);
    expect(detail?.applied).toBe(false);
    expect(detail?.appliedDate).toBeNull();
  });

  it("single formal submission: applied with that exact date", async () => {
    const submittedAt = new Date("2026-09-10T08:00:00.000Z");
    const created = await createOpportunity({ title: "Applied role" });
    await createAttempt(created.id, {
      submittedAt,
      createdAt: new Date("2026-09-01T08:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });

    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    const row = listed.data.find((r) => r.id === created.id)!;
    expect(row.applied).toBe(true);
    // createdAt is earlier than the real submission: the date must come from
    // submittedAt, never inferred from createdAt.
    expect(row.appliedDate?.toISOString()).toBe(submittedAt.toISOString());
    expect(row.abCompat.uiStatus).toBe("applied");

    const appliedOnly = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    expect(appliedOnly.total).toBe(1);
    expect(appliedOnly.data[0].id).toBe(created.id);
  });

  it("multiple submissions still count once; appliedDate is the FIRST", async () => {
    const first = new Date("2026-01-15T00:00:00.000Z");
    const second = new Date("2026-06-15T00:00:00.000Z");
    const created = await createOpportunity({ title: "Twice applied" });
    // Older createdAt but later submittedAt on the second attempt guards
    // against ordering traps in both directions.
    await createAttempt(created.id, {
      submittedAt: second,
      createdAt: new Date("2026-01-10T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    await createAttempt(created.id, {
      submittedAt: first,
      createdAt: new Date("2026-06-10T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });

    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    const row = listed.data.find((r) => r.id === created.id)!;
    expect(row.applied).toBe(true);
    expect(row.appliedDate?.toISOString()).toBe(first.toISOString());

    const appliedOnly = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    expect(appliedOnly.total).toBe(1);
    const viaFilter = await listOpportunitiesAsJobs(prisma, userId, {
      filter: "applied",
    });
    expect(viaFilter.total).toBe(1);
    expect(viaFilter.data[0].id).toBe(created.id);
  });

  it("a newer draft attempt does not erase the submission fact", async () => {
    const first = new Date("2026-03-01T00:00:00.000Z");
    const created = await createOpportunity({ title: "Re-applying" });
    await createAttempt(created.id, {
      submittedAt: first,
      createdAt: new Date("2026-03-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      outcome: ATTEMPT_OUTCOME.REJECTED,
    });
    const draft = await createAttempt(created.id, {
      submittedAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.DRAFT,
    });
    expect(draft.submittedAt).toBeNull();

    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    const row = listed.data.find((r) => r.id === created.id)!;
    // Stage still derives from the actual latest attempt…
    expect(row.abCompat.uiStatus).toBe("draft");
    // …but the applied fact and first-submission date survive.
    expect(row.applied).toBe(true);
    expect(row.appliedDate?.toISOString()).toBe(first.toISOString());

    for (const options of [
      { appliedOnly: true },
      { filter: "applied" },
    ] as const) {
      const filtered = await listOpportunitiesAsJobs(prisma, userId, options);
      expect(filtered.total).toBe(1);
      expect(filtered.data[0].id).toBe(created.id);
    }
    const detail = await getOpportunityAsJob(prisma, userId, created.id);
    expect(detail?.applied).toBe(true);
    expect(detail?.appliedDate?.toISOString()).toBe(first.toISOString());
  });

  it("archived attempts carry no submission fact", async () => {
    const onlyArchived = await createOpportunity({ title: "Archived submit" });
    await createAttempt(onlyArchived.id, {
      submittedAt: new Date("2026-04-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      archived: true,
    });
    const liveDraft = await createOpportunity({ title: "Draft over archive" });
    await createAttempt(liveDraft.id, {
      submittedAt: new Date("2026-04-02T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      archived: true,
    });
    await createAttempt(liveDraft.id, {
      submittedAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const mixed = await createOpportunity({ title: "Archived plus live" });
    await createAttempt(mixed.id, {
      submittedAt: new Date("2026-04-03T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      archived: true,
    });
    await createAttempt(mixed.id, {
      submittedAt: new Date("2026-05-03T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });

    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    const byId = new Map(listed.data.map((r) => [r.id, r]));
    expect(byId.get(onlyArchived.id)!.applied).toBe(false);
    expect(byId.get(onlyArchived.id)!.appliedDate).toBeNull();
    expect(byId.get(liveDraft.id)!.applied).toBe(false);
    expect(byId.get(mixed.id)!.applied).toBe(true);
    expect(byId.get(mixed.id)!.appliedDate?.toISOString()).toBe(
      "2026-05-03T00:00:00.000Z",
    );

    const appliedOnly = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    expect(appliedOnly.total).toBe(1);
    expect(appliedOnly.data[0].id).toBe(mixed.id);
  });

  it("a live draft attempt without submittedAt is not applied", async () => {
    const created = await createOpportunity({ title: "Draft attempt" });
    await createAttempt(created.id, {
      submittedAt: null,
      stage: ATTEMPT_STAGE.DRAFT,
    });

    const row = (
      await listOpportunitiesAsJobs(prisma, userId, {})
    ).data.find((r) => r.id === created.id)!;
    expect(row.applied).toBe(false);
    expect(row.appliedDate).toBeNull();
    expect(row.abCompat.uiStatus).toBe("draft");

    for (const options of [
      { appliedOnly: true },
      { filter: "applied" },
    ] as const) {
      const filtered = await listOpportunitiesAsJobs(prisma, userId, options);
      expect(filtered.total).toBe(0);
    }
  });

  it.each([
    ["SUBMITTED", ATTEMPT_STAGE.SUBMITTED],
    ["INTERVIEW", ATTEMPT_STAGE.INTERVIEW],
    ["OFFER", ATTEMPT_STAGE.OFFER],
  ])(
    "stage-only %s attempt: applied without a fabricated date",
    async (_label, stage) => {
      const created = await createOpportunity({ title: `Stage ${stage}` });
      // Phase-3 migration shape: a real stage, no provable submittedAt.
      await createAttempt(created.id, {
        submittedAt: null,
        createdAt: new Date("2024-01-01T00:00:00.000Z"),
        stage,
      });

      const row = (
        await listOpportunitiesAsJobs(prisma, userId, {})
      ).data.find((r) => r.id === created.id)!;
      // The ever-applied fact holds…
      expect(row.applied).toBe(true);
      // …but the first-submission date stays null — never inferred from
      // createdAt, the stage, or migration time.
      expect(row.appliedDate).toBeNull();

      for (const options of [
        { appliedOnly: true },
        { filter: "applied" },
      ] as const) {
        const filtered = await listOpportunitiesAsJobs(prisma, userId, options);
        expect(filtered.total).toBe(1);
        expect(filtered.data[0].id).toBe(created.id);
        expect(filtered.data[0].applied).toBe(true);
        expect(filtered.data[0].appliedDate).toBeNull();
      }
      const detail = await getOpportunityAsJob(prisma, userId, created.id);
      expect(detail?.applied).toBe(true);
      expect(detail?.appliedDate).toBeNull();
    },
  );

  it("migrated stage-only attempts keep stage display without a fabricated submission", async () => {
    const migrated = await createOpportunity({ title: "Migrated interview" });
    // Phase-3 migration evidence: real stage, no provable submittedAt.
    await createAttempt(migrated.id, {
      submittedAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.INTERVIEW,
    });

    const listed = await listOpportunitiesAsJobs(prisma, userId, {});
    const row = listed.data.find((r) => r.id === migrated.id)!;
    expect(row.abCompat.uiStatus).toBe("interview");
    // Stage-aware applied fact: applied even though no submission timestamp
    // survives; the date itself stays unfabricated.
    expect(row.applied).toBe(true);
    expect(row.appliedDate).toBeNull();

    const appliedOnly = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    expect(appliedOnly.total).toBe(1);
    expect(appliedOnly.data[0].id).toBe(migrated.id);
    const interview = await listOpportunitiesAsJobs(prisma, userId, {
      filter: "interview",
    });
    expect(interview.total).toBe(1);
    expect(interview.data[0].id).toBe(migrated.id);
  });

  it("never counts another user's submissions", async () => {
    const mine = await createOpportunity({ title: "Mine draft" });
    const theirs = await createOpportunity({
      userId: otherUserId,
      companyId: otherCompanyId,
      title: "Theirs",
    });
    await createAttempt(theirs.id, {
      userId: otherUserId,
      submittedAt: new Date("2026-05-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    await createAttempt(mine.id, { submittedAt: null });

    const listed = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    expect(listed.total).toBe(0);
    const detail = await getOpportunityAsJob(prisma, userId, theirs.id);
    expect(detail).toBeNull();
    const mineRow = (
      await listOpportunitiesAsJobs(prisma, userId, {})
    ).data.find((r) => r.id === mine.id)!;
    expect(mineRow.applied).toBe(false);
  });
});

describe("applied filter consistency across every entry point", () => {
  it("listJobs filter=applied, appliedOnly, adapter and export iterator agree", async () => {
    const applied = await createOpportunity({ title: "Applied once" });
    await createAttempt(applied.id, {
      submittedAt: new Date("2026-02-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    const reapplied = await createOpportunity({ title: "Draft over history" });
    await createAttempt(reapplied.id, {
      submittedAt: new Date("2026-01-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      outcome: ATTEMPT_OUTCOME.REJECTED,
    });
    await createAttempt(reapplied.id, {
      submittedAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    // Stage-only applied history (no provable submittedAt) belongs to the
    // same ever-applied set under every entry point.
    const stageOnly = await createOpportunity({ title: "Stage only" });
    await createAttempt(stageOnly.id, {
      submittedAt: null,
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    await createOpportunity({ title: "Never applied" });

    const expected = [applied.id, reapplied.id, stageOnly.id].sort();
    const adapterApplied = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    const adapterFilter = await listOpportunitiesAsJobs(prisma, userId, {
      filter: "applied",
    });
    const viaChip = await listJobs(
      prisma,
      userId,
      { appliedOnly: true },
      FEATURE_ON,
    );
    const viaStatusSelect = await listJobs(
      prisma,
      userId,
      { filter: "applied" },
      FEATURE_ON,
    );
    expect(viaChip.blocked).toBe(false);
    expect(viaStatusSelect.blocked).toBe(false);
    if (viaChip.blocked || viaStatusSelect.blocked) return;

    const exported: string[] = [];
    for await (const chunk of iterateJobs(
      prisma,
      userId,
      "applied",
      200,
      FEATURE_ON,
    )) {
      exported.push(...chunk.map((row) => row.id));
    }

    for (const result of [
      adapterApplied,
      adapterFilter,
      viaChip,
      viaStatusSelect,
    ]) {
      expect(result.total).toBe(3);
      expect(result.data.map((r: { id: string }) => r.id).sort()).toEqual(
        expected,
      );
    }
    expect(exported.sort()).toEqual(expected);
    // Row-level fact agrees with membership in the filtered list; the
    // stage-only member carries the fact but no fabricated date.
    for (const row of adapterApplied.data) {
      expect(row.applied).toBe(true);
      if (row.id === stageOnly.id) {
        expect(row.appliedDate).toBeNull();
      } else {
        expect(row.appliedDate).not.toBeNull();
      }
    }
    // Every unfiltered applied row is exactly the applied-set member.
    const all = await listOpportunitiesAsJobs(prisma, userId, {});
    expect(
      all.data
        .filter((r) => r.applied)
        .map((r) => r.id)
        .sort(),
    ).toEqual(expected);
  });

  it("company-scoped applied filtering still honors the R1B companyId filter", async () => {
    const other = await prisma.company.create({
      data: {
        label: "Beta",
        value: `beta-truth-${Date.now()}`,
        createdBy: userId,
      },
    });
    const inCompany = await createOpportunity({ title: "In scope" });
    const outCompany = await createOpportunity({
      companyId: other.id,
      title: "Out of scope",
    });
    for (const opp of [inCompany, outCompany]) {
      await createAttempt(opp.id, {
        submittedAt: new Date("2026-02-01T00:00:00.000Z"),
        stage: ATTEMPT_STAGE.SUBMITTED,
      });
    }
    const scoped = await listOpportunitiesAsJobs(prisma, userId, {
      companyId,
      appliedOnly: true,
    });
    expect(scoped.total).toBe(1);
    expect(scoped.data[0].id).toBe(inCompany.id);
  });
});

describe("Upcoming stays on the same submission fact", () => {
  it("a submitted attempt suppresses the deadline even after a newer draft", async () => {
    const pending = await createOpportunity({
      title: "Pending",
      deadline: new Date("2026-11-01T00:00:00.000Z"),
    });
    expect(await upcomingDeadlineTitles()).toEqual(["Pending"]);

    const applied = await createOpportunity({
      title: "Applied",
      deadline: new Date("2026-11-01T00:00:00.000Z"),
    });
    await createAttempt(applied.id, {
      submittedAt: new Date("2026-09-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      outcome: ATTEMPT_OUTCOME.REJECTED,
    });
    await createAttempt(applied.id, {
      submittedAt: null,
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
    });
    const titles = await upcomingDeadlineTitles();
    expect(titles).toContain("Pending");
    expect(titles).not.toContain("Applied");
    expect(pending.id).toBeTruthy();
  });

  it("a stage-only applied position suppresses the deadline too", async () => {
    const pending = await createOpportunity({
      title: "Pending",
      deadline: new Date("2026-11-01T00:00:00.000Z"),
    });
    const interview = await createOpportunity({
      title: "Migrated interview",
      deadline: new Date("2026-11-01T00:00:00.000Z"),
    });
    await createAttempt(interview.id, {
      submittedAt: null,
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    const titles = await upcomingDeadlineTitles();
    expect(titles).toEqual(["Pending"]);
    expect(pending.id).toBeTruthy();
    expect(interview.id).toBeTruthy();
  });

  it("archiving the only submitted attempt resurfaces the deadline", async () => {
    const opportunity = await createOpportunity({
      title: "Archived submission",
      deadline: new Date("2026-11-01T00:00:00.000Z"),
    });
    await createAttempt(opportunity.id, {
      submittedAt: new Date("2026-09-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      archived: true,
    });
    expect(await upcomingDeadlineTitles()).toEqual([
      "Archived submission",
    ]);
    const listed = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    expect(listed.total).toBe(0);
  });
});

describe("dashboard statistics use per-opportunity first submission", () => {
  const range = {
    start: new Date("2026-10-01T00:00:00.000Z"),
    end: new Date("2026-10-07T23:59:59.000Z"),
    priorStart: new Date("2026-09-24T00:00:00.000Z"),
  };

  it("counts each position once, in the period of its FIRST submission", async () => {
    const twice = await createOpportunity({ title: "Twice in window" });
    await createAttempt(twice.id, {
      submittedAt: new Date("2026-10-02T00:00:00.000Z"),
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    await createAttempt(twice.id, {
      submittedAt: new Date("2026-10-05T00:00:00.000Z"),
      createdAt: new Date("2026-10-03T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    // First submission in the prior window: a later in-window submission
    // must not move the position into the current window (legacy appliedDate
    // semantics — the date is the first-ever application).
    const earlier = await createOpportunity({ title: "Earlier first" });
    await createAttempt(earlier.id, {
      submittedAt: new Date("2026-09-25T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    await createAttempt(earlier.id, {
      submittedAt: new Date("2026-10-03T00:00:00.000Z"),
      createdAt: new Date("2026-10-02T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    // Archived attempts carry no submission fact.
    const archivedOnly = await createOpportunity({ title: "Archived" });
    await createAttempt(archivedOnly.id, {
      submittedAt: new Date("2026-10-04T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      archived: true,
    });
    // Another user's submissions never leak into my counts.
    const foreign = await createOpportunity({
      userId: otherUserId,
      companyId: otherCompanyId,
      title: "Foreign",
    });
    await createAttempt(foreign.id, {
      userId: otherUserId,
      submittedAt: new Date("2026-10-04T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });

    const counts = await loadDashboardJobCounts(
      prisma,
      userId,
      range,
      FEATURE_ON,
    );
    expect(counts.jobsApplied).toBe(1);
    expect(counts.priorJobs).toBe(1);

    const daily = await loadJobsAppliedDateCounts(
      prisma,
      userId,
      { start: range.start, end: range.end },
      FEATURE_ON,
    );
    expect(
      daily.map((row) => [row.appliedDate.toISOString(), row.count]),
    ).toEqual([["2026-10-02T00:00:00.000Z", 1]]);
  });

  it("recent applications list only truly submitted positions, first-submission order", async () => {
    const oldest = await createOpportunity({
      title: "Old application",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    });
    await createAttempt(oldest.id, {
      submittedAt: new Date("2026-08-10T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    const newest = await createOpportunity({
      title: "Newest application",
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
    });
    await createAttempt(newest.id, {
      submittedAt: new Date("2026-08-20T00:00:00.000Z"),
      createdAt: new Date("2026-08-05T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    // Draft created last still loses to an earlier real submission date.
    await createAttempt(newest.id, {
      submittedAt: null,
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });
    const neverApplied = await createOpportunity({
      title: "Never applied",
      createdAt: new Date("2026-09-15T00:00:00.000Z"),
    });
    await createAttempt(neverApplied.id, { submittedAt: null });
    const draftOnly = await createOpportunity({ title: "No attempts" });
    const archived = await createOpportunity({
      title: "Archived applied",
      archived: true,
    });
    await createAttempt(archived.id, {
      submittedAt: new Date("2026-09-20T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });

    const recent = await loadRecentJobs(prisma, userId, 10, FEATURE_ON);
    expect(recent.map((row: { id: string }) => row.id)).toEqual([
      newest.id,
      oldest.id,
    ]);
    expect(recent[0].appliedDate?.toISOString()).toBe(
      "2026-08-20T00:00:00.000Z",
    );
    expect(draftOnly.id).toBeTruthy();
  });

  it("stage-only applied positions never fabricate a dashboard date bucket", async () => {
    const stageOnly = await createOpportunity({ title: "Migrated offer" });
    await createAttempt(stageOnly.id, {
      submittedAt: null,
      createdAt: new Date("2024-01-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.OFFER,
    });

    // No real submittedAt → nothing may be attributed to any window.
    const counts = await loadDashboardJobCounts(
      prisma,
      userId,
      range,
      FEATURE_ON,
    );
    expect(counts.jobsApplied).toBe(0);
    expect(counts.priorJobs).toBe(0);
    const daily = await loadJobsAppliedDateCounts(
      prisma,
      userId,
      { start: range.start, end: range.end },
      FEATURE_ON,
    );
    expect(daily).toEqual([]);

    // …while the same row is still inside the ever-applied set.
    const applied = await listOpportunitiesAsJobs(prisma, userId, {
      appliedOnly: true,
    });
    expect(applied.total).toBe(1);
    expect(applied.data[0].id).toBe(stageOnly.id);
    expect(applied.data[0].appliedDate).toBeNull();
  });
});

describe("company statistics share the stage-aware applied fact", () => {
  it("counts a stage-only applied position once — real SQL filter", async () => {
    const dated = await createOpportunity({ title: "Dated" });
    await createAttempt(dated.id, {
      submittedAt: new Date("2026-09-01T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
    });
    const stageOnly = await createOpportunity({ title: "Stage only" });
    await createAttempt(stageOnly.id, {
      submittedAt: null,
      stage: ATTEMPT_STAGE.OFFER,
    });
    const draft = await createOpportunity({ title: "Draft" });
    await createAttempt(draft.id, { submittedAt: null });
    const archivedAttempt = await createOpportunity({ title: "Archived" });
    await createAttempt(archivedAttempt.id, {
      submittedAt: new Date("2026-09-02T00:00:00.000Z"),
      stage: ATTEMPT_STAGE.SUBMITTED,
      archived: true,
    });
    const foreign = await createOpportunity({
      userId: otherUserId,
      companyId: otherCompanyId,
      title: "Foreign",
    });
    await createAttempt(foreign.id, {
      userId: otherUserId,
      submittedAt: null,
      stage: ATTEMPT_STAGE.INTERVIEW,
    });

    // The exact fragment the company statistics consume
    // (AB_APPLIED_OPPORTUNITY_WHERE → applicationAttempts some).
    const appliedCount = await prisma.jobOpportunity.count({
      where: {
        companyId,
        userId,
        archivedAt: null,
        applicationAttempts: { some: APPLIED_ATTEMPT_WHERE },
      },
    });
    expect(appliedCount).toBe(2);
  });
});

// @vitest-environment node
//
// CAREER-INSIGHTS metric-contract matrix against a disposable database.
// The read model is exercised directly (injected now + account zone make the
// G1 bucketing deterministic) and the action boundary is exercised for the
// blocked degradation, the open task count, and the payload shape.
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
  FRESH_NATIVE_KEY,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_STATUS,
  writeInstanceMigrationState,
} from "@/lib/career";
import {
  loadCareerInsights,
  loadDueTaskFollowUps,
} from "@/lib/career/careerInsightsReadModel";
import { isJobsReadUnavailableError } from "@/lib/career/jobsReadDispatch";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const ctx = helpers.makeTestDbUrl();
  helpers.pushSchema(ctx.url);
  return ctx;
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});
vi.mock("@/utils/user.utils", () => ({ getCurrentUser: vi.fn() }));

import { getCurrentUser } from "@/utils/user.utils";
import { getCareerInsights } from "@/actions/dashboard/insights";

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

// Fixed clock: 2026-11-04T15:00:00Z is Nov 4 23:00 in Asia/Shanghai, Nov 4 in
// UTC, and Nov 5 04:00 in Pacific/Auckland (NZDT) — three different
// account-zone "today"s, which is what the G1 bucketing tests need.
const NOW = new Date("2026-11-04T15:00:00.000Z");
const SHANGHAI = "Asia/Shanghai";
const AUCKLAND = "Pacific/Auckland";

let prisma: PrismaClient;
let userId: string;
let companyId: string;

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
  userId = await seedAccount(prisma, `insights-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `co-${randomUUID()}`, createdBy: userId },
    })
  ).id;
  (getCurrentUser as any).mockResolvedValue({ id: userId });
});

// --- runtime state helpers -------------------------------------------------

async function migratedAbState() {
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
}

async function freshAbState() {
  // A FRESH_READY instance is trusted only when verified — without
  // verifiedAt the runtime stays blocked ("fresh-unverified").
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.FRESH_READY,
    migrationKey: FRESH_NATIVE_KEY,
    verifiedAt: new Date(),
  });
}

async function blockedState() {
  await prisma.abMigrationState.create({
    data: {
      scopeKey: AB_INSTANCE_SCOPE_KEY,
      migrationKey: AB_MIGRATION_KEY,
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
    },
  });
}

// --- seed helpers ----------------------------------------------------------

async function createOpportunity(input: {
  title: string;
  archivedAt?: Date | null;
  deadline?: Date | null;
}) {
  return prisma.jobOpportunity.create({
    data: {
      userId,
      companyId,
      title: input.title,
      archivedAt: input.archivedAt ?? null,
      deadline: input.deadline ?? null,
    },
  });
}

async function createAttempt(
  jobOpportunityId: string,
  input: {
    submittedAt?: Date | null;
    stage?: string;
    outcome?: string;
    archivedAt?: Date | null;
  } = {},
) {
  return prisma.applicationAttempt.create({
    data: {
      userId,
      jobOpportunityId,
      channelLabel: "TEST",
      submittedAt: input.submittedAt ?? null,
      currentStageCategory: input.stage ?? ATTEMPT_STAGE.SUBMITTED,
      outcome: input.outcome ?? ATTEMPT_OUTCOME.ACTIVE,
      archivedAt: input.archivedAt ?? null,
    },
  });
}

async function createStep(
  applicationAttemptId: string,
  input: {
    category?: string;
    status?: string;
    scheduledAt?: Date | null;
    deadlineAt?: Date | null;
  } = {},
) {
  return prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId,
      category: input.category ?? PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Round",
      status: input.status ?? PROCESS_STEP_STATUS.PENDING,
      sortOrder: 10,
      scheduledAt: input.scheduledAt ?? null,
      deadlineAt: input.deadlineAt ?? null,
    },
  });
}

async function createLegacyJob(input: {
  status: string;
  appliedDate?: Date | null;
  dueDate?: Date | null;
  discoveryStatus?: string | null;
}) {
  const status = await prisma.jobStatus.findFirstOrThrow({
    where: { value: input.status },
  });
  const title = await prisma.jobTitle.create({
    data: {
      label: "Engineer",
      value: `jt-${randomUUID()}`,
      createdBy: userId,
    },
  });
  return prisma.job.create({
    data: {
      userId,
      description: "legacy job",
      jobType: "FT",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      statusId: status.id,
      jobTitleId: title.id,
      companyId,
      applied: input.appliedDate != null,
      appliedDate: input.appliedDate ?? null,
      dueDate: input.dueDate ?? null,
      discoveryStatus: input.discoveryStatus ?? null,
    },
  });
}

async function createTask(input: {
  status?: string;
  dueDate?: Date | null;
  dueOn?: string | null;
  duePrecision?: string | null;
}) {
  return prisma.task.create({
    data: {
      userId,
      title: `task-${randomUUID()}`,
      status: input.status ?? "in-progress",
      dueDate: input.dueDate ?? null,
      dueOn: input.dueOn ?? null,
      duePrecision: input.duePrecision ?? null,
    },
  });
}

const insights = (env: object, timeZone = "UTC", now = NOW) =>
  loadCareerInsights(prisma, userId, {
    env: env as NodeJS.ProcessEnv,
    timeZone,
    now,
  });

// --- A+B family -------------------------------------------------------------

describe("ab family board metrics (M1/M2/M2b/M5, archive scope, G7)", () => {
  beforeEach(migratedAbState);

  it("counts positions for M1/M2/M5 and attempts for M2b, excluding archives", async () => {
    const submitted = new Date("2026-11-01T10:00:00.000Z");

    // A: two live submitted attempts — one position, two M2b applications.
    const a = await createOpportunity({ title: "Two attempts" });
    await createAttempt(a.id, { submittedAt: submitted });
    await createAttempt(a.id, { submittedAt: submitted });

    // B: draft only — an in-progress position, not an application.
    const b = await createOpportunity({ title: "Draft only" });
    await createAttempt(b.id, { stage: ATTEMPT_STAGE.DRAFT });

    // C: offer stage — applied, current offer (M5), still in progress.
    const c = await createOpportunity({ title: "Offer" });
    await createAttempt(c.id, {
      stage: ATTEMPT_STAGE.OFFER,
      outcome: ATTEMPT_OUTCOME.OFFER,
    });

    // D: rejected — applied historically, terminal for M1.
    const d = await createOpportunity({ title: "Rejected" });
    await createAttempt(d.id, {
      submittedAt: submitted,
      stage: ATTEMPT_STAGE.CLOSED,
      outcome: ATTEMPT_OUTCOME.REJECTED,
    });

    // E: stage-only applied history (INTERVIEW, no submittedAt) — counts as
    // applied/attempt but must NOT invent a first-application day.
    const e = await createOpportunity({ title: "Stage only" });
    await createAttempt(e.id, { stage: ATTEMPT_STAGE.INTERVIEW });

    // F: archived parent with a live submitted attempt — out of every active
    // metric, but its historical application day is preserved.
    const f = await createOpportunity({
      title: "Archived",
      archivedAt: new Date("2026-11-02T00:00:00.000Z"),
    });
    await createAttempt(f.id, { submittedAt: submitted });

    const result = await insights(FEATURE_ON);

    expect(result.family).toBe("ab");
    expect(result.migratedOrigin).toBe(true);
    expect(result.board).toMatchObject({
      total: 5, // A–E; the archived F is out of the active scope (D8)
      inProgress: 4, // A applied + B draft + C offer + E interview
      appliedPositions: 4, // A, C, D, E
      appliedAttempts: 5, // A×2 + C + D + E
      offersCurrent: 1,
    });
    // Position-level fact: A contributes one day despite two attempts; the
    // stage-only C/E contribute nothing; the archived F is still history.
    expect(result.firstAppliedByDay).toEqual([
      { date: "2026-11-01", count: 3 }, // A, D, F
    ]);
    expect(result.awaitingReflectionInterviews).toBeNull();
  });

  it("fresh origin is ab without the migrated footnote flag", async () => {
    await prisma.abMigrationState.deleteMany();
    await freshAbState();
    const result = await insights(FEATURE_ON);
    expect(result.family).toBe("ab");
    expect(result.migratedOrigin).toBe(false);
  });
});

describe("ab interview rounds (M4a/M4b, D2)", () => {
  beforeEach(migratedAbState);

  it("counts COMPLETED vs PENDING/IN_PROGRESS rounds and skips the rest", async () => {
    const opp = await createOpportunity({ title: "Interviewing" });
    const attempt = await createAttempt(opp.id, {
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    await createStep(attempt.id, { status: PROCESS_STEP_STATUS.COMPLETED });
    await createStep(attempt.id, { status: PROCESS_STEP_STATUS.COMPLETED });
    await createStep(attempt.id, { status: PROCESS_STEP_STATUS.PENDING });
    await createStep(attempt.id, { status: PROCESS_STEP_STATUS.IN_PROGRESS });
    // CANCELLED and the migrator's EVIDENCED rows are never rounds (D2).
    await createStep(attempt.id, { status: PROCESS_STEP_STATUS.CANCELLED });
    await createStep(attempt.id, { status: "EVIDENCED" });
    // A non-interview COMPLETED step is a different category entirely.
    await createStep(attempt.id, {
      category: PROCESS_STEP_CATEGORY.SCREENING,
      status: PROCESS_STEP_STATUS.COMPLETED,
    });

    // An archived attempt's completed round must not leak in.
    const archivedAttemptOpp = await createOpportunity({ title: "Old" });
    const archivedAttempt = await createAttempt(archivedAttemptOpp.id, {
      archivedAt: new Date(),
    });
    await createStep(archivedAttempt.id, {
      status: PROCESS_STEP_STATUS.COMPLETED,
    });

    // A completed round under an archived parent is out of active scope.
    const archivedOpp = await createOpportunity({
      title: "Archived parent",
      archivedAt: new Date(),
    });
    const liveAttempt = await createAttempt(archivedOpp.id, {});
    await createStep(liveAttempt.id, { status: PROCESS_STEP_STATUS.COMPLETED });

    const result = await insights(FEATURE_ON);
    expect(result.board.interview).toEqual({
      scope: "rounds",
      completedRounds: 2,
      scheduledRounds: 2,
    });
  });
});

describe("account-zone day bucketing (G1/D4)", () => {
  beforeEach(migratedAbState);

  it("buckets first applications into the account zone, not the host zone", async () => {
    // 2026-11-04T16:30:00Z is Nov 5 in Shanghai, Nov 4 in UTC — the two
    // zones must produce different day buckets for the same instant.
    const late = await createOpportunity({ title: "Boundary" });
    await createAttempt(late.id, {
      submittedAt: new Date("2026-11-04T16:30:00.000Z"),
    });
    const sameDay = await createOpportunity({ title: "Same day" });
    await createAttempt(sameDay.id, {
      submittedAt: new Date("2026-11-04T10:00:00.000Z"),
    });

    const shanghai = await insights(FEATURE_ON, SHANGHAI);
    expect(shanghai.firstAppliedByDay).toEqual([
      { date: "2026-11-04", count: 1 },
      { date: "2026-11-05", count: 1 },
    ]);

    const utc = await insights(FEATURE_ON, "UTC");
    expect(utc.firstAppliedByDay).toEqual([
      { date: "2026-11-04", count: 2 },
    ]);
  });

  it("windows trends by the account-zone today", async () => {
    const late = await createOpportunity({ title: "Boundary" });
    await createAttempt(late.id, {
      submittedAt: new Date("2026-11-04T16:30:00.000Z"),
    });

    // Shanghai "today" is Nov 4 — the Nov-5 submission is a future day and
    // cannot appear in the trailing 7-day window.
    const shanghai = await insights(FEATURE_ON, SHANGHAI);
    expect(shanghai.trendWindow7.at(-1)).toEqual({
      date: "2026-11-04",
      count: 0,
    });
    expect(
      shanghai.trendWindow7.reduce((sum, row) => sum + row.count, 0),
    ).toBe(0);

    // Auckland "today" is Nov 5 — the same instant is the window's last day.
    const auckland = await insights(FEATURE_ON, AUCKLAND);
    expect(auckland.trendWindow7.at(-1)).toEqual({
      date: "2026-11-05",
      count: 1,
    });
  });
});

describe("trend windows and the 365-day heatmap (M3)", () => {
  beforeEach(migratedAbState);

  it("zero-fills 7/30-day series and bounds the calendar to 365 days", async () => {
    const seeds: Array<[string, string]> = [
      ["D400", "2025-09-30T10:00:00.000Z"], // beyond the 365-day heatmap bound
      ["D40", "2026-09-25T10:00:00.000Z"], // inside 365d, outside 30d
      ["D3", "2026-11-01T10:00:00.000Z"],
      ["D0", "2026-11-04T10:00:00.000Z"],
    ];
    for (const [title, submittedAt] of seeds) {
      const opp = await createOpportunity({ title });
      await createAttempt(opp.id, { submittedAt: new Date(submittedAt) });
    }

    const result = await insights(FEATURE_ON, "UTC");

    expect(result.firstAppliedByDay).toEqual([
      { date: "2025-09-30", count: 1 },
      { date: "2026-09-25", count: 1 },
      { date: "2026-11-01", count: 1 },
      { date: "2026-11-04", count: 1 },
    ]);

    expect(result.trendWindow7).toHaveLength(7);
    expect(result.trendWindow7[0]).toEqual({ date: "2026-10-29", count: 0 });
    expect(result.trendWindow7.at(-1)).toEqual({
      date: "2026-11-04",
      count: 1,
    });
    expect(
      result.trendWindow7.find((row) => row.date === "2026-11-01")?.count,
    ).toBe(1);

    expect(result.trendWindow30).toHaveLength(30);
    expect(result.trendWindow30[0].date).toBe("2026-10-06");
    expect(
      result.trendWindow30.reduce((sum, row) => sum + row.count, 0),
    ).toBe(2); // D3 + D0 — D40 is outside the window

    expect(result.calendarDays365).toEqual([
      { date: "2026-09-25", count: 1 },
      { date: "2026-11-01", count: 1 },
      { date: "2026-11-04", count: 1 },
    ]);
  });
});

describe("follow-up counts (M6, D7)", () => {
  beforeEach(migratedAbState);

  it("sums untruncated jobs events and due tasks with one overdue tally", async () => {
    // Jobs half: an overdue opportunity deadline plus a step scheduled in
    // the next-7 window. Terminal/cancelled steps stay out.
    await createOpportunity({
      title: "Deadline passed",
      deadline: new Date("2026-11-04T14:00:00.000Z"), // before NOW → overdue
    });
    const stepOpp = await createOpportunity({ title: "Step soon" });
    const attempt = await createAttempt(stepOpp.id, {
      stage: ATTEMPT_STAGE.INTERVIEW,
    });
    await createStep(attempt.id, {
      scheduledAt: new Date("2026-11-06T15:00:00.000Z"),
    });
    await createStep(attempt.id, {
      status: PROCESS_STEP_STATUS.CANCELLED,
      scheduledAt: new Date("2026-11-05T15:00:00.000Z"),
    });
    await createStep(attempt.id, {
      status: PROCESS_STEP_STATUS.COMPLETED,
      scheduledAt: new Date("2026-11-03T15:00:00.000Z"),
    });

    // Task half: overdue dateOnly, in-window instant, out-of-window, and a
    // completed task that must be ignored.
    await createTask({ dueOn: "2026-11-03", duePrecision: "dateOnly" });
    await createTask({ dueDate: new Date("2026-11-05T17:00:00.000Z") });
    await createTask({ dueDate: new Date("2026-12-01T00:00:00.000Z") });
    await createTask({
      status: "complete",
      dueDate: new Date("2026-11-05T00:00:00.000Z"),
    });

    const result = await insights(FEATURE_ON, SHANGHAI);
    // 2 jobs events (overdue deadline + scheduled step) + 2 due tasks.
    expect(result.followUps).toEqual({ total: 4, overdueCount: 2 });
  });
});

describe("empty account", () => {
  beforeEach(migratedAbState);

  it("returns honest zeros — real emptiness, never a faked breakdown", async () => {
    const result = await insights(FEATURE_ON);
    expect(result.board).toMatchObject({
      total: 0,
      inProgress: 0,
      appliedPositions: 0,
      appliedAttempts: 0,
      offersCurrent: 0,
    });
    expect(result.board.interview).toEqual({
      scope: "rounds",
      completedRounds: 0,
      scheduledRounds: 0,
    });
    expect(result.firstAppliedByDay).toEqual([]);
    expect(result.calendarDays365).toEqual([]);
    expect(result.trendWindow7).toHaveLength(7);
    expect(result.trendWindow7.every((row) => row.count === 0)).toBe(true);
    expect(result.statusDistribution).toEqual([]);
    expect(result.followUps).toEqual({ total: 0, overdueCount: 0 });
  });
});

// --- legacy family ---------------------------------------------------------

describe("legacy family degrade (D1/D2)", () => {
  it("serves position-level metrics with null M2b and position-unit M4", async () => {
    await createLegacyJob({
      status: "applied",
      appliedDate: new Date("2026-11-04T10:00:00.000Z"),
    });
    await createLegacyJob({ status: "interview" });
    await createLegacyJob({ status: "interview" });
    await createLegacyJob({ status: "offer" });
    // Terminal rows count toward totals but never in-progress.
    await createLegacyJob({ status: "rejected" });
    await createLegacyJob({ status: "archived" });
    // A dismissed discovery is hidden from every jobs surface.
    await createLegacyJob({
      status: "applied",
      appliedDate: new Date("2026-11-04T12:00:00.000Z"),
      discoveryStatus: "dismissed",
    });

    const result = await insights(LEGACY_ENV, "UTC");

    expect(result.family).toBe("legacy");
    expect(result.migratedOrigin).toBe(false);
    expect(result.board).toMatchObject({
      total: 6, // only the dismissed discovery is excluded; "archived" is
      // a legacy status value and still a personal record
      inProgress: 4, // applied + interview×2 + offer; rejected/archived out
      appliedPositions: 1, // dismissed applied job excluded
      appliedAttempts: null, // D1: legacy has no attempt unit — null, not 0
      offersCurrent: 1,
    });
    expect(result.board.interview).toEqual({
      scope: "positions",
      interviewingPositions: 2,
    });
    // Legacy appliedDate rows feed the same account-zone day buckets.
    expect(result.firstAppliedByDay).toEqual([
      { date: "2026-11-04", count: 2 }, // dismissed jobs stay historical fact
    ]);
  });

  it("counts legacy deadline follow-ups untruncated with an overdue tally", async () => {
    await createLegacyJob({
      status: "applied",
      dueDate: new Date("2026-11-04T14:00:00.000Z"), // before NOW → overdue
    });
    await createLegacyJob({
      status: "interview",
      dueDate: new Date("2026-11-06T10:00:00.000Z"), // inside next-7
    });
    await createLegacyJob({
      status: "rejected",
      dueDate: new Date("2026-11-05T10:00:00.000Z"), // terminal → excluded
    });
    await createLegacyJob({
      status: "applied",
      dueDate: new Date("2026-11-05T10:00:00.000Z"),
      discoveryStatus: "dismissed", // dismissed → excluded
    });
    await createTask({ dueDate: new Date("2026-11-05T12:00:00.000Z") });

    const result = await insights(LEGACY_ENV, "UTC");
    expect(result.followUps).toEqual({ total: 3, overdueCount: 1 });
  });
});

// --- blocked family ---------------------------------------------------------

describe("blocked family degradation", () => {
  it("rejects the composite read and still serves due-task counts", async () => {
    await blockedState();
    await createTask({ dueDate: new Date("2026-11-05T00:00:00.000Z") });

    await expect(insights(LEGACY_ENV)).rejects.toSatisfy(
      isJobsReadUnavailableError,
    );
    await expect(insights(FEATURE_ON)).rejects.toSatisfy(
      isJobsReadUnavailableError,
    );

    const tasks = await loadDueTaskFollowUps(prisma, userId, {
      timeZone: "UTC",
      now: NOW,
    });
    expect(tasks).toEqual({ total: 1, overdueCount: 0 });
  });
});

// --- action boundary --------------------------------------------------------

describe("getCareerInsights action", () => {
  it("degrades to a typed blocked payload with tasks-only M6 and real M7", async () => {
    await blockedState();
    // The action reads the wall clock — a relative due day keeps the window
    // membership deterministic.
    await createTask({ dueDate: new Date(Date.now() + 86_400_000) });
    await createTask({ status: "complete" });

    const payload = await getCareerInsights();
    expect(payload).toMatchObject({
      blocked: true,
      code: "JOBS_READ_UNAVAILABLE",
      openTasks: 1,
      followUps: { total: 1, overdueCount: 0, tasksOnly: true },
    });
    expect("data" in payload).toBe(false);
  });

  it("serves the full payload on the legacy family", async () => {
    await createLegacyJob({
      status: "applied",
      appliedDate: new Date(),
    });
    await createTask({});

    const payload = await getCareerInsights("en");
    expect(payload.blocked).toBe(false);
    if (payload.blocked) return;
    expect(payload.data.family).toBe("legacy");
    expect(payload.data.board.appliedAttempts).toBeNull();
    expect(payload.data.board.interview.scope).toBe("positions");
    expect(payload.data.trend7.days).toHaveLength(7);
    expect(
      payload.data.trend7.days.reduce((sum, row) => sum + row.value, 0),
    ).toBe(1);
    expect(payload.data.trend7.total).toBe(1);
    const year = new Date().getFullYear().toString();
    expect(payload.data.calendarByYear[year]?.length).toBeGreaterThan(0);
    expect(payload.followUps.tasksOnly).toBe(false);
    expect(payload.openTasks).toBe(1);
  });

  it("keeps non-blocked read failures loud instead of disguising them", async () => {
    await migratedAbState();
    vi.stubEnv(AB_RUNTIME_FEATURE_ENV, "true");
    vi.stubEnv(AB_ROLLOUT_SCOPE_ENV, "full");
    const spy = vi
      .spyOn(prisma.jobOpportunity, "findMany")
      .mockRejectedValue(new Error("sqlite exploded"));
    await expect(getCareerInsights()).rejects.toThrow("sqlite exploded");
    spy.mockRestore();
  });
});

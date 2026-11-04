import type { PrismaClient } from "@prisma/client";
import {
  addDaysToDateOnly,
  businessTimeFromColumns,
  compareDateOnly,
  dateOnlyUtcWindow,
  instantToWallTime,
  isDeadlineOverdue,
  todayDateOnly,
  toInstantIso,
  type DateOnlyString,
} from "@/lib/datetime";
import { CareerRuntimeError } from "./errors";
import {
  CAREER_RUNTIME_MODE,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_STATUS,
} from "./identities";
import { APPLIED_ATTEMPT_WHERE } from "./applicationFact";
import { isAbJobReadMode } from "./jobsReadCapabilities";
import {
  JOBS_READ_UNAVAILABLE_CODE,
  loadJobsBoardTotals,
  loadJobStatusDistribution,
  type JobStatusCount,
  type JobsReadFamily,
} from "./jobsReadDispatch";
import { CAREER_DATA_ORIGIN, resolveCareerRuntimeMode } from "./runtimeMode";
import {
  bucketUpcomingApplicationEvents,
  listAwaitingReflectionInterviews,
  listUpcomingApplicationEvents,
  UPCOMING_BUCKET_ID,
} from "./upcomingReadModel";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "./userMessages";

// CAREER-INSIGHTS read model (frozen contract P2_CAREER_INSIGHTS_CONTRACT_PROPOSAL).
// Owns the metric semantics for the /dashboard/analytics board and the
// overview O5 digest slot: counting units, family-specific sources, archive
// scope, account-time-zone windows and per-day bucketing (G1 fix, D4), the
// M4a/M4b interview-round split (D2), M2b attempt-level applications (D1),
// the untruncated M6 follow-up counts (D7) and the migrated-origin footnote
// flag (G7). Blocked jobs families reject with JOBS_READ_UNAVAILABLE — the
// action boundary wraps that into a typed degraded result and still serves
// the jobs-independent parts (M7, the task half of M6).

export type CareerInsightsOptions = {
  /** Account zone, resolved once at the action boundary via getUserTimeZone. */
  timeZone: string;
  /** Injectable clock for deterministic tests. */
  now?: Date;
  env?: NodeJS.ProcessEnv;
};

export type InsightsFamily = Exclude<JobsReadFamily, "blocked">;

export type ApplicationDayCount = {
  /** Account-zone calendar day, "YYYY-MM-DD". */
  date: DateOnlyString;
  count: number;
};

export type FollowUpCounts = {
  total: number;
  overdueCount: number;
};

export type InsightInterviewMetric =
  | {
      // A+B: interview PROCESS STEP counts — a round unit, not a position unit.
      scope: "rounds";
      /** M4a: INTERVIEW steps at status COMPLETED. EVIDENCED migration rows
       *  are not COMPLETED and therefore never counted (D2). */
      completedRounds: number;
      /** M4b: INTERVIEW steps at PENDING/IN_PROGRESS — scheduled or in flight. */
      scheduledRounds: number;
    }
  | {
      // Legacy has no round entity: degrade to positions currently at the
      // "interview" status value, labelled as a position unit in the UI (D2).
      scope: "positions";
      interviewingPositions: number;
    };

export type InsightBoard = {
  /** Unarchived positions (ab) / non-dismissed Job rows (legacy). */
  total: number;
  /** M1: positions whose derived/current status is not terminal. */
  inProgress: number;
  /** M2: positions ever applied, active scope (excludes archived). */
  appliedPositions: number;
  /** M2b: attempt-level application count — A+B only, null for legacy. */
  appliedAttempts: number | null;
  /** M4: interview rounds (ab) or degraded interviewing positions (legacy). */
  interview: InsightInterviewMetric;
  /** M5: positions currently in offer / offer-accepted (snapshot, not cumulative). */
  offersCurrent: number;
};

export type CareerInsightsRead = {
  family: InsightsFamily;
  /** G7 footnote trigger: migrated accounts carry only one synthetic
   *  EVIDENCED step, so M4a systematically under-reads. */
  migratedOrigin: boolean;
  board: InsightBoard;
  /** M8: current snapshot distribution (ab: derived uiStatus; legacy: Status.value). */
  statusDistribution: JobStatusCount[];
  /** All-time first-application day counts in account-zone days, ascending.
   *  Position-level unit: each position contributes its MIN(submittedAt)
   *  (ab) or appliedDate (legacy) once — submissions under an archived
   *  parent still count here (frozen archive contract D2 historical fact). */
  firstAppliedByDay: ApplicationDayCount[];
  /** M3 windows as complete day series (zero-filled) in account-zone days. */
  trendWindow7: ApplicationDayCount[];
  trendWindow30: ApplicationDayCount[];
  /** Sparse day counts inside the last 365 account-zone days for the heatmap. */
  calendarDays365: ApplicationDayCount[];
  /** M6: overdue + today + next-7-days items — jobs events plus due tasks. */
  followUps: FollowUpCounts;
  /** M9 awaiting-reflection count: integration point reserved (D9). Not
   *  populated until the window-2 §7.3 listAwaitingReflectionInterviews read
   *  model lands — the UI must keep this metric absent (no placeholder)
   *  while null. */
  awaitingReflectionInterviews: number | null;
};

// Mirrors jobsReadDispatch.ts LEGACY_TERMINAL_STATUS_VALUES / NOT_DISMISSED_WHERE
// — module-private there and intentionally not re-declared for export. Keep in
// sync with the dispatch owner when the legacy read contract changes.
const LEGACY_TERMINAL_STATUS_VALUES = [
  "rejected",
  "expired",
  "archived",
  "offer-accepted",
  "offer-declined",
] as const;

const NOT_DISMISSED_WHERE = {
  OR: [{ discoveryStatus: null }, { discoveryStatus: { not: "dismissed" } }],
};

// Task statuses excluded from the "open" count — same predicate as
// getOverviewStats (overview.ts), which this metric mirrors.
const OPEN_TASK_STATUSES = ["complete", "cancelled"] as const;

function rejectBlocked(): never {
  throw new CareerRuntimeError(
    JOBS_READ_UNAVAILABLE_CODE,
    CAREER_JOBS_UNAVAILABLE_MESSAGE,
  );
}

// Family + origin from one runtime resolution — the family mapping mirrors
// resolveJobsReadFamily exactly (blocked mode, A+B read capability, then the
// fresh-origin guard) so origin stays available for the migrated footnote
// without resolving the runtime twice.
async function resolveInsightsFamily(
  db: PrismaClient | object,
  env: NodeJS.ProcessEnv,
): Promise<{ family: JobsReadFamily; migratedOrigin: boolean }> {
  const runtime = await resolveCareerRuntimeMode(db, { env });
  const migratedOrigin = runtime.origin === CAREER_DATA_ORIGIN.migrated;
  if (runtime.mode === CAREER_RUNTIME_MODE.BLOCKED) {
    return { family: "blocked", migratedOrigin };
  }
  if (isAbJobReadMode(runtime.mode, runtime.rolloutScope)) {
    return { family: "ab", migratedOrigin };
  }
  if (runtime.origin === CAREER_DATA_ORIGIN.fresh) {
    return { family: "blocked", migratedOrigin };
  }
  return { family: "legacy", migratedOrigin };
}

/**
 * M7-adjacent half of M6: unfinished tasks due within the next 7 account-zone
 * days including overdue — the untruncated counterpart of the reminder list's
 * task branch. Family-independent, so a blocked jobs family can still serve
 * this part (D7 tasksOnly scope).
 */
export async function loadDueTaskFollowUps(
  db: PrismaClient,
  userId: string,
  options: Pick<CareerInsightsOptions, "timeZone" | "now">,
): Promise<FollowUpCounts> {
  const now = options.now ?? new Date();
  const timeZone = options.timeZone;
  const today = todayDateOnly(timeZone, now);
  const next7EndOn = addDaysToDateOnly(today, 7);
  const next7End = new Date(
    dateOnlyUtcWindow(next7EndOn, timeZone).endIsoExclusive,
  );

  const dueTasks = await db.task.findMany({
    where: {
      userId,
      status: { notIn: [...OPEN_TASK_STATUSES] },
      OR: [
        { dueDate: { not: null, lte: next7End } },
        { dueOn: { not: null, lte: next7EndOn } },
      ],
    },
    select: {
      id: true,
      dueDate: true,
      dueOn: true,
      duePrecision: true,
    },
  });

  let total = 0;
  let overdueCount = 0;
  for (const task of dueTasks) {
    const value = businessTimeFromColumns({
      dateOnly: task.dueOn,
      instant: task.dueDate,
      precision: task.duePrecision,
    });
    if (value === null) continue;
    total += 1;
    if (isDeadlineOverdue(value, now, timeZone)) overdueCount += 1;
  }
  return { total, overdueCount };
}

// Position-level first-application facts bucketed into account-zone calendar
// days. Same predicates as loadJobsAppliedDateCounts (D4): ab groups live
// attempts' MIN(submittedAt) per opportunity — the parent-opportunity userId
// guard without an archive filter, so history under archived positions is
// preserved; legacy reads Job.appliedDate rows directly. Bucketing uses the
// account zone, never the host zone (G1).
async function loadFirstAppliedDayCounts(
  db: PrismaClient,
  userId: string,
  family: InsightsFamily,
  timeZone: string,
): Promise<ApplicationDayCount[]> {
  const firstAts: Date[] = [];
  if (family === "ab") {
    const rows = await db.applicationAttempt.groupBy({
      by: "jobOpportunityId",
      where: {
        userId,
        archivedAt: null,
        submittedAt: { not: null },
        jobOpportunity: { userId },
      },
      _min: { submittedAt: true },
    });
    for (const row of rows) {
      if (row._min.submittedAt) firstAts.push(row._min.submittedAt);
    }
  } else {
    const rows = await db.job.findMany({
      where: { userId, applied: true, appliedDate: { not: null } },
      select: { appliedDate: true },
    });
    for (const row of rows) {
      if (row.appliedDate) firstAts.push(row.appliedDate);
    }
  }

  const counts = new Map<DateOnlyString, number>();
  for (const at of firstAts) {
    const day = instantToWallTime(toInstantIso(at), timeZone).date;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => compareDateOnly(a.date, b.date));
}

/**
 * M3 window member count for the overview O5 card: positions whose
 * first-application day falls in the last `days` account-zone days
 * including today. Same facts and account-zone bucketing as the analytics
 * trend (G1/D4) — callers must not substitute the host-zone
 * getLocalDayRange window.
 */
export async function countFirstAppliedInWindowDays(
  db: PrismaClient,
  userId: string,
  family: InsightsFamily,
  timeZone: string,
  days: number,
  now?: Date,
): Promise<number> {
  const today = todayDateOnly(timeZone, now ?? new Date());
  const start = addDaysToDateOnly(today, -(days - 1));
  const byDay = await loadFirstAppliedDayCounts(db, userId, family, timeZone);
  let total = 0;
  for (const row of byDay) {
    if (compareDateOnly(row.date, start) >= 0) total += row.count;
  }
  return total;
}

function windowDaySeries(
  byDay: ApplicationDayCount[],
  today: DateOnlyString,
  days: number,
): ApplicationDayCount[] {
  const start = addDaysToDateOnly(today, -(days - 1));
  const byDate = new Map(byDay.map((row) => [row.date, row.count]));
  const series: ApplicationDayCount[] = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDaysToDateOnly(start, i);
    series.push({ date, count: byDate.get(date) ?? 0 });
  }
  return series;
}

async function interviewStepCount(
  db: PrismaClient,
  userId: string,
  statuses: readonly string[],
): Promise<number> {
  return db.applicationProcessStep.count({
    where: {
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      status: { in: [...statuses] },
      applicationAttempt: {
        userId,
        archivedAt: null,
        jobOpportunity: { archivedAt: null },
      },
    },
  });
}

/**
 * The full insights read for one account. Throws JOBS_READ_UNAVAILABLE for a
 * blocked jobs family — callers needing the task-only degradation catch via
 * jobsReadOrBlocked and fall back to loadDueTaskFollowUps.
 */
export async function loadCareerInsights(
  db: PrismaClient,
  userId: string,
  options: CareerInsightsOptions,
): Promise<CareerInsightsRead> {
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();
  const timeZone = options.timeZone;

  const { family, migratedOrigin } = await resolveInsightsFamily(db, env);
  if (family === "blocked") rejectBlocked();

  const [totals, statusDistribution, firstAppliedByDay, taskFollowUps] =
    await Promise.all([
      // M1 inProgress / M2 appliedPositions / M5 offersCurrent reuse the board
      // totals dispatch (its `interviews` value is not used — M4 is redefined
      // below per D2; legacy keeps it as the degraded position unit).
      loadJobsBoardTotals(db, userId, env),
      loadJobStatusDistribution(db, userId, env),
      loadFirstAppliedDayCounts(db, userId, family, timeZone),
      loadDueTaskFollowUps(db, userId, { timeZone, now }),
    ]);

  let interview: InsightInterviewMetric;
  let appliedAttempts: number | null = null;
  let jobsFollowUps: FollowUpCounts = { total: 0, overdueCount: 0 };

  if (family === "ab") {
    const [attemptCount, completedRounds, scheduledRounds, upcoming] =
      await Promise.all([
        // M2b (D1): attempt-level applications on live attempts of live
        // opportunities — the APPLIED_ATTEMPT_WHERE fact, position-archive
        // excluded like the active-scope M2.
        db.applicationAttempt.count({
          where: {
            userId,
            ...APPLIED_ATTEMPT_WHERE,
            jobOpportunity: { userId, archivedAt: null },
          },
        }),
        // M4a: only COMPLETED interview steps — EVIDENCED migration rows and
        // CANCELLED/PENDING/IN_PROGRESS are excluded by equality.
        interviewStepCount(db, userId, [PROCESS_STEP_STATUS.COMPLETED]),
        interviewStepCount(db, userId, [
          PROCESS_STEP_STATUS.PENDING,
          PROCESS_STEP_STATUS.IN_PROGRESS,
        ]),
        listUpcomingApplicationEvents(db, userId, timeZone),
      ]);
    appliedAttempts = attemptCount;
    interview = {
      scope: "rounds",
      completedRounds,
      scheduledRounds,
    };
    const buckets = bucketUpcomingApplicationEvents(
      upcoming.events,
      now,
      timeZone,
    );
    for (const bucket of buckets) {
      if (bucket.id === UPCOMING_BUCKET_ID.later) continue;
      jobsFollowUps.total += bucket.events.length;
      if (bucket.id === UPCOMING_BUCKET_ID.overdue) {
        jobsFollowUps.overdueCount += bucket.events.length;
      }
    }
  } else {
    // Legacy has no round entity — the "positions at interview status" count
    // the board totals already compute is the degraded M4 (D2).
    interview = {
      scope: "positions",
      interviewingPositions: totals.interviews,
    };
    const today = todayDateOnly(timeZone, now);
    const next7End = new Date(
      dateOnlyUtcWindow(addDaysToDateOnly(today, 7), timeZone).endIsoExclusive,
    );
    const legacyDeadlineWhere = {
      userId,
      Status: { value: { notIn: [...LEGACY_TERMINAL_STATUS_VALUES] } },
      ...NOT_DISMISSED_WHERE,
    };
    const [deadlineTotal, deadlineOverdue] = await Promise.all([
      // Untruncated counterpart of loadUpcomingJobDeadlines (which caps at 5):
      // same userId/non-terminal/not-dismissed filters, an upper bound only —
      // no lower bound so overdue deadlines stay in the count (D7).
      db.job.count({
        where: { ...legacyDeadlineWhere, dueDate: { lte: next7End } },
      }),
      db.job.count({
        where: { ...legacyDeadlineWhere, dueDate: { lt: now } },
      }),
    ]);
    jobsFollowUps = { total: deadlineTotal, overdueCount: deadlineOverdue };
  }

  const today = todayDateOnly(timeZone, now);
  const yearAgoStart = addDaysToDateOnly(today, -364);

  // M9 (frozen §2.10/D9): the ab read surface — READY_DISABLED included —
  // consumes the debrief domain's §7.3 totalCount verbatim. A domain-read
  // failure keeps the metric absent (null), never a fabricated zero.
  const awaitingReflectionInterviews =
    family === "ab"
      ? await listAwaitingReflectionInterviews(db, userId)
          .then((result) => result.totalCount)
          .catch(() => null)
      : null;

  return {
    family,
    migratedOrigin,
    board: {
      total: totals.total,
      inProgress: totals.inProgress,
      appliedPositions: totals.applied,
      appliedAttempts,
      interview,
      offersCurrent: totals.offers,
    },
    statusDistribution,
    firstAppliedByDay,
    trendWindow7: windowDaySeries(firstAppliedByDay, today, 7),
    trendWindow30: windowDaySeries(firstAppliedByDay, today, 30),
    calendarDays365: firstAppliedByDay.filter(
      (row) => compareDateOnly(row.date, yearAgoStart) >= 0,
    ),
    followUps: {
      total: jobsFollowUps.total + taskFollowUps.total,
      overdueCount: jobsFollowUps.overdueCount + taskFollowUps.overdueCount,
    },
    awaitingReflectionInterviews,
  };
}

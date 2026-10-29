import type { PrismaClient } from "@prisma/client";
import { format } from "date-fns";
import { APP_CONSTANTS } from "@/lib/constants";
import { JOB_TYPES } from "@/models/job.model";
import { CAREER_RUNTIME_MODE } from "./identities";
import { CareerRuntimeError } from "./errors";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "./userMessages";
import {
  getOpportunityAsJob,
  listOpportunitiesAsJobs,
} from "./jobOpportunityAdapter";
import { isAbJobReadMode } from "./jobsReadCapabilities";
import { CAREER_DATA_ORIGIN, resolveCareerRuntimeMode } from "./runtimeMode";
import { deriveUiStatus, isOfferUiStatus, pickLatestAttempt } from "./uiStatus";
import { isAppliedAttempt, APPLIED_ATTEMPT_WHERE } from "./applicationFact";
import { OPPORTUNITY_STATUS, PROCESS_STEP_CATEGORY } from "./identities";

export type JobsReadFamily = "ab" | "legacy" | "blocked";

export type JobsListFilters = {
  skip?: number;
  take?: number;
  filter?: string;
  search?: string;
  companyValue?: string;
  appliedOnly?: boolean;
  titleValue?: string;
  locationValue?: string;
  sourceValue?: string;
};

function hideUnanalyzedScore<
  T extends { matchScore: number | null; matchData: string | null },
>({ matchData, ...job }: T) {
  let analyzed = true;
  try {
    analyzed = JSON.parse(matchData ?? "{}").analyzed !== false;
  } catch {
    analyzed = true;
  }
  return analyzed ? job : { ...job, matchScore: null };
}

export type DashboardJobCounts = {
  jobsApplied: number;
  priorJobs: number;
  jobsInterview?: number;
  jobsOffer?: number;
};

// All-time pipeline totals for the analytics board plus the overview's
// in-progress count. Same position-level dedup rules as the windowed
// reads: legacy counts Job rows, A+B counts JobOpportunity rows.
export type JobsBoardTotals = {
  total: number;
  applied: number;
  interviews: number;
  offers: number;
  inProgress: number;
};

export type JobStatusCount = { status: string; count: number };

// Legacy statuses where the position is concluded: not part of
// "in progress" and not where a deadline reminder should fire.
const LEGACY_TERMINAL_STATUS_VALUES = [
  "rejected",
  "expired",
  "archived",
  "offer-accepted",
  "offer-declined",
] as const;

// A+B derived uiStatus values where the position is concluded.
const AB_TERMINAL_UI_STATUSES = new Set([
  "archived",
  "expired",
  "rejected",
  "offer-accepted",
  "offer-declined",
  "transferred",
]);

// Dismissed automation discoveries are hidden from every jobs surface;
// the board counts match that contract.
const NOT_DISMISSED_WHERE = {
  OR: [{ discoveryStatus: null }, { discoveryStatus: { not: "dismissed" } }],
};

const OPPORTUNITY_DERIVE_SELECT = {
  id: true,
  status: true,
  archivedAt: true,
  applicationAttempts: {
    where: { archivedAt: null },
    select: {
      id: true,
      currentStageCategory: true,
      outcome: true,
      submittedAt: true,
      createdAt: true,
    },
  },
} as const;

const JOB_LIST_SELECT = {
  id: true,
  JobSource: true,
  JobTitle: true,
  jobType: true,
  workplaceType: true,
  Company: true,
  Status: true,
  Location: true,
  dueDate: true,
  appliedDate: true,
  description: false,
  Resume: true,
  CoverLetter: true,
  matchScore: true,
  matchData: true,
  discoveryStatus: true,
  _count: { select: { Notes: true } },
};

const JOB_EXPORT_SELECT = {
  id: true,
  createdAt: true,
  JobSource: true,
  JobTitle: true,
  jobType: true,
  workplaceType: true,
  Company: true,
  Status: true,
  Location: true,
  dueDate: true,
  applied: true,
  appliedDate: true,
  salaryRange: true,
};

const JOB_DETAILS_INCLUDE = {
  JobSource: true,
  JobTitle: true,
  Company: true,
  Status: true,
  Location: true,
  Resume: {
    include: {
      File: true,
    },
  },
  CoverLetter: true,
  tags: true,
  contactLinks: {
    include: {
      Role: true,
      Contact: {
        select: {
          id: true,
          name: true,
          title: true,
          email: true,
          phone: true,
          linkedinUrl: true,
          Company: { select: { id: true, label: true } },
        },
      },
    },
    orderBy: { createdAt: "asc" as const },
  },
};

const JOB_RECENT_INCLUDE = {
  JobSource: true,
  JobTitle: true,
  Company: true,
  Status: true,
  Location: true,
};

export async function resolveJobsReadFamily(
  db: PrismaClient | object,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ family: JobsReadFamily; mode: string; reason: string }> {
  const runtime = await resolveCareerRuntimeMode(db, { env });
  if (runtime.mode === CAREER_RUNTIME_MODE.BLOCKED) {
    return { family: "blocked", mode: runtime.mode, reason: runtime.reason };
  }
  if (isAbJobReadMode(runtime.mode, runtime.rolloutScope)) {
    return { family: "ab", mode: runtime.mode, reason: runtime.reason };
  }
  if (runtime.origin === CAREER_DATA_ORIGIN.fresh) {
    return {
      family: "blocked",
      mode: runtime.mode,
      reason: "fresh-origin-jobs-unavailable",
    };
  }
  return { family: "legacy", mode: runtime.mode, reason: runtime.reason };
}

export const JOBS_READ_UNAVAILABLE_CODE = "JOBS_READ_UNAVAILABLE";

// A blocked family is a declared runtime state, not a surprise failure:
// surfaces that can degrade gracefully (dashboard) match this predicate
// instead of sniffing message text.
export function isJobsReadUnavailableError(
  error: unknown,
): error is CareerRuntimeError {
  return (
    error instanceof CareerRuntimeError &&
    error.code === JOBS_READ_UNAVAILABLE_CODE
  );
}

function rejectBlockedJobs(family: JobsReadFamily, _reason: string): void {
  if (family !== "blocked") return;
  throw new CareerRuntimeError(
    JOBS_READ_UNAVAILABLE_CODE,
    CAREER_JOBS_UNAVAILABLE_MESSAGE,
  );
}

function buildLegacyJobsWhere(userId: string, filters: JobsListFilters) {
  const {
    filter,
    search,
    companyValue,
    appliedOnly,
    titleValue,
    locationValue,
    sourceValue,
  } = filters;

  const filterBy = filter
    ? filter === Object.keys(JOB_TYPES)[1]
      ? {
          jobType: filter,
        }
      : filter === "accepted" || filter === "dismissed"
        ? {
            discoveryStatus: filter,
          }
        : {
            Status: {
              value: filter,
            },
          }
    : {};

  const whereClause: Record<string, unknown> = {
    userId,
    ...filterBy,
  };

  if (filter !== "dismissed") {
    whereClause.AND = [
      {
        OR: [
          { discoveryStatus: null },
          { discoveryStatus: { not: "dismissed" } },
        ],
      },
    ];
  }

  if (companyValue) {
    whereClause.Company = { value: companyValue };
  }
  if (titleValue) {
    whereClause.JobTitle = { value: titleValue };
  }
  if (locationValue) {
    whereClause.Location = { value: locationValue };
  }
  if (sourceValue) {
    whereClause.JobSource = { value: sourceValue };
  }
  if (appliedOnly) {
    whereClause.applied = true;
  }

  if (search) {
    const searchConditions: Record<string, unknown>[] = [];
    if (!titleValue) {
      searchConditions.push({ JobTitle: { label: { contains: search } } });
    }
    if (!companyValue) {
      searchConditions.push({ Company: { label: { contains: search } } });
    }
    if (!locationValue) {
      searchConditions.push({ Location: { label: { contains: search } } });
    }
    if (!sourceValue) {
      searchConditions.push({ JobSource: { label: { contains: search } } });
    }
    searchConditions.push({ description: { contains: search } });
    whereClause.OR = searchConditions;
  }

  return whereClause;
}

export async function listJobs(
  db: PrismaClient,
  userId: string,
  options: JobsListFilters = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const { family } = await resolveJobsReadFamily(db, env);
  if (family === "blocked") {
    return {
      blocked: true as const,
      message: CAREER_JOBS_UNAVAILABLE_MESSAGE,
    };
  }
  // The "applied" list filter means *ever applied* (the applied flag), not the
  // applied pipeline stage — an interview/offer/rejected job still belongs in
  // it. Normalizing here keeps legacy and AB reads consistent.
  const appliedSelected = options.filter === "applied";
  const normalized = appliedSelected
    ? { ...options, filter: undefined, appliedOnly: true }
    : options;
  if (family === "ab") {
    const { data, total } = await listOpportunitiesAsJobs(db, userId, {
      skip: normalized.skip,
      take: normalized.take,
      search: normalized.search,
      appliedOnly: normalized.appliedOnly,
      filter: normalized.filter,
      companyValue: normalized.companyValue,
      titleValue: normalized.titleValue,
      locationValue: normalized.locationValue,
      sourceValue: normalized.sourceValue,
    });
    return { blocked: false as const, data, total };
  }

  const whereClause = buildLegacyJobsWhere(userId, normalized);
  const [data, total] = await Promise.all([
    db.job.findMany({
      where: whereClause,
      skip: options.skip,
      take: options.take,
      select: JOB_LIST_SELECT,
      orderBy: {
        createdAt: "desc",
      },
    }),
    db.job.count({
      where: whereClause,
    }),
  ]);
  return {
    blocked: false as const,
    data: data.map(hideUnanalyzedScore),
    total,
  };
}

export async function getJob(
  db: PrismaClient,
  userId: string,
  jobId: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { family } = await resolveJobsReadFamily(db, env);
  if (family === "blocked") {
    return {
      blocked: true as const,
      message: CAREER_JOBS_UNAVAILABLE_MESSAGE,
      job: null,
    };
  }
  if (family === "ab") {
    const job = await getOpportunityAsJob(db, userId, jobId);
    return { blocked: false as const, job };
  }
  const job = await db.job.findUnique({
    where: {
      id: jobId,
      userId,
    },
    include: JOB_DETAILS_INCLUDE,
  });
  return { blocked: false as const, job };
}

export async function* iterateJobs(
  db: PrismaClient,
  userId: string,
  filter?: string,
  pageSize = 200,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { family, reason } = await resolveJobsReadFamily(db, env);
  rejectBlockedJobs(family, reason);
  if (family === "ab") {
    let skip = 0;
    while (true) {
      const { data } = await listOpportunitiesAsJobs(db, userId, {
        skip,
        take: pageSize,
        includeArchived: false,
        filter,
      });
      if (!data.length) break;
      yield data;
      skip += data.length;
    }
    return;
  }

  let page = 1;
  while (true) {
    const skip = (page - 1) * pageSize;
    const filterBy = filter
      ? filter === Object.keys(JOB_TYPES)[1]
        ? { status: filter }
        : { type: filter }
      : {};
    const chunk = await db.job.findMany({
      where: {
        userId,
        ...filterBy,
      },
      select: JOB_EXPORT_SELECT,
      skip,
      take: pageSize,
      orderBy: { createdAt: "desc" },
    });
    if (!chunk.length) break;
    yield chunk;
    page += 1;
  }
}

function attemptInRangeWhere(
  userId: string,
  start: Date,
  end: Date,
  endInclusive: boolean,
) {
  // Submissions under an archived opportunity still happened — they derive
  // uiStatus "archived" downstream, so archive removes the job from active
  // stats without rewriting the historical application fact.
  return {
    userId,
    archivedAt: null,
    submittedAt: endInclusive
      ? { gte: start, lte: end }
      : { gte: start, lt: end },
    jobOpportunity: { userId },
  };
}

export async function loadDashboardJobCounts(
  db: PrismaClient,
  userId: string,
  range: { start: Date; end: Date; priorStart: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<DashboardJobCounts> {
  const { family, reason } = await resolveJobsReadFamily(db, env);
  rejectBlockedJobs(family, reason);
  if (family === "ab") {
    const [current, firstSubmissions] = await Promise.all([
      db.applicationAttempt.findMany({
        where: attemptInRangeWhere(userId, range.start, range.end, true),
        select: {
          currentStageCategory: true,
          outcome: true,
          submittedAt: true,
          createdAt: true,
          jobOpportunity: { select: { archivedAt: true, status: true } },
        },
      }),
      // One position counts once no matter how many attempts were submitted:
      // the window membership is decided by MIN(submittedAt), the same
      // first-application date legacy reads on Job.appliedDate.
      db.applicationAttempt.groupBy({
        by: "jobOpportunityId",
        where: {
          userId,
          archivedAt: null,
          submittedAt: { not: null },
          jobOpportunity: { userId },
        },
        _min: { submittedAt: true },
      }),
    ]);
    let jobsApplied = 0;
    let priorJobs = 0;
    for (const row of firstSubmissions) {
      const firstAt = row._min.submittedAt;
      if (!firstAt) continue;
      if (firstAt >= range.start && firstAt <= range.end) jobsApplied += 1;
      else if (firstAt >= range.priorStart && firstAt < range.start) {
        priorJobs += 1;
      }
    }
    let jobsInterview = 0;
    let jobsOffer = 0;
    for (const attempt of current) {
      const uiStatus = deriveUiStatus({
        archivedAt: attempt.jobOpportunity.archivedAt,
        opportunityStatus: attempt.jobOpportunity.status,
        attempt,
      });
      if (uiStatus === "interview") jobsInterview += 1;
      if (isOfferUiStatus(uiStatus)) jobsOffer += 1;
    }
    return {
      jobsApplied,
      priorJobs,
      jobsInterview,
      jobsOffer,
    };
  }

  const [jobsApplied, priorJobs] = await db.$transaction([
    db.job.count({
      where: {
        userId,
        applied: true,
        appliedDate: { gte: range.start, lte: range.end },
      },
    }),
    db.job.count({
      where: {
        userId,
        applied: true,
        appliedDate: { gte: range.priorStart, lt: range.start },
      },
    }),
  ]);
  return { jobsApplied, priorJobs };
}

export async function loadJobsAppliedDateCounts(
  db: PrismaClient,
  userId: string,
  range: { start: Date; end: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ appliedDate: Date; count: number }>> {
  const { family, reason } = await resolveJobsReadFamily(db, env);
  rejectBlockedJobs(family, reason);
  if (family === "ab") {
    // Same first-submission unit as loadDashboardJobCounts: each opportunity
    // contributes its MIN(submittedAt) once, matching legacy Job.appliedDate.
    const firstSubmissions = await db.applicationAttempt.groupBy({
      by: "jobOpportunityId",
      where: {
        userId,
        archivedAt: null,
        submittedAt: { not: null },
        jobOpportunity: { userId },
      },
      _min: { submittedAt: true },
    });
    const grouped = new Map<string, { appliedDate: Date; count: number }>();
    for (const row of firstSubmissions) {
      const firstAt = row._min.submittedAt;
      if (!firstAt || firstAt < range.start || firstAt > range.end) continue;
      const key = format(firstAt, "yyyy-MM-dd");
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        grouped.set(key, { appliedDate: firstAt, count: 1 });
      }
    }
    return [...grouped.values()];
  }

  const jobData = await db.job.groupBy({
    by: "appliedDate",
    _count: { _all: true },
    where: {
      userId,
      applied: true,
      appliedDate: {
        gte: range.start,
        lte: range.end,
      },
    },
    orderBy: {
      appliedDate: "asc",
    },
  });
  return jobData.flatMap((row) =>
    row.appliedDate
      ? [{ appliedDate: row.appliedDate, count: row._count._all }]
      : [],
  );
}

export async function loadRecentJobs(
  db: PrismaClient,
  userId: string,
  take = APP_CONSTANTS.RECENT_NUM_JOBS,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { family, reason } = await resolveJobsReadFamily(db, env);
  rejectBlockedJobs(family, reason);
  if (family === "ab") {
    // "Recent Applications" mirrors the legacy read: only positions with a
    // real submission, newest first-application date first.
    const { data } = await listOpportunitiesAsJobs(db, userId, {
      skip: 0,
      take,
      includeArchived: false,
      appliedOnly: true,
      orderBy: "firstSubmittedAtDesc",
    });
    return data;
  }
  return db.job.findMany({
    where: {
      userId,
      applied: true,
    },
    include: JOB_RECENT_INCLUDE,
    orderBy: {
      appliedDate: "desc",
    },
    take,
  });
}

function deriveOpportunityUiStatus(opportunity: {
  status: string;
  archivedAt: Date | null;
  applicationAttempts: Array<{
    id: string;
    currentStageCategory: string;
    outcome: string;
    submittedAt: Date | null;
    createdAt: Date;
  }>;
}): string {
  return deriveUiStatus({
    archivedAt: opportunity.archivedAt,
    opportunityStatus: opportunity.status,
    attempt: pickLatestAttempt(opportunity.applicationAttempts),
  });
}

export async function loadJobsBoardTotals(
  db: PrismaClient,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JobsBoardTotals> {
  const { family, reason } = await resolveJobsReadFamily(db, env);
  rejectBlockedJobs(family, reason);
  if (family === "ab") {
    const [opportunities, interviews] = await Promise.all([
      db.jobOpportunity.findMany({
        where: { userId, archivedAt: null },
        select: OPPORTUNITY_DERIVE_SELECT,
      }),
      // "Interview count" is the number of interview process steps on live
      // attempts — the A+B unit that represents one interview event.
      db.applicationProcessStep.count({
        where: {
          category: PROCESS_STEP_CATEGORY.INTERVIEW,
          applicationAttempt: {
            userId,
            archivedAt: null,
            jobOpportunity: { archivedAt: null },
          },
        },
      }),
    ]);

    let applied = 0;
    let offers = 0;
    let inProgress = 0;
    for (const opportunity of opportunities) {
      if (opportunity.applicationAttempts.some(isAppliedAttempt)) applied += 1;
      const uiStatus = deriveOpportunityUiStatus(opportunity);
      if (isOfferUiStatus(uiStatus)) offers += 1;
      if (!AB_TERMINAL_UI_STATUSES.has(uiStatus)) inProgress += 1;
    }
    return {
      total: opportunities.length,
      applied,
      interviews,
      offers,
      inProgress,
    };
  }

  const [total, applied, interviews, offers, inProgress] =
    await db.$transaction([
      db.job.count({ where: { userId, ...NOT_DISMISSED_WHERE } }),
      db.job.count({
        where: { userId, applied: true, ...NOT_DISMISSED_WHERE },
      }),
      // The legacy Interview relation is a stub with no date; the honest
      // countable unit is a position currently at interview stage.
      db.job.count({
        where: {
          userId,
          Status: { value: "interview" },
          ...NOT_DISMISSED_WHERE,
        },
      }),
      db.job.count({
        where: {
          userId,
          Status: { value: { in: ["offer", "offer-accepted"] } },
          ...NOT_DISMISSED_WHERE,
        },
      }),
      db.job.count({
        where: {
          userId,
          Status: { value: { notIn: [...LEGACY_TERMINAL_STATUS_VALUES] } },
          ...NOT_DISMISSED_WHERE,
        },
      }),
    ]);
  return { total, applied, interviews, offers, inProgress };
}

// "Does this user have any position records at all" — the jobs side of the
// overview's empty-state decision. Unlike the board totals this deliberately
// counts every row: archived, rejected, and dismissed positions are still
// personal business records, so the overview must not offer the fresh-user
// starting points to someone with history. A blocked family rejects through
// the same JOBS_READ_UNAVAILABLE contract as the other reads.
export async function loadJobsExistence(
  db: PrismaClient,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const { family, reason } = await resolveJobsReadFamily(db, env);
  rejectBlockedJobs(family, reason);
  if (family === "ab") {
    return db.jobOpportunity.count({ where: { userId } });
  }
  return db.job.count({ where: { userId } });
}

export async function loadJobStatusDistribution(
  db: PrismaClient,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<JobStatusCount[]> {
  const { family, reason } = await resolveJobsReadFamily(db, env);
  rejectBlockedJobs(family, reason);
  if (family === "ab") {
    const opportunities = await db.jobOpportunity.findMany({
      where: { userId, archivedAt: null },
      select: OPPORTUNITY_DERIVE_SELECT,
    });
    const counts = new Map<string, number>();
    for (const opportunity of opportunities) {
      const uiStatus = deriveOpportunityUiStatus(opportunity);
      counts.set(uiStatus, (counts.get(uiStatus) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count);
  }

  const [groups, statuses] = await Promise.all([
    db.job.groupBy({
      by: "statusId",
      _count: { _all: true },
      where: { userId, ...NOT_DISMISSED_WHERE },
    }),
    db.jobStatus.findMany({ select: { id: true, value: true } }),
  ]);
  const valueById = new Map(statuses.map((row) => [row.id, row.value]));
  return groups
    .map((group) => ({
      status: valueById.get(group.statusId) ?? "unknown",
      count: group._count._all,
    }))
    .sort((a, b) => b.count - a.count);
}

// Legacy positions whose application deadline falls inside the reminder
// window — the legacy counterpart of the A+B upcoming-events read.
export async function loadUpcomingJobDeadlines(
  db: PrismaClient,
  userId: string,
  range: { start: Date; end: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<
  Array<{ id: string; title: string; company: string | null; dueDate: Date }>
> {
  const { family, reason } = await resolveJobsReadFamily(db, env);
  rejectBlockedJobs(family, reason);
  if (family === "ab") {
    return [];
  }
  const jobs = await db.job.findMany({
    where: {
      userId,
      dueDate: { lte: range.end },
      Status: { value: { notIn: [...LEGACY_TERMINAL_STATUS_VALUES] } },
      ...NOT_DISMISSED_WHERE,
    },
    select: {
      id: true,
      dueDate: true,
      JobTitle: { select: { label: true } },
      Company: { select: { label: true } },
    },
    orderBy: { dueDate: "asc" },
    take: 5,
  });
  return jobs.flatMap((job) =>
    job.dueDate
      ? [
          {
            id: job.id,
            title: job.JobTitle.label,
            company: job.Company?.label ?? null,
            dueDate: job.dueDate,
          },
        ]
      : [],
  );
}

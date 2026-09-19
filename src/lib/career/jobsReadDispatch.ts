import type { PrismaClient } from "@prisma/client";
import { format } from "date-fns";
import { APP_CONSTANTS } from "@/lib/constants";
import { JOB_TYPES } from "@/models/job.model";
import { resolveAbRolloutScope } from "./capabilities";
import { CAREER_RUNTIME_MODE } from "./identities";
import {
  getOpportunityAsJob,
  listOpportunitiesAsJobs,
} from "./jobOpportunityAdapter";
import { isAbJobReadMode } from "./jobsReadCapabilities";
import { resolveCareerRuntimeMode } from "./runtimeMode";
import { deriveUiStatus, isOfferUiStatus } from "./uiStatus";

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
  if (isAbJobReadMode(runtime.mode, resolveAbRolloutScope(env))) {
    return { family: "ab", mode: runtime.mode, reason: runtime.reason };
  }
  return { family: "legacy", mode: runtime.mode, reason: runtime.reason };
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
        OR: [{ discoveryStatus: null }, { discoveryStatus: { not: "dismissed" } }],
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
  const { family, reason } = await resolveJobsReadFamily(db, env);
  if (family === "blocked") {
    return {
      blocked: true as const,
      message: `Career runtime is blocked (${reason})`,
    };
  }
  if (family === "ab") {
    const { data, total } = await listOpportunitiesAsJobs(db, userId, {
      skip: options.skip,
      take: options.take,
      search: options.search,
      appliedOnly: options.appliedOnly,
      filter: options.filter,
      companyValue: options.companyValue,
      titleValue: options.titleValue,
      locationValue: options.locationValue,
      sourceValue: options.sourceValue,
    });
    return { blocked: false as const, data, total };
  }

  const whereClause = buildLegacyJobsWhere(userId, options);
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
  const { family, reason } = await resolveJobsReadFamily(db, env);
  if (family === "blocked") {
    return {
      blocked: true as const,
      message: `Career runtime is blocked (${reason})`,
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
  const { family } = await resolveJobsReadFamily(db, env);
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
  return {
    userId,
    archivedAt: null,
    submittedAt: endInclusive
      ? { gte: start, lte: end }
      : { gte: start, lt: end },
    jobOpportunity: { userId, archivedAt: null },
  };
}

export async function loadDashboardJobCounts(
  db: PrismaClient,
  userId: string,
  range: { start: Date; end: Date; priorStart: Date },
  env: NodeJS.ProcessEnv = process.env,
): Promise<DashboardJobCounts> {
  const { family } = await resolveJobsReadFamily(db, env);
  if (family === "ab") {
    const [current, prior] = await Promise.all([
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
      db.applicationAttempt.count({
        where: attemptInRangeWhere(userId, range.priorStart, range.start, false),
      }),
    ]);
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
      jobsApplied: current.length,
      priorJobs: prior,
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
  const { family } = await resolveJobsReadFamily(db, env);
  if (family === "ab") {
    const attempts = await db.applicationAttempt.findMany({
      where: attemptInRangeWhere(userId, range.start, range.end, true),
      select: { submittedAt: true },
    });
    const grouped = new Map<string, { appliedDate: Date; count: number }>();
    for (const attempt of attempts) {
      if (!attempt.submittedAt) continue;
      const key = format(attempt.submittedAt, "yyyy-MM-dd");
      const existing = grouped.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        grouped.set(key, { appliedDate: attempt.submittedAt, count: 1 });
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
  take = APP_CONSTANTS.RECENT_NUM_JOBS_ACTIVITIES,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { family } = await resolveJobsReadFamily(db, env);
  if (family === "ab") {
    const { data } = await listOpportunitiesAsJobs(db, userId, {
      skip: 0,
      take,
      includeArchived: false,
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

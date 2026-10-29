import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { getJob, listJobs, resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { isArchivedCanonicalJobView } from "@/lib/career/uiStatus";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";
import type { AgentGetJobResult, AgentJobSummary, AgentListJobsResult } from "@/models/agent.model";
import { jobDeadlinePrecision } from "@/lib/jobs/deadlineTime";

const AGENT_JOB_LIST_CAP = 40;

type JobLabel = { label?: string | null } | null | undefined;

type CanonicalJobRow = {
  id: string;
  JobTitle?: JobLabel;
  Company?: JobLabel;
  Location?: JobLabel;
  Status?: { label?: string | null; value?: string | null } | null;
  JobSource?: JobLabel;
  abCompat?: { uiStatus?: string | null } | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
  appliedDate?: Date | string | null;
  dueDate?: Date | string | null;
  deadlineOn?: string | null;
  deadlinePrecision?: string | null;
  description?: string | null;
  jobUrl?: string | null;
};

function labelOf(value: JobLabel): string | null {
  const text = value?.label?.trim();
  return text ? text : null;
}

function isoOf(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function summaryOf(job: CanonicalJobRow): AgentJobSummary {
  return {
    id: job.id,
    title: labelOf(job.JobTitle),
    company: labelOf(job.Company),
    status: job.Status?.label?.trim() || job.Status?.value?.trim() || null,
    location: labelOf(job.Location),
    // dueDate is the instant-carrier compat projection; the precision-aware
    // deadline lives in deadlineOn + the normalized deadlinePrecision.
    deadlineOn: job.deadlineOn ?? null,
    deadlinePrecision: jobDeadlinePrecision(job),
    createdAt: isoOf(job.createdAt),
    updatedAt: isoOf(job.updatedAt),
  };
}

export async function listJobsForAgent(userId: string): Promise<AgentListJobsResult> {
  const listed = await listJobs(prisma, userId, { take: AGENT_JOB_LIST_CAP });
  if (listed.blocked) {
    return { status: "unavailable", reason: listed.message };
  }
  const jobs = listed.data.map((job) => summaryOf(job as CanonicalJobRow));
  return {
    status: "ok",
    jobs,
    total: listed.total,
    truncated: listed.total > jobs.length,
  };
}

export async function getJobForAgent(
  userId: string,
  jobId?: string,
): Promise<AgentGetJobResult> {
  if (!jobId) {
    const family = await resolveJobsReadFamily(prisma);
    if (family.family === "blocked") {
      return {
        status: "unavailable",
        reason: CAREER_JOBS_UNAVAILABLE_MESSAGE,
      };
    }
    return { status: "no_job" };
  }

  const loaded = await getJob(prisma, userId, jobId);
  if (loaded.blocked) {
    return { status: "unavailable", reason: loaded.message };
  }
  if (!loaded.job) return { status: "no_job" };

  const job = loaded.job as CanonicalJobRow;
  // Archived canonical jobs do not exist for AI: no details, no description.
  if (isArchivedCanonicalJobView(job)) return { status: "no_job" };
  const full = job.description ?? "";
  const jobDescription = full.slice(0, APP_CONSTANTS.AGENT_CHAT_RESUME_MAX_CHARS);
  return {
    status: "ok",
    job: {
      ...summaryOf(job),
      source: labelOf(job.JobSource),
      jobUrl: job.jobUrl?.trim() || null,
      appliedDate: isoOf(job.appliedDate),
      dueDate: isoOf(job.dueDate),
      jobDescription,
      descriptionChars: jobDescription.length,
      descriptionTruncated: jobDescription.length < full.length,
    },
  };
}

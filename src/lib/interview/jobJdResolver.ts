import "server-only";

import {
  INTERVIEW_ADAPTER_ERROR_CODES,
  InterviewAdapterError,
} from "./errors";
import { assertSameUser, assertUserIdPresent } from "./userAdapter";

/**
 * JobOpportunity / JobDescriptionVersion resolver (Phase 2).
 *
 * Frozen pair rule: both ids absent -> PASS (no job context); exactly one
 * present -> JOB_PAIR_REQUIRED; job not owned by the user -> SESSION_FORBIDDEN;
 * JD missing or belonging to another job -> JD_NOT_FOUND / JOB_JD_MISMATCH.
 * A valid pair yields frozen references/context only. Read-only: never writes
 * Job/JD rows and never auto-selects the opportunity `currentJdVersionId`.
 */

export interface JobJdInput {
  userId: string;
  jobOpportunityId?: string | null;
  jobDescriptionVersionId?: string | null;
}

/** Frozen context for a valid job+JD pair (or the absent-pair case). */
export interface JobJdContext {
  jobOpportunityId: string | null;
  jobDescriptionVersionId: string | null;
  jobTitle: string | null;
  jdVersionNumber: number | null;
  jdContentHash: string | null;
}

export interface JobJdReader {
  jobOpportunity: {
    findUnique: (args: { where: { id: string } }) => Promise<{
      id: string;
      userId: string;
      title: string;
    } | null>;
  };
  jobDescriptionVersion: {
    findUnique: (args: { where: { id: string } }) => Promise<{
      id: string;
      jobOpportunityId: string;
      versionNumber: number;
      contentHash: string;
    } | null>;
  };
}

const EMPTY_CONTEXT: JobJdContext = {
  jobOpportunityId: null,
  jobDescriptionVersionId: null,
  jobTitle: null,
  jdVersionNumber: null,
  jdContentHash: null,
};

export async function resolveJobJdContext(
  db: JobJdReader,
  input: JobJdInput,
): Promise<JobJdContext> {
  assertUserIdPresent(input.userId);
  const hasJob =
    typeof input.jobOpportunityId === "string" &&
    input.jobOpportunityId.trim().length > 0;
  const hasJd =
    typeof input.jobDescriptionVersionId === "string" &&
    input.jobDescriptionVersionId.trim().length > 0;

  if (!hasJob && !hasJd) return { ...EMPTY_CONTEXT };
  if (hasJob !== hasJd) {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.JOB_PAIR_REQUIRED,
      "jobOpportunityId and jobDescriptionVersionId must both be set or both be null",
    );
  }

  const jobId = (input.jobOpportunityId as string).trim();
  const jdId = (input.jobDescriptionVersionId as string).trim();

  const job = await db.jobOpportunity.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.JOB_NOT_FOUND,
      "Job opportunity not found",
    );
  }
  assertSameUser(job.userId, input.userId);

  const jd = await db.jobDescriptionVersion.findUnique({ where: { id: jdId } });
  if (!jd) {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.JD_NOT_FOUND,
      "Job description version not found",
    );
  }
  if (jd.jobOpportunityId !== job.id) {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.JOB_JD_MISMATCH,
      "Job description version does not belong to the given job opportunity",
    );
  }

  return {
    jobOpportunityId: job.id,
    jobDescriptionVersionId: jd.id,
    jobTitle: job.title,
    jdVersionNumber: jd.versionNumber,
    jdContentHash: jd.contentHash,
  };
}

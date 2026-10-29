"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { createJobRecord } from "@/lib/jobs/createJobRecord";
import { isFullAbCapabilityEnabled } from "@/lib/career/capabilities";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { assertLegacyCareerWriteAllowed } from "@/lib/career/writeGuard";
import {
  archiveOpportunity,
  createOpportunityFromJobForm,
  updateOpportunityFromJobForm,
} from "@/lib/career/jobOpportunityAdapter";
import { CareerRuntimeError } from "@/lib/career/errors";
import {
  CAREER_COVER_LETTER_UNSUPPORTED_MESSAGE,
  CAREER_TAGS_UNSUPPORTED_MESSAGE,
  CAREER_WRITE_DENIED_MESSAGE,
  careerMutationDeniedMessage,
} from "@/lib/career/userMessages";
import { AddJobFormValues } from "@/models/addJobForm.schema";
import { revalidatePath } from "next/cache";
import { requireUser } from "../shared";
import { getServerI18n } from "@/i18n/server";

const SESSION_INVALID_MESSAGE =
  "Your session appears invalid. Please sign out and sign back in.";
const RELATED_RECORD_MISSING_MESSAGE =
  "Could not save because a related record is missing.";

const CAREER_ERROR_I18N_KEYS: Record<string, string> = {
  CAREER_RUNTIME_BLOCKED: "errors.careerEditsBlocked",
  JOB_MUTATIONS_DISABLED: "errors.careerEditsDisabled",
  LEGACY_COVER_LETTER_UNSUPPORTED: "errors.careerCoverLetterUnsupported",
  LEGACY_TAGS_UNSUPPORTED: "errors.careerTagsUnsupported",
  CAREER_READ_NOT_ENABLED: "errors.careerReadDenied",
  CAREER_WRITE_NOT_ENABLED: "errors.careerWriteDenied",
  AB_WRITES_NOT_ENABLED: "errors.careerWriteDenied",
  OPPORTUNITY_ARCHIVED: "errors.jobArchived",
  OPPORTUNITY_NOT_FOUND: "errors.notFound",
  ATTEMPT_ARCHIVED: "errors.jobArchived",
};

export async function localizedJobError(error: unknown, fallback: string) {
  const result = handleError(error, fallback);
  if (error instanceof CareerRuntimeError) {
    const { t } = await getServerI18n();
    const key =
      error.code === "LEGACY_WRITE_BLOCKED"
        ? error.message === CAREER_WRITE_DENIED_MESSAGE
          ? "errors.careerWriteDenied"
          : "errors.careerEditorUnavailable"
        : (CAREER_ERROR_I18N_KEYS[error.code] ?? "errors.careerWriteDenied");
    return { success: false as const, message: t(key) };
  }
  if (
    result.message !== SESSION_INVALID_MESSAGE &&
    result.message !== RELATED_RECORD_MISSING_MESSAGE
  ) {
    return result;
  }
  const { t } = await getServerI18n();
  return {
    success: false as const,
    message:
      result.message === SESSION_INVALID_MESSAGE
        ? t("session.invalid")
        : t("errors.relatedRecordMissing"),
  };
}

function normalizeOptionalFk(value?: string | null): string | null | undefined {
  if (value == null) return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function assertJobMutationsAllowed(mode: string): void {
  if (mode === CAREER_RUNTIME_MODE.AB_ENABLED) return;
  if (mode === CAREER_RUNTIME_MODE.LEGACY_ONLY) return;
  throw new CareerRuntimeError(
    mode === CAREER_RUNTIME_MODE.BLOCKED
      ? "CAREER_RUNTIME_BLOCKED"
      : "JOB_MUTATIONS_DISABLED",
    careerMutationDeniedMessage(mode),
  );
}

type JobRefs = {
  jobTitleId?: string | null;
  companyId?: string | null;
  locationId?: string | null;
  jobSourceId?: string | null;
  resumeId?: string | null;
  coverLetterId?: string | null;
  tagIds?: string[];
};

// Foreign keys prove a row exists, not that the caller owns it, so every
// referenced id is counted against the caller before it is attached.
const assertJobRefsOwned = async (userId: string, refs: JobRefs) => {
  const owned = { createdBy: userId };
  const inProfile = { profile: { userId } };
  const tagIds = [...new Set(refs.tagIds ?? [])];

  const [title, company, location, source, resume, coverLetter, tags] =
    await Promise.all([
      refs.jobTitleId
        ? prisma.jobTitle.count({ where: { id: refs.jobTitleId, ...owned } })
        : 1,
      refs.companyId
        ? prisma.company.count({ where: { id: refs.companyId, ...owned } })
        : 1,
      refs.locationId
        ? prisma.location.count({ where: { id: refs.locationId, ...owned } })
        : 1,
      refs.jobSourceId
        ? prisma.jobSource.count({ where: { id: refs.jobSourceId, ...owned } })
        : 1,
      refs.resumeId
        ? prisma.resume.count({ where: { id: refs.resumeId, ...inProfile } })
        : 1,
      refs.coverLetterId
        ? prisma.coverLetter.count({
            where: { id: refs.coverLetterId, ...inProfile },
          })
        : 1,
      tagIds.length > 0
        ? prisma.tag.count({ where: { id: { in: tagIds }, ...owned } })
        : 0,
    ]);

  if (title === 0) throw new Error("Job title not found");
  if (company === 0) throw new Error("Company not found");
  if (location === 0) throw new Error("Location not found");
  if (source === 0) throw new Error("Job source not found");
  if (resume === 0) throw new Error("Resume not found");
  if (coverLetter === 0) throw new Error("Cover letter not found");
  if (tags !== tagIds.length) throw new Error("Tag not found");
};

export const addJob = async (
  data: AddJobFormValues,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const {
      title,
      company,
      location,
      type,
      workplaceType,
      status,
      source,
      salaryRange,
      dueDate,
      deadlineOn,
      dateApplied,
      jobDescription,
      jobUrl,
      applied,
      resume,
      coverLetter,
      tags,
      recruitmentCohort,
      recruitmentBatch,
    } = data;

    const jobSourceId = normalizeOptionalFk(source);
    const locationId = normalizeOptionalFk(location);
    const resumeId = normalizeOptionalFk(resume);
    const coverLetterId = normalizeOptionalFk(coverLetter);

    const runtime = await resolveCareerRuntimeMode(prisma);
    assertJobMutationsAllowed(runtime.mode);
    if (isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
      if (coverLetter) {
        throw new CareerRuntimeError(
          "LEGACY_COVER_LETTER_UNSUPPORTED",
          CAREER_COVER_LETTER_UNSUPPORTED_MESSAGE,
        );
      }
      if (tags && tags.length > 0) {
        throw new CareerRuntimeError(
          "LEGACY_TAGS_UNSUPPORTED",
          CAREER_TAGS_UNSUPPORTED_MESSAGE,
        );
      }
      await assertJobRefsOwned(user.id, {
        jobTitleId: title,
        companyId: company,
        locationId,
        jobSourceId,
      });
      const opportunity = await createOpportunityFromJobForm(prisma, user.id, {
        title,
        company,
        location: locationId ?? undefined,
        type,
        workplaceType,
        source: jobSourceId ?? undefined,
        status,
        dueDate,
        deadlineOn,
        dateApplied,
        salaryRange: salaryRange || null,
        recruitmentCohort,
        recruitmentBatch,
        jobDescription,
        jobUrl,
        applied,
        resume: resumeId ?? undefined,
      });
      revalidatePath("/dashboard");
      return { success: true, data: opportunity };
    }

    await assertJobRefsOwned(user.id, {
      jobTitleId: title,
      companyId: company,
      locationId,
      jobSourceId,
      resumeId,
      coverLetterId,
      tagIds: tags,
    });
    const statusRow = await prisma.jobStatus.findUnique({
      where: { id: status },
      select: { id: true },
    });
    if (!statusRow) {
      throw new Error("Job status not found");
    }
    const job = await createJobRecord({
      jobTitleId: title,
      companyId: company,
      locationId,
      statusId: status,
      jobSourceId,
      salaryRange: salaryRange || null,
      dueDate,
      appliedDate: applied ? (dateApplied ?? new Date()) : null,
      description: jobDescription,
      jobType: type,
      workplaceType,
      userId: user.id,
      jobUrl,
      applied,
      resumeId,
      coverLetterId,
      tagIds: tags ?? [],
    });
    revalidatePath("/dashboard");
    return { success: true, data: job };
  } catch (error) {
    return localizedJobError(error, "Failed to create job. ");
  }
};

export const updateJob = async (
  data: AddJobFormValues,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    if (!data.id) {
      throw new Error("Job id is required");
    }

    const {
      id,
      title,
      company,
      location,
      type,
      workplaceType,
      status,
      source,
      salaryRange,
      dueDate,
      deadlineOn,
      dateApplied,
      jobDescription,
      jobUrl,
      applied,
      resume,
      coverLetter,
      tags,
      recruitmentCohort,
      recruitmentBatch,
    } = data;

    const tagIds = tags ?? [];
    const jobSourceId = normalizeOptionalFk(source);
    const locationId = normalizeOptionalFk(location);
    const resumeId = normalizeOptionalFk(resume);
    const coverLetterId = normalizeOptionalFk(coverLetter);

    const runtime = await resolveCareerRuntimeMode(prisma);
    assertJobMutationsAllowed(runtime.mode);

    if (isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
      if (coverLetter) {
        throw new CareerRuntimeError(
          "LEGACY_COVER_LETTER_UNSUPPORTED",
          CAREER_COVER_LETTER_UNSUPPORTED_MESSAGE,
        );
      }
      if (tagIds.length > 0) {
        throw new CareerRuntimeError(
          "LEGACY_TAGS_UNSUPPORTED",
          CAREER_TAGS_UNSUPPORTED_MESSAGE,
        );
      }
      await assertJobRefsOwned(user.id, {
        jobTitleId: title,
        companyId: company,
        locationId,
        jobSourceId,
      });
      const opportunity = await updateOpportunityFromJobForm(prisma, user.id, {
        id,
        title,
        company,
        location: locationId ?? undefined,
        type,
        workplaceType,
        source: jobSourceId ?? undefined,
        status,
        dueDate,
        deadlineOn,
        dateApplied,
        salaryRange: salaryRange || null,
        recruitmentCohort,
        recruitmentBatch,
        jobDescription,
        jobUrl,
        applied,
        resume: resumeId ?? undefined,
      });
      revalidatePath("/dashboard");
      return { success: true, data: opportunity };
    }

    await assertLegacyCareerWriteAllowed(prisma);
    const current = await prisma.job.findFirst({
      where: { id, userId: user.id },
      select: {
        jobTitleId: true,
        companyId: true,
        locationId: true,
        jobSourceId: true,
        resumeId: true,
        coverLetterId: true,
        applied: true,
        appliedDate: true,
        tags: { select: { id: true } },
      },
    });
    if (!current) {
      throw new Error("Job not found");
    }

    // Only newly attached ids are checked: migration 20260212202940 gave every
    // JobSource to the first user, so other users' older jobs must stay editable.
    const changed = (next?: string | null, prev?: string | null) =>
      next !== prev ? next : undefined;
    const currentTagIds = new Set(current.tags.map((tag) => tag.id));
    await assertJobRefsOwned(user.id, {
      jobTitleId: changed(title, current.jobTitleId),
      companyId: changed(company, current.companyId),
      locationId: changed(locationId, current.locationId),
      jobSourceId: changed(jobSourceId, current.jobSourceId),
      resumeId: changed(resumeId, current.resumeId),
      coverLetterId: changed(coverLetterId, current.coverLetterId),
      tagIds: tagIds.filter((tagId) => !currentTagIds.has(tagId)),
    });
    const statusRow = await prisma.jobStatus.findUnique({
      where: { id: status },
      select: { id: true },
    });
    if (!statusRow) {
      throw new Error("Job status not found");
    }

    const job = await prisma.job.update({
      where: {
        id,
        userId: user.id,
      },
      data: {
        jobTitleId: title,
        companyId: company,
        locationId,
        statusId: status,
        jobSourceId,
        salaryRange: salaryRange || null,
        dueDate: dueDate,
        // applied is an irreversible historical fact, and appliedDate records
        // the first application only — a plain edit can set the flag once or
        // correct a missing date on an already-applied job, but can never
        // unset the flag or rewrite the original timestamp.
        applied: current.applied || applied,
        appliedDate: current.applied
          ? (current.appliedDate ?? dateApplied ?? null)
          : applied
            ? (dateApplied ?? new Date())
            : null,
        description: jobDescription,
        jobType: type,
        workplaceType,
        jobUrl,
        resumeId,
        coverLetterId,
        tags: { set: tagIds.map((id) => ({ id })) },
      },
    });
    revalidatePath("/dashboard");
    return { success: true, data: job };
  } catch (error) {
    return localizedJobError(error, "Failed to update job. ");
  }
};

export const deleteJobById = async (
  jobId: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const runtime = await resolveCareerRuntimeMode(prisma);
    assertJobMutationsAllowed(runtime.mode);
    if (isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
      const res = await archiveOpportunity(prisma, user.id, jobId);
      revalidatePath("/dashboard");
      return { res, success: true };
    }

    await assertLegacyCareerWriteAllowed(prisma);
    const res = await prisma.job.delete({
      where: {
        id: jobId,
        userId: user.id,
      },
    });
    revalidatePath("/dashboard");
    return { res, success: true };
  } catch (error) {
    const msg = "Failed to delete job.";
    return handleError(error, msg);
  }
};

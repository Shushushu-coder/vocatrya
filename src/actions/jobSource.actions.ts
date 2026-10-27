"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  resolveJobSourceIdentity,
  SYSTEM_JOB_SOURCE_VALUES,
} from "@/lib/jobs/jobSources";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";
import { AB_APPLIED_OPPORTUNITY_WHERE } from "@/lib/career/jobOpportunityAdapter";
import { getReferenceEntityList } from "./referenceList";

export const getJobSourceList = async (
  page: number = 1,
  limit: number = APP_CONSTANTS.RECORDS_PER_PAGE,
  countBy?: string,
  search?: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    // The job stats columns must follow the active read family; a blocked
    // runtime must not silently fall back to frozen legacy Job rows.
    const { family } = await resolveJobsReadFamily(prisma);
    if (family === "blocked") {
      return {
        success: false,
        message: CAREER_JOBS_UNAVAILABLE_MESSAGE,
      };
    }
    const ab = family === "ab";

    return await getReferenceEntityList({
      model: prisma.jobSource,
      userId: user.id,
      fkField: "jobSourceId",
      appliedRelation: "jobsApplied",
      // A+B has no dictionary FK: stats group JobOpportunity.sourceLabel and
      // map back by exact label equality, the same match My Jobs applies.
      // The applied groupBy overrides the stale _count.jobsApplied count.
      // sourceLabel is discovery provenance, not a delivery channel — the
      // stats never imply which channel an ApplicationAttempt used.
      ...(ab
        ? {
            countDelegate: prisma.jobOpportunity,
            countGroupBy: "sourceLabel",
            countMapKey: "label",
            jobsTotalWhere: { archivedAt: null },
            extraCounts: [
              { key: "jobsApplied", where: AB_APPLIED_OPPORTUNITY_WHERE },
            ],
            // No AB relation exists to order by — label order stays
            // deterministic instead of sorting on frozen legacy counts.
            orderBy: [{ label: "asc" }],
          }
        : {}),
      page,
      limit,
      countBy,
      search,
    });
  } catch (error) {
    const msg = "Failed to fetch job source list. ";
    return handleError(error, msg);
  }
};

export const updateJobSource = async (
  jobSourceId: string,
  label: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const res = await prisma.$transaction(async (tx) => {
      const existing = await tx.jobSource.findFirst({
        where: { id: jobSourceId, createdBy: user.id },
      });
      if (!existing) {
        throw new Error("Job source not found");
      }

      // Seeded channels display localized names keyed by `value`; renaming the
      // English seed label would only diverge the library row from every
      // consumer, so built-in rows are not editable.
      if (SYSTEM_JOB_SOURCE_VALUES.includes(existing.value)) {
        throw new Error("Built-in job sources cannot be renamed.");
      }

      const identity = label.trim() === existing.label
        ? { label: existing.label, value: existing.value }
        : resolveJobSourceIdentity(
            label,
            APP_CONSTANTS.MAX_JOB_SOURCE_LABEL_LENGTH,
          );
      if ("error" in identity) {
        throw new Error(
          identity.error === "too-long"
            ? "Job source name is too long"
            : "Please provide job source name",
        );
      }

      // Adopt the resolved identity (custom text or a re-seeded system row);
      // another row already holding that value blocks the rename.
      if (
        identity.label !== existing.label ||
        identity.value !== existing.value
      ) {
        if (identity.label !== existing.label) {
          const used = await tx.jobOpportunity.count({
            where: { userId: user.id, sourceLabel: existing.label },
          });
          if (used > 0) {
            throw new Error("Job sources used by saved opportunities cannot be renamed.");
          }
        }
        const conflict = await tx.jobSource.findFirst({
          where: { value: identity.value, createdBy: user.id },
        });
        if (conflict && conflict.id !== jobSourceId) {
          throw new Error("Job source already exists!");
        }
      }

      return tx.jobSource.update({
        where: { id: jobSourceId, createdBy: user.id },
        data: { label: identity.label, value: identity.value },
      });
    });
    return { success: true, data: res };
  } catch (error) {
    const msg = "Failed to update job source.";
    return handleError(error, msg);
  }
};

export const deleteJobSourceById = async (
  jobSourceId: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const jobs = await prisma.job.count({
      where: {
        jobSourceId,
        userId: user.id,
      },
    });

    if (jobs > 0) {
      throw new Error(
        `Job source cannot be deleted due to ${jobs} number of associated jobs! `
      );
    }

    const res = await prisma.jobSource.delete({
      where: {
        id: jobSourceId,
        createdBy: user.id,
      },
    });
    return { res, success: true };
  } catch (error) {
    const msg = "Failed to delete job source.";
    return handleError(error, msg);
  }
};

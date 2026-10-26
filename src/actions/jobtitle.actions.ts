"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import { APP_CONSTANTS } from "@/lib/constants";
import { canonicalizeEntityValue } from "@/lib/jobs/canonicalize";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";
import { AB_APPLIED_OPPORTUNITY_WHERE } from "@/lib/career/jobOpportunityAdapter";
import { getReferenceEntityList } from "./referenceList";

export const getAllJobTitles = async (): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    const list = await prisma.jobTitle.findMany({
      where: {
        createdBy: user?.id,
      },
    });
    return list;
  } catch (error) {
    const msg = "Failed to fetch job title list. ";
    return handleError(error, msg);
  }
};

export const getJobTitleList = async (
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
      model: prisma.jobTitle,
      userId: user.id,
      fkField: "jobTitleId",
      appliedRelation: "jobs",
      // A+B has no dictionary FK: stats group JobOpportunity.title and map
      // back by exact label equality, the same match My Jobs applies.
      // The applied groupBy overrides the stale _count.jobs relation count.
      ...(ab
        ? {
            countDelegate: prisma.jobOpportunity,
            countGroupBy: "title",
            countMapKey: "label",
            jobsTotalWhere: { archivedAt: null },
            extraCounts: [
              { key: "jobs", where: AB_APPLIED_OPPORTUNITY_WHERE },
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
    const msg = "Failed to fetch job title list. ";
    return handleError(error, msg);
  }
};

export const createJobTitle = async (
  label: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const value = canonicalizeEntityValue(label.trim());

    const upsertedTitle = await prisma.jobTitle.upsert({
      where: { value_createdBy: { value, createdBy: user.id } },
      update: { label },
      create: { label, value, createdBy: user.id },
    });

    return upsertedTitle;
  } catch (error) {
    const msg = "Failed to create job title. ";
    return handleError(error, msg);
  }
};

export const deleteJobTitleById = async (
  jobTitleId: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const experiences = await prisma.workExperience.count({
      where: {
        jobTitleId,
      },
    });
    if (experiences > 0) {
      throw new Error(
        `Job title cannot be deleted due to its use in experience section of one of the resume! `
      );
    }
    const jobs = await prisma.job.count({
      where: {
        jobTitleId,
        userId: user.id,
      },
    });

    if (jobs > 0) {
      throw new Error(
        `Job title cannot be deleted due to ${jobs} number of associated jobs! `
      );
    }

    const res = await prisma.jobTitle.delete({
      where: {
        id: jobTitleId,
        createdBy: user.id,
      },
    });
    return { res, success: true };
  } catch (error) {
    const msg = "Failed to delete job title.";
    return handleError(error, msg);
  }
};

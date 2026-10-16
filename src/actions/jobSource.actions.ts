"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import { APP_CONSTANTS } from "@/lib/constants";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
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
    const { family, reason } = await resolveJobsReadFamily(prisma);
    if (family === "blocked") {
      return {
        success: false,
        message: `Career jobs are unavailable (${reason})`,
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

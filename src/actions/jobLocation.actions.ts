"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import { APP_CONSTANTS } from "@/lib/constants";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { CAREER_JOBS_UNAVAILABLE_MESSAGE } from "@/lib/career/userMessages";
import { AB_APPLIED_OPPORTUNITY_WHERE } from "@/lib/career/jobOpportunityAdapter";
import { getReferenceEntityList } from "./referenceList";

export const getAllJobLocations = async (): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    const list = await prisma.location.findMany({
      where: {
        createdBy: user.id,
      },
    });
    return list;
  } catch (error) {
    const msg = "Failed to fetch job location list. ";
    return handleError(error, msg);
  }
};

export const getJobLocationsList = async (
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
      model: prisma.location,
      userId: user.id,
      fkField: "locationId",
      appliedRelation: "jobsApplied",
      // A+B has no dictionary FK: stats group JobOpportunity.locationText and
      // map back by exact label equality, the same match My Jobs applies.
      // The applied groupBy overrides the stale _count.jobsApplied count.
      ...(ab
        ? {
            countDelegate: prisma.jobOpportunity,
            countGroupBy: "locationText",
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
    const msg = "Failed to fetch job location list. ";
    return handleError(error, msg);
  }
};

export const deleteJobLocationById = async (
  locationId: string
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    const experiences = await prisma.workExperience.count({
      where: {
        locationId,
      },
    });
    if (experiences > 0) {
      throw new Error(
        `Job location cannot be deleted due to its use in experience section of one of the resume! `
      );
    }

    const educations = await prisma.education.count({
      where: {
        locationId,
      },
    });
    if (educations > 0) {
      throw new Error(
        `Job location cannot be deleted due to its use in education section of one of the resume! `
      );
    }

    const jobs = await prisma.job.count({
      where: {
        locationId,
        userId: user.id,
      },
    });

    if (jobs > 0) {
      throw new Error(
        `Location cannot be deleted due to ${jobs} number of associated jobs! `
      );
    }

    // Optional relation, so the Prisma default is SetNull; same reasoning as
    // the company guard — nothing at the database level blocks this.
    const contacts = await prisma.contact.count({
      where: { locationId, createdBy: user.id },
    });
    if (contacts > 0) {
      throw new Error(
        `Location cannot be deleted due to ${contacts} associated contact${contacts === 1 ? "" : "s"}! `
      );
    }

    const res = await prisma.location.delete({
      where: {
        id: locationId,
        createdBy: user.id,
      },
    });
    return { res, success: true };
  } catch (error) {
    const msg = "Failed to delete job location.";
    return handleError(error, msg);
  }
};

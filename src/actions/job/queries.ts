"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  getJob,
  iterateJobs,
  listJobs,
} from "@/lib/career/jobsReadDispatch";
import { requireUser } from "../shared";

export const getJobsList = async (
  page: number = 1,
  limit: number = APP_CONSTANTS.RECORDS_PER_PAGE,
  filter?: string,
  search?: string,
  companyValue?: string,
  appliedOnly?: boolean,
  titleValue?: string,
  locationValue?: string,
  sourceValue?: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    const skip = (page - 1) * limit;
    const result = await listJobs(prisma, user.id, {
      skip,
      take: limit,
      filter,
      search,
      companyValue,
      appliedOnly,
      titleValue,
      locationValue,
      sourceValue,
    });
    if (result.blocked) {
      return { success: false, message: result.message };
    }
    return { success: true, data: result.data, total: result.total };
  } catch (error) {
    const msg = "Failed to fetch jobs list. ";
    return handleError(error, msg);
  }
};

export async function* getJobsIterator(filter?: string, pageSize = 200) {
  const user = await requireUser();
  yield* iterateJobs(prisma, user.id, filter, pageSize);
}

export const getJobDetails = async (
  jobId: string,
): Promise<any | undefined> => {
  try {
    if (!jobId) {
      throw new Error("Please provide job id");
    }
    const user = await requireUser();
    const result = await getJob(prisma, user.id, jobId);
    if (result.blocked) {
      return { success: false, message: result.message };
    }
    return { job: result.job, success: true };
  } catch (error) {
    const msg = "Failed to fetch job details. ";
    return handleError(error, msg);
  }
};

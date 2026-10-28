import { APP_CONSTANTS } from "@/lib/constants";
import prisma from "@/lib/db";
import { loadRecentJobs } from "@/lib/career/jobsReadDispatch";
import { requireUser } from "../shared";
import { jobsReadOrBlocked, type DashboardJobsReadResult } from "./shared";

export const getRecentJobs = async (): Promise<
  DashboardJobsReadResult<any[]>
> => {
  try {
    const user = await requireUser();
    return await jobsReadOrBlocked(() =>
      loadRecentJobs(prisma, user.id, APP_CONSTANTS.RECENT_NUM_JOBS),
    );
  } catch (error) {
    const msg = "Failed to fetch jobs list. ";
    console.error(msg, error);
    throw new Error(msg);
  }
};

import prisma from "@/lib/db";
import {
  loadJobStatusDistribution,
  loadJobsBoardTotals,
  type JobStatusCount,
  type JobsBoardTotals,
} from "@/lib/career/jobsReadDispatch";
import { requireUser } from "../shared";
import { jobsReadOrBlocked, type DashboardJobsReadResult } from "./shared";

// Analytics board headline totals. Blocked jobs families surface as the
// typed blocked result — the board degrades those cards instead of
// fabricating numbers.
export const getJobsBoardTotals = async (): Promise<
  DashboardJobsReadResult<JobsBoardTotals>
> => {
  const user = await requireUser();
  try {
    return await jobsReadOrBlocked(() => loadJobsBoardTotals(prisma, user.id));
  } catch (error) {
    const msg = "Failed to fetch jobs board totals.";
    console.error(msg, error);
    throw new Error(msg);
  }
};

export const getJobStatusDistribution = async (): Promise<
  DashboardJobsReadResult<JobStatusCount[]>
> => {
  const user = await requireUser();
  try {
    return await jobsReadOrBlocked(() =>
      loadJobStatusDistribution(prisma, user.id),
    );
  } catch (error) {
    const msg = "Failed to fetch job status distribution.";
    console.error(msg, error);
    throw new Error(msg);
  }
};

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
      loadRecentJobs(
        prisma,
        user.id,
        APP_CONSTANTS.RECENT_NUM_JOBS_ACTIVITIES,
      ),
    );
  } catch (error) {
    const msg = "Failed to fetch jobs list. ";
    console.error(msg, error);
    throw new Error(msg);
  }
};

export const getRecentActivities = async () => {
  try {
    const user = await requireUser();
    const list = await prisma.activity.findMany({
      where: {
        userId: user.id,
        endTime: { not: null },
      },
      include: {
        activityType: true,
      },
      orderBy: {
        endTime: "desc",
      },
      take: APP_CONSTANTS.RECENT_NUM_JOBS_ACTIVITIES,
    });
    return list;
  } catch (error) {
    const msg = "Failed to fetch recent activities.";
    console.error(msg, error);
    throw new Error(msg);
  }
};

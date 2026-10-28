import prisma from "@/lib/db";
import { getLastNDays } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import { loadJobsAppliedDateCounts } from "@/lib/career/jobsReadDispatch";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { formatDate as formatLocaleDate } from "@/i18n/formatters";
import { requireUser } from "../shared";
import {
  getLocalDayRange,
  jobsReadOrBlocked,
  type DashboardJobsReadResult,
} from "./shared";

export const getJobsActivityForPeriod = async (
  days: number = 7,
  locale: Locale = DEFAULT_LOCALE,
): Promise<DashboardJobsReadResult<any[]>> => {
  try {
    const user = await requireUser();
    // Use local time for date range to match grouping and getLastNDays
    const { start: rangeStart, end: today } = getLocalDayRange(days - 1);
    const jobDataResult = await jobsReadOrBlocked(() =>
      loadJobsAppliedDateCounts(prisma, user.id, {
        start: rangeStart,
        end: today,
      }),
    );
    if (jobDataResult.blocked) {
      return jobDataResult;
    }
    const jobData = jobDataResult.data;
    // Reduce to a format that groups by unique date (YYYY-MM-DD) using local time
    const groupedPosts = jobData.reduce((acc: Record<string, number>, post) => {
      const date = format(new Date(post.appliedDate), "yyyy-MM-dd");
      acc[date] = (acc[date] || 0) + post.count;
      return acc;
    }, {});
    // Every day in the window is represented, with a count of 0 if necessary.
    // Day labels go through the locale-aware formatter so zh-CN reads
    // naturally (e.g. "10月21日周二") instead of the old hardcoded English.
    const lastNDays = getLastNDays(days, "yyyy-MM-dd");
    const result = lastNDays.map((dateStr) => ({
      day: formatLocaleDate(parseISO(dateStr), locale, {
        month: "short",
        day: "numeric",
        weekday: "short",
      }),
      value: groupedPosts[dateStr] || 0,
    }));

    return { blocked: false, data: result };
  } catch (error) {
    const msg = "Failed to fetch jobs list. ";
    console.error(msg, error);
    throw new Error(msg);
  }
};

export const getJobsCalendarData = async (): Promise<
  DashboardJobsReadResult<Record<string, any[]>>
> => {
  try {
    const user = await requireUser();
    // Use local time for date range to match grouping
    const { start: daysAgo, end: today } = getLocalDayRange(365);
    const jobDataResult = await jobsReadOrBlocked(() =>
      loadJobsAppliedDateCounts(prisma, user.id, {
        start: daysAgo,
        end: today,
      }),
    );

    // The heatmap's per-day value is the jobs count itself, so a blocked
    // family degrades the whole card rather than rendering zeros.
    if (jobDataResult.blocked) {
      return jobDataResult;
    }
    const jobData = jobDataResult.data;

    const groupedJobs: Record<string, number> = jobData.reduce(
      (acc: Record<string, number>, job) => {
        const date = format(new Date(job.appliedDate), "yyyy-MM-dd");
        acc[date] = (acc[date] || 0) + job.count;
        return acc;
      },
      {},
    );

    const groupedByYear = Object.keys(groupedJobs).reduce(
      (acc: Record<string, any[]>, date) => {
        const year = date.split("-")[0];
        if (!acc[year]) acc[year] = [];
        acc[year].push({
          day: date,
          value: groupedJobs[date],
        });
        return acc;
      },
      {},
    );

    return { blocked: false, data: groupedByYear };
  } catch (error) {
    const msg = "Failed to fetch jobs list. ";
    console.error(msg, error);
    throw new Error(msg);
  }
};

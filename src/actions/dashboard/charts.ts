import prisma from "@/lib/db";
import { getLast7Days, getLastNDays } from "@/lib/utils";
import { format, parseISO } from "date-fns";
import { OTHER_SLICE_ID } from "@/components/dashboard/jobsActivityChart";
import { loadJobsAppliedDateCounts } from "@/lib/career/jobsReadDispatch";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { formatDate as formatLocaleDate } from "@/i18n/formatters";
import { requireUser } from "../shared";
import {
  getLocalDayRange,
  jobsReadOrBlocked,
  roundToTenth,
  type DashboardJobsReadResult,
} from "./shared";

export const getActivityDataForPeriod = async (): Promise<{
  data: any[];
  keys: string[];
}> => {
  try {
    const user = await requireUser();
    // Use local time for date range to match grouping and getLast7Days
    const { start: sevenDaysAgo, end: today } = getLocalDayRange(6);
    const activities = await prisma.activity.findMany({
      where: {
        userId: user.id,
        startTime: {
          gte: sevenDaysAgo,
          lte: today,
        },
      },
      select: {
        startTime: true,
        duration: true,
        activityType: {
          select: {
            label: true,
          },
        },
      },
      orderBy: {
        startTime: "asc",
      },
    });
    const groupedData = activities.reduce((acc: any, activity: any) => {
      // Use local date for grouping to match user's perception
      const activityDate = new Date(activity.startTime);
      const day = format(activityDate, "yyyy-MM-dd");
      const activityTypeLabel = activity.activityType?.label || "Unknown";

      if (!acc[day]) {
        acc[day] = {};
      }

      const durationInHours = (activity.duration || 0) / 60;
      acc[day][activityTypeLabel] =
        (acc[day][activityTypeLabel] || 0) + durationInHours;

      return acc;
    }, {});

    // Cap to the top 3 activity types by total weekly hours, matching the
    // donut card's ranking, and fold the rest into "Other" per day.
    const totalsByLabel: Record<string, number> = {};
    for (const dayTotals of Object.values(groupedData) as Record<
      string,
      number
    >[]) {
      for (const [label, hours] of Object.entries(dayTotals)) {
        totalsByLabel[label] = (totalsByLabel[label] || 0) + hours;
      }
    }
    const topLabels = Object.entries(totalsByLabel)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([label]) => label);
    const hasOther = Object.keys(totalsByLabel).some(
      (label) => !topLabels.includes(label),
    );
    const keys = hasOther ? [...topLabels, OTHER_SLICE_ID] : topLabels;

    const last7Days = getLast7Days("yyyy-MM-dd");
    const data = last7Days.map((dateStr) => {
      const dayTotals: Record<string, number> = groupedData[dateStr] || {};
      const entry: Record<string, any> = {
        day: format(parseISO(dateStr), "EEE, MMM d"),
      };
      for (const label of topLabels) {
        if (dayTotals[label]) entry[label] = dayTotals[label];
      }
      if (hasOther) {
        const otherBreakdown = Object.entries(dayTotals)
          .filter(([label]) => !topLabels.includes(label))
          .map(([label, hours]) => ({ label, hours: roundToTenth(hours) }))
          .filter((entry) => entry.hours > 0)
          .sort((a, b) => b.hours - a.hours);
        const otherHours = otherBreakdown.reduce(
          (sum, entry) => sum + entry.hours,
          0,
        );
        if (otherHours) {
          entry[OTHER_SLICE_ID] = otherHours;
          entry.otherBreakdown = otherBreakdown;
        }
      }
      return entry;
    });

    return { data, keys };
  } catch (error) {
    const msg = "Failed to fetch activities data.";
    console.error(msg, error);
    throw new Error(msg);
  }
};

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

export const getActivityCalendarData = async (): Promise<
  DashboardJobsReadResult<Record<string, any[]>>
> => {
  try {
    const user = await requireUser();
    // Use local time for date range to match grouping
    const { start: daysAgo, end: today } = getLocalDayRange(365);
    const [jobDataResult, activityData] = await Promise.all([
      jobsReadOrBlocked(() =>
        loadJobsAppliedDateCounts(prisma, user.id, {
          start: daysAgo,
          end: today,
        }),
      ),
      prisma.activity.findMany({
        where: {
          userId: user.id,
          startTime: { gte: daysAgo, lte: today },
          duration: { not: null },
        },
        select: { startTime: true, duration: true },
      }),
    ]);

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

    const groupedHours: Record<string, number> = activityData.reduce(
      (acc: Record<string, number>, activity) => {
        const date = format(new Date(activity.startTime), "yyyy-MM-dd");
        acc[date] = (acc[date] || 0) + (activity.duration || 0) / 60;
        return acc;
      },
      {},
    );

    const allDates = new Set([
      ...Object.keys(groupedJobs),
      ...Object.keys(groupedHours),
    ]);

    const groupedByYear = [...allDates].reduce(
      (acc: Record<string, any[]>, date) => {
        const year = date.split("-")[0];
        if (!acc[year]) acc[year] = [];
        acc[year].push({
          day: date,
          value: groupedJobs[date] || 0,
          hours: Math.round((groupedHours[date] || 0) * 10) / 10,
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

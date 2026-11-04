import prisma from "@/lib/db";
import { formatDateOnly } from "@/lib/datetime";
import {
  loadCareerInsights,
  loadDueTaskFollowUps,
  type ApplicationDayCount,
  type InsightBoard,
  type InsightsFamily,
} from "@/lib/career/careerInsightsReadModel";
import type { JobStatusCount } from "@/lib/career/jobsReadDispatch";
import { JOBS_READ_UNAVAILABLE_CODE } from "@/lib/career/jobsReadDispatch";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import { DEFAULT_LOCALE, type Locale } from "@/i18n/config";
import { requireUser } from "../shared";
import { jobsReadOrBlocked } from "./shared";

// CAREER-INSIGHTS dashboard payload (frozen contract §6.1): one action call
// supplies every analytics surface — board totals, trend windows, heatmap and
// status distribution — plus the family-independent M6/M7 partials that a
// blocked jobs family still serves. The account zone is resolved once here
// and passed into the read model (DateTime contract D4).

export type InsightTrendDatum = { day: string; value: number };

export type InsightTrendWindow = {
  days: InsightTrendDatum[];
  /** M3 window total: positions whose first-application day fell inside. */
  total: number;
};

export type InsightFollowUps = {
  total: number;
  overdueCount: number;
  /** D7: blocked families only serve the task half — the UI labels it. */
  tasksOnly: boolean;
};

export type CareerInsightsData = {
  family: InsightsFamily;
  migratedOrigin: boolean;
  awaitingReflectionInterviews: number | null;
  board: InsightBoard;
  statusDistribution: JobStatusCount[];
  trend7: InsightTrendWindow;
  trend30: InsightTrendWindow;
  calendarByYear: Record<string, { day: string; value: number }[]>;
};

export type CareerInsightsPayload =
  | {
      blocked: false;
      code?: never;
      message?: never;
      openTasks: number;
      followUps: InsightFollowUps;
      data: CareerInsightsData;
    }
  | {
      blocked: true;
      code: typeof JOBS_READ_UNAVAILABLE_CODE;
      message: string;
      openTasks: number;
      followUps: InsightFollowUps;
      data?: never;
    };

const OPEN_TASK_STATUSES = ["complete", "cancelled"] as const;

function trendWindow(
  days: ApplicationDayCount[],
  locale: Locale,
): InsightTrendWindow {
  return {
    days: days.map((row) => ({
      // Day labels are calendar facts: formatDateOnly anchors the DateOnly
      // through UTC so the label can never drift off the account-zone day.
      day: formatDateOnly(row.date, locale, {
        year: undefined,
        month: "short",
        day: "numeric",
        weekday: "short",
      }),
      value: row.count,
    })),
    total: days.reduce((sum, row) => sum + row.count, 0),
  };
}

export const getCareerInsights = async (
  locale: Locale = DEFAULT_LOCALE,
): Promise<CareerInsightsPayload> => {
  const user = await requireUser();
  const [timeZone, openTasks] = await Promise.all([
    getUserTimeZone(user.id),
    // M7: unfinished tasks — family-independent, always served.
    prisma.task.count({
      where: { userId: user.id, status: { notIn: [...OPEN_TASK_STATUSES] } },
    }),
  ]);
  const now = new Date();

  const jobsResult = await jobsReadOrBlocked(() =>
    loadCareerInsights(prisma, user.id, { timeZone, now }),
  );

  if (jobsResult.blocked) {
    // D7: the task half of M6 is still real data under a blocked family.
    const tasks = await loadDueTaskFollowUps(prisma, user.id, {
      timeZone,
      now,
    });
    return {
      blocked: true,
      code: jobsResult.code,
      message: jobsResult.message,
      openTasks,
      followUps: { ...tasks, tasksOnly: true },
    };
  }

  const data = jobsResult.data;
  const calendarByYear: CareerInsightsData["calendarByYear"] = {};
  for (const row of data.calendarDays365) {
    const year = row.date.slice(0, 4);
    (calendarByYear[year] ??= []).push({ day: row.date, value: row.count });
  }

  return {
    blocked: false,
    openTasks,
    followUps: {
      total: data.followUps.total,
      overdueCount: data.followUps.overdueCount,
      tasksOnly: false,
    },
    data: {
      family: data.family,
      migratedOrigin: data.migratedOrigin,
      awaitingReflectionInterviews: data.awaitingReflectionInterviews,
      board: data.board,
      statusDistribution: data.statusDistribution,
      trend7: trendWindow(data.trendWindow7, locale),
      trend30: trendWindow(data.trendWindow30, locale),
      calendarByYear,
    },
  };
};


import { addDays, endOfDay } from "date-fns";
import prisma from "@/lib/db";
import {
  loadDashboardJobCounts,
  loadJobsBoardTotals,
  loadJobsExistence,
  loadUpcomingJobDeadlines,
  resolveJobsReadFamily,
} from "@/lib/career/jobsReadDispatch";
import {
  listUpcomingApplicationEvents as queryUpcomingApplicationEvents,
  UPCOMING_EVENT_KIND,
} from "@/lib/career/upcomingReadModel";
import { requireUser } from "../shared";
import { getLocalDayRange, jobsReadOrBlocked } from "./shared";

// The four headline numbers on the overview page. Jobs-family metrics are
// mode-aware through jobsReadOrBlocked: a blocked family reports absent
// fields rather than fabricated zeros, matching the rest of the dashboard.
export type OverviewStats = {
  openTasks: number;
  upcomingActivities: number;
} & (
  | { jobsBlocked: true; inProgress?: never; applied7d?: never }
  | { jobsBlocked: false; inProgress: number; applied7d: number }
);

const OPEN_TASK_STATUSES = ["complete", "cancelled"];

export const getOverviewStats = async (): Promise<OverviewStats> => {
  const user = await requireUser();
  const { start, end } = getLocalDayRange(6);
  const { start: priorStart } = getLocalDayRange(13);
  const now = new Date();
  const next7End = endOfDay(addDays(now, 7));

  const [jobsResult, openTasks, upcomingActivities] = await Promise.all([
    jobsReadOrBlocked(async () => {
      const [totals, window] = await Promise.all([
        loadJobsBoardTotals(prisma, user.id),
        loadDashboardJobCounts(prisma, user.id, { start, end, priorStart }),
      ]);
      return { inProgress: totals.inProgress, applied7d: window.jobsApplied };
    }),
    prisma.task.count({
      where: { userId: user.id, status: { notIn: OPEN_TASK_STATUSES } },
    }),
    prisma.activity.count({
      where: {
        userId: user.id,
        startTime: { gt: now, lte: next7End },
      },
    }),
  ]);

  if (jobsResult.blocked) {
    return { jobsBlocked: true, openTasks, upcomingActivities };
  }
  return {
    jobsBlocked: false,
    inProgress: jobsResult.data.inProgress,
    applied7d: jobsResult.data.applied7d,
    openTasks,
    upcomingActivities,
  };
};

// Adaptive overview state. "empty" is TRUE_EMPTY — the user provably holds
// no personal business records in any tracked domain, so the page offers
// the four starting points instead of an empty feed. "nonempty" is NORMAL.
// "unknown" means emptiness could not be proven (the jobs read family is
// blocked) and the page must degrade to the normal workbench rather than
// guess. Loading and query failures never reach a value here: reads are
// awaited before the page renders and errors propagate to the boundary, so
// neither can masquerade as a fresh user.
export type OverviewDataState = "empty" | "nonempty" | "unknown";

// Existence checks mirror the overview's tracked domains (positions, tasks,
// activities, interview questions and sessions) — not the four metrics.
// History counts: an archived position, a completed task, a past activity or
// a practice session all mean the user has started, even when every headline
// metric reads 0. Question rows installed from preset banks carry
// presetBankKey and are not the user's own records; soft-deleted questions
// are no longer records either.
export const getOverviewDataState = async (): Promise<OverviewDataState> => {
  const user = await requireUser();
  const [jobsResult, tasks, activities, questions, sessions] =
    await Promise.all([
      jobsReadOrBlocked(() => loadJobsExistence(prisma, user.id)),
      prisma.task.count({ where: { userId: user.id } }),
      prisma.activity.count({ where: { userId: user.id } }),
      prisma.question.count({
        where: { createdBy: user.id, presetBankKey: null, deletedAt: null },
      }),
      prisma.interviewSession.count({ where: { userId: user.id } }),
    ]);

  if (tasks > 0 || activities > 0 || questions > 0 || sessions > 0) {
    return "nonempty";
  }
  if (jobsResult.blocked) {
    return "unknown";
  }
  return jobsResult.data > 0 ? "nonempty" : "empty";
};

// A single lightweight reminder row. `kind` drives the icon/link target;
// `at` is ISO so the client formats it with the active locale.
export type OverviewReminder = {
  id: string;
  kind: "task" | "deadline" | "step";
  title: string;
  detail?: string;
  at: string;
  href: string;
  overdue: boolean;
};

const REMINDER_LIMIT = 6;

// Conditional strip shown only when something concrete is due: soon-due
// tasks in every mode, plus application deadlines (legacy Job.dueDate) or
// upcoming process steps (A+B) inside the same window.
export const getOverviewReminders = async (): Promise<OverviewReminder[]> => {
  const user = await requireUser();
  const now = new Date();
  const next7End = endOfDay(addDays(now, 7));

  const [dueTasks, familyResult] = await Promise.all([
    prisma.task.findMany({
      where: {
        userId: user.id,
        status: { notIn: OPEN_TASK_STATUSES },
        dueDate: { not: null, lte: next7End },
      },
      select: { id: true, title: true, dueDate: true },
      orderBy: { dueDate: "asc" },
      take: REMINDER_LIMIT,
    }),
    resolveJobsReadFamily(prisma),
  ]);

  const reminders: OverviewReminder[] = dueTasks.flatMap((task) =>
    task.dueDate
      ? [
          {
            id: `task:${task.id}`,
            kind: "task" as const,
            title: task.title,
            at: task.dueDate.toISOString(),
            href: "/dashboard/tasks",
            overdue: task.dueDate < now,
          },
        ]
      : [],
  );

  if (familyResult.family === "ab") {
    const events = await queryUpcomingApplicationEvents(prisma, user.id);
    for (const event of events) {
      const attention = new Date(event.attentionAt);
      if (attention > next7End) continue;
      reminders.push({
        id: `event:${event.processStepId ?? event.jobOpportunityId}`,
        kind: event.kind === UPCOMING_EVENT_KIND.APPLICATION_DEADLINE ? "deadline" : "step",
        title: event.roleTitle,
        detail: event.companyName ?? undefined,
        at: event.attentionAt,
        href: `/dashboard/myjobs/${event.jobOpportunityId}`,
        overdue: attention < now,
      });
    }
  } else if (familyResult.family === "legacy") {
    const deadlines = await loadUpcomingJobDeadlines(prisma, user.id, {
      start: now,
      end: next7End,
    });
    for (const job of deadlines) {
      reminders.push({
        id: `deadline:${job.id}`,
        kind: "deadline",
        title: job.title,
        detail: job.company ?? undefined,
        at: job.dueDate.toISOString(),
        href: `/dashboard/myjobs/${job.id}`,
        overdue: job.dueDate < now,
      });
    }
  }

  return reminders
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(0, REMINDER_LIMIT);
};

import prisma from "@/lib/db";
import {
  addDaysToDateOnly,
  businessTimeAttentionIso,
  businessTimeFromColumns,
  dateOnlyUtcWindow,
  isDeadlineOverdue,
  todayDateOnly,
} from "@/lib/datetime";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import {
  loadDashboardJobCounts,
  loadJobsBoardTotals,
  loadJobsExistence,
  loadUpcomingJobDeadlines,
  resolveJobsReadFamily,
} from "@/lib/career/jobsReadDispatch";
import {
  isUpcomingOverdue,
  listUpcomingApplicationEvents as queryUpcomingApplicationEvents,
  UPCOMING_EVENT_KIND,
} from "@/lib/career/upcomingReadModel";
import { requireUser } from "../shared";
import { getLocalDayRange, jobsReadOrBlocked } from "./shared";

// The headline numbers on the overview page. Jobs-family metrics are
// mode-aware through jobsReadOrBlocked: a blocked family reports absent
// fields rather than fabricated zeros, matching the rest of the dashboard.
export type OverviewStats = {
  openTasks: number;
} & (
  | { jobsBlocked: true; inProgress?: never; applied7d?: never }
  | { jobsBlocked: false; inProgress: number; applied7d: number }
);

const OPEN_TASK_STATUSES = ["complete", "cancelled"];

export const getOverviewStats = async (): Promise<OverviewStats> => {
  const user = await requireUser();
  const { start, end } = getLocalDayRange(6);
  const { start: priorStart } = getLocalDayRange(13);

  const [jobsResult, openTasks] = await Promise.all([
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
  ]);

  if (jobsResult.blocked) {
    return { jobsBlocked: true, openTasks };
  }
  return {
    jobsBlocked: false,
    inProgress: jobsResult.data.inProgress,
    applied7d: jobsResult.data.applied7d,
    openTasks,
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
// interview questions and sessions) — not the four metrics.
// History counts: an archived position, a completed task or a practice
// session all mean the user has started, even when every headline metric
// reads 0. Question rows installed from preset banks carry presetBankKey
// and are not the user's own records; soft-deleted questions are no longer
// records either.
export const getOverviewDataState = async (): Promise<OverviewDataState> => {
  const user = await requireUser();
  const [jobsResult, tasks, questions, sessions] = await Promise.all([
    jobsReadOrBlocked(() => loadJobsExistence(prisma, user.id)),
    prisma.task.count({ where: { userId: user.id } }),
    prisma.question.count({
      where: { createdBy: user.id, presetBankKey: null, deletedAt: null },
    }),
    prisma.interviewSession.count({ where: { userId: user.id } }),
  ]);

  if (tasks > 0 || questions > 0 || sessions > 0) {
    return "nonempty";
  }
  if (jobsResult.blocked) {
    return "unknown";
  }
  return jobsResult.data > 0 ? "nonempty" : "empty";
};

// A single lightweight reminder row. `kind` drives the icon/link target;
// `at` is the attention instant (a DateOnly fact carries its day-start ISO
// for sorting) and `dateOn` marks a calendar-day fact the client renders
// with formatDateOnly — never as an instant.
export type OverviewReminder = {
  id: string;
  kind: "task" | "deadline" | "step";
  title: string;
  detail?: string;
  at: string;
  dateOn: string | null;
  href: string;
  overdue: boolean;
};

export type OverviewRemindersData = {
  reminders: OverviewReminder[];
  timeZone: string;
};

const REMINDER_LIMIT = 6;

/** Exclusive end of the account-zone "next 7 days" window as an ISO. */
function next7EndIso(now: Date, timeZone: string): string {
  return dateOnlyUtcWindow(
    addDaysToDateOnly(todayDateOnly(timeZone, now), 7),
    timeZone,
  ).endIsoExclusive;
}

// Conditional strip shown only when something concrete is due: soon-due
// tasks in every mode, plus application deadlines (legacy Job.dueDate) or
// upcoming process steps (A+B) inside the same window. DateOnly facts join
// by intersection with [now, next7End) — a due date still inside today is
// due, and yesterday's stays visible as overdue.
export const getOverviewReminders =
  async (): Promise<OverviewRemindersData> => {
    const user = await requireUser();
    const now = new Date();
    const timeZone = await getUserTimeZone(user.id);
    const next7EndIsoValue = next7EndIso(now, timeZone);
    const next7End = new Date(next7EndIsoValue);
    const next7EndOn = addDaysToDateOnly(todayDateOnly(timeZone, now), 7);

    const [dueTasks, familyResult] = await Promise.all([
      prisma.task.findMany({
        where: {
          userId: user.id,
          status: { notIn: OPEN_TASK_STATUSES },
          OR: [
            { dueDate: { not: null, lte: next7End } },
            { dueOn: { not: null, lte: next7EndOn } },
          ],
        },
        select: {
          id: true,
          title: true,
          dueDate: true,
          dueOn: true,
          duePrecision: true,
        },
        // Both DateOnly and instant tasks must participate before the shared
        // attention sort and limit below; dueDate alone puts every DateOnly
        // ahead of timed tasks regardless of their actual due day.
      }),
      resolveJobsReadFamily(prisma),
    ]);

    const reminders: OverviewReminder[] = dueTasks.flatMap((task) => {
      const value = businessTimeFromColumns({
        dateOnly: task.dueOn,
        instant: task.dueDate,
        precision: task.duePrecision,
      });
      const attention = businessTimeAttentionIso(value, timeZone);
      if (value === null || attention === null) return [];
      return [
        {
          id: `task:${task.id}`,
          kind: "task" as const,
          title: task.title,
          at: attention,
          dateOn: value.kind === "dateOnly" ? value.date : null,
          href: "/dashboard/tasks",
          overdue: isDeadlineOverdue(value, now, timeZone),
        },
      ];
    });

    if (familyResult.family === "ab") {
      const { events } = await queryUpcomingApplicationEvents(
        prisma,
        user.id,
        timeZone,
      );
      for (const event of events) {
        if (event.attentionAt >= next7EndIsoValue) continue;
        reminders.push({
          id: `event:${event.processStepId ?? event.jobOpportunityId}`,
          kind:
            event.kind === UPCOMING_EVENT_KIND.APPLICATION_DEADLINE
              ? "deadline"
              : "step",
          title: event.roleTitle,
          detail: event.companyName ?? undefined,
          at: event.attentionAt,
          // A step can have both a scheduled instant and a DateOnly deadline.
          // Label the same carrier that supplied attentionAt, not a later date.
          dateOn:
            event.deadlineOn &&
            dateOnlyUtcWindow(event.deadlineOn, timeZone).startIso ===
              event.attentionAt
              ? event.deadlineOn
              : null,
          href: `/dashboard/myjobs/${event.jobOpportunityId}`,
          overdue: isUpcomingOverdue(event, now, timeZone),
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
          dateOn: null,
          href: `/dashboard/myjobs/${job.id}`,
          overdue: job.dueDate < now,
        });
      }
    }

    reminders.sort((a, b) => a.at.localeCompare(b.at));
    return { reminders: reminders.slice(0, REMINDER_LIMIT), timeZone };
  };

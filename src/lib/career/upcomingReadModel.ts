import type { PrismaClient } from "@prisma/client";
import {
  addDaysToDateOnly,
  businessTimeAttentionIso,
  businessTimeFromColumns,
  dateOnlyUtcWindow,
  isDeadlineOverdue,
  requireInstantIso,
  toInstantIso,
  todayDateOnly,
  type BusinessTimeValue,
} from "@/lib/datetime";
import { ATTEMPT_OUTCOME, OPPORTUNITY_STATUS, PROCESS_STEP_STATUS } from "./identities";
import { APPLIED_ATTEMPT_WHERE } from "./applicationFact";
import { declaredStepPrecision, toIso } from "./applicationTimeline";

export const UPCOMING_EVENT_KIND = {
  APPLICATION_DEADLINE: "APPLICATION_DEADLINE",
  PROCESS_STEP: "PROCESS_STEP",
} as const;

export type UpcomingEventKind =
  (typeof UPCOMING_EVENT_KIND)[keyof typeof UPCOMING_EVENT_KIND];

export type UpcomingApplicationEvent = {
  kind: UpcomingEventKind;
  jobOpportunityId: string;
  companyName: string | null;
  roleTitle: string;
  applicationAttemptId: string | null;
  processStepId: string | null;
  category: string | null;
  label: string;
  stepStatus: string | null;
  scheduledAt: string | null;
  scheduledAtPrecision: "minute" | "unknown" | null;
  scheduledAtZone: string | null;
  deadlineOn: string | null;
  deadlineAt: string | null;
  deadlinePrecision: "dateOnly" | "minute" | "fullInstant" | "unknown" | null;
  deadlineZone: string | null;
  attentionAt: string;
};

/** Frozen contract envelope: events plus the account zone every consumer
 *  must bucket and render against — never the host zone. */
export type UpcomingApplicationEventsEnvelope = {
  events: UpcomingApplicationEvent[];
  timeZone: string;
};

export const UPCOMING_BUCKET_ID = {
  overdue: "overdue",
  today: "today",
  next7Days: "next7Days",
  later: "later",
} as const;

export type UpcomingBucketId =
  (typeof UPCOMING_BUCKET_ID)[keyof typeof UPCOMING_BUCKET_ID];

export type UpcomingBucket = {
  id: UpcomingBucketId;
  events: UpcomingApplicationEvent[];
};

function earlierIso(a: string | null, b: string | null): string | null {
  if (a && b) return a <= b ? a : b;
  return a ?? b;
}

function stableUpcomingId(event: UpcomingApplicationEvent): string {
  return event.processStepId ?? event.jobOpportunityId;
}

export function compareUpcomingEvents(
  a: UpcomingApplicationEvent,
  b: UpcomingApplicationEvent,
): number {
  const byAttention = a.attentionAt.localeCompare(b.attentionAt);
  if (byAttention !== 0) return byAttention;
  const byKind = a.kind.localeCompare(b.kind);
  if (byKind !== 0) return byKind;
  return stableUpcomingId(a).localeCompare(stableUpcomingId(b));
}

function eventDeadlineValue(
  event: UpcomingApplicationEvent,
): BusinessTimeValue | null {
  return businessTimeFromColumns({
    dateOnly: event.deadlineOn,
    instant: event.deadlineAt,
    precision: event.deadlinePrecision,
  });
}

export function isUpcomingOverdue(
  event: UpcomingApplicationEvent,
  now: Date,
  timeZone: string,
): boolean {
  const deadline = eventDeadlineValue(event);
  if (deadline !== null) {
    return isDeadlineOverdue(deadline, now, timeZone);
  }
  return event.scheduledAt != null && new Date(event.scheduledAt) < now;
}

/**
 * Buckets follow the account-zone calendar: "today" and "next 7 days" are
 * `[local midnight, local midnight)` windows in `timeZone`, not the host
 * clock's endOfDay/addDays.
 */
export function bucketUpcomingApplicationEvents(
  events: UpcomingApplicationEvent[],
  now: Date,
  timeZone: string,
): UpcomingBucket[] {
  const today = todayDateOnly(timeZone, now);
  const endToday = dateOnlyUtcWindow(today, timeZone).endIsoExclusive;
  const endNext7 = dateOnlyUtcWindow(
    addDaysToDateOnly(today, 7),
    timeZone,
  ).endIsoExclusive;
  const overdue: UpcomingApplicationEvent[] = [];
  const todayEvents: UpcomingApplicationEvent[] = [];
  const next7Days: UpcomingApplicationEvent[] = [];
  const later: UpcomingApplicationEvent[] = [];

  for (const event of events) {
    if (isUpcomingOverdue(event, now, timeZone)) {
      overdue.push(event);
      continue;
    }
    if (event.attentionAt < endToday) {
      todayEvents.push(event);
    } else if (event.attentionAt < endNext7) {
      next7Days.push(event);
    } else {
      later.push(event);
    }
  }

  return (
    [
      { id: UPCOMING_BUCKET_ID.overdue, events: overdue },
      { id: UPCOMING_BUCKET_ID.today, events: todayEvents },
      { id: UPCOMING_BUCKET_ID.next7Days, events: next7Days },
      { id: UPCOMING_BUCKET_ID.later, events: later },
    ] satisfies UpcomingBucket[]
  ).filter((bucket) => bucket.events.length > 0);
}

function opportunityDeadlineValue(row: {
  deadline: Date | null;
  deadlineOn: string | null;
  deadlinePrecision: string | null;
}): BusinessTimeValue | null {
  return businessTimeFromColumns({
    dateOnly: row.deadlineOn,
    instant: row.deadline,
    precision: row.deadlinePrecision,
  });
}

/**
 * Caller resolves the account zone once (getUserTimeZone at the action
 * boundary); the read model never falls back to the host zone.
 */
export async function listUpcomingApplicationEvents(
  db: PrismaClient,
  userId: string,
  timeZone: string,
): Promise<UpcomingApplicationEventsEnvelope> {
  const [deadlines, steps] = await Promise.all([
    db.jobOpportunity.findMany({
      where: {
        userId,
        archivedAt: null,
        OR: [{ deadline: { not: null } }, { deadlineOn: { not: null } }],
        status: {
          in: [OPPORTUNITY_STATUS.ACTIVE, OPPORTUNITY_STATUS.UNKNOWN],
        },
        // The deadline prompt is meaningful only while the position is not
        // yet applied — the shared ever-applied fact: a submitted OR
        // post-DRAFT live attempt suppresses it, a draft does not.
        applicationAttempts: {
          none: APPLIED_ATTEMPT_WHERE,
        },
      },
      select: {
        id: true,
        title: true,
        deadline: true,
        deadlineOn: true,
        deadlinePrecision: true,
        company: { select: { label: true } },
      },
    }),
    db.applicationProcessStep.findMany({
      where: {
        status: {
          notIn: [
            PROCESS_STEP_STATUS.COMPLETED,
            PROCESS_STEP_STATUS.CANCELLED,
          ],
        },
        completedAt: null,
        OR: [
          { scheduledAt: { not: null } },
          { deadlineAt: { not: null } },
          { deadlineOn: { not: null } },
        ],
        applicationAttempt: {
          userId,
          archivedAt: null,
          outcome: { in: [ATTEMPT_OUTCOME.ACTIVE, ATTEMPT_OUTCOME.OFFER] },
          jobOpportunity: { archivedAt: null },
        },
      },
      select: {
        id: true,
        category: true,
        label: true,
        status: true,
        scheduledAt: true,
        scheduledAtPrecision: true,
        scheduledAtZone: true,
        deadlineAt: true,
        deadlineOn: true,
        deadlinePrecision: true,
        deadlineZone: true,
        applicationAttempt: {
          select: {
            id: true,
            jobOpportunity: {
              select: {
                id: true,
                title: true,
                company: { select: { label: true } },
              },
            },
          },
        },
      },
    }),
  ]);

  const events: UpcomingApplicationEvent[] = [
    ...deadlines.flatMap((opportunity) => {
      const value = opportunityDeadlineValue(opportunity);
      const attention = businessTimeAttentionIso(value, timeZone);
      if (value === null || attention === null) return [];
      return [
        {
          kind: UPCOMING_EVENT_KIND.APPLICATION_DEADLINE,
          jobOpportunityId: opportunity.id,
          companyName: opportunity.company.label,
          roleTitle: opportunity.title,
          applicationAttemptId: null,
          processStepId: null,
          category: null,
          label: UPCOMING_EVENT_KIND.APPLICATION_DEADLINE,
          stepStatus: null,
          scheduledAt: null,
          scheduledAtPrecision: null,
          scheduledAtZone: null,
          deadlineOn: value.kind === "dateOnly" ? value.date : null,
          deadlineAt:
            value.kind === "instant" ? value.iso : toIso(opportunity.deadline),
          deadlinePrecision:
            value.kind === "dateOnly"
              ? "dateOnly"
              : value.kind === "instant"
                ? value.precision
                : null,
          deadlineZone: null,
          attentionAt: requireInstantIso(attention),
        } satisfies UpcomingApplicationEvent,
      ];
    }),
    ...steps.flatMap((step) => {
      const deadlineValue = businessTimeFromColumns({
        dateOnly: step.deadlineOn,
        instant: step.deadlineAt,
        precision: step.deadlinePrecision,
      });
      const scheduledIso = toIso(step.scheduledAt);
      const deadlineAttention = businessTimeAttentionIso(
        deadlineValue,
        timeZone,
      );
      const attention = earlierIso(
        scheduledIso,
        deadlineAttention,
      );
      if (attention === null) return [];
      return [
        {
          kind: UPCOMING_EVENT_KIND.PROCESS_STEP,
          jobOpportunityId: step.applicationAttempt.jobOpportunity.id,
          companyName: step.applicationAttempt.jobOpportunity.company.label,
          roleTitle: step.applicationAttempt.jobOpportunity.title,
          applicationAttemptId: step.applicationAttempt.id,
          processStepId: step.id,
          category: step.category,
          label: step.label,
          stepStatus: step.status,
          scheduledAt: scheduledIso,
          scheduledAtPrecision: declaredStepPrecision(
            step.scheduledAtPrecision,
            step.scheduledAt !== null,
            ["minute"],
          ),
          scheduledAtZone: step.scheduledAtZone,
          deadlineOn:
            deadlineValue?.kind === "dateOnly" ? deadlineValue.date : null,
          deadlineAt:
            deadlineValue?.kind === "instant"
              ? deadlineValue.iso
              : toIso(step.deadlineAt),
          deadlinePrecision:
            deadlineValue === null
              ? null
              : deadlineValue.kind === "dateOnly"
                ? "dateOnly"
                : deadlineValue.precision,
          deadlineZone: step.deadlineZone,
          attentionAt: requireInstantIso(attention),
        } satisfies UpcomingApplicationEvent,
      ];
    }),
  ];

  return { events: events.sort(compareUpcomingEvents), timeZone };
}

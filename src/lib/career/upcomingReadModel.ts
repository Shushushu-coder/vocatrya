import type { PrismaClient } from "@prisma/client";
import { addDays, endOfDay } from "date-fns";
import { ATTEMPT_OUTCOME, OPPORTUNITY_STATUS, PROCESS_STEP_STATUS } from "./identities";
import { APPLIED_ATTEMPT_WHERE } from "./applicationFact";
import { toIso } from "./applicationTimeline";

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
  deadlineAt: string | null;
  attentionAt: string;
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

function earlierIso(a: Date | null, b: Date | null): string {
  if (a && b) {
    return (a.getTime() <= b.getTime() ? a : b).toISOString();
  }
  return (a ?? b)!.toISOString();
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

export function isUpcomingOverdue(
  event: UpcomingApplicationEvent,
  now: Date,
): boolean {
  if (event.kind === UPCOMING_EVENT_KIND.APPLICATION_DEADLINE) {
    return event.deadlineAt != null && new Date(event.deadlineAt) < now;
  }
  if (event.deadlineAt) {
    return new Date(event.deadlineAt) < now;
  }
  return event.scheduledAt != null && new Date(event.scheduledAt) < now;
}

export function bucketUpcomingApplicationEvents(
  events: UpcomingApplicationEvent[],
  now: Date = new Date(),
): UpcomingBucket[] {
  const endToday = endOfDay(now);
  const endNext7 = endOfDay(addDays(now, 7));
  const overdue: UpcomingApplicationEvent[] = [];
  const today: UpcomingApplicationEvent[] = [];
  const next7Days: UpcomingApplicationEvent[] = [];
  const later: UpcomingApplicationEvent[] = [];

  for (const event of events) {
    if (isUpcomingOverdue(event, now)) {
      overdue.push(event);
      continue;
    }
    const attention = new Date(event.attentionAt);
    if (attention <= endToday) {
      today.push(event);
    } else if (attention <= endNext7) {
      next7Days.push(event);
    } else {
      later.push(event);
    }
  }

  return (
    [
      { id: UPCOMING_BUCKET_ID.overdue, events: overdue },
      { id: UPCOMING_BUCKET_ID.today, events: today },
      { id: UPCOMING_BUCKET_ID.next7Days, events: next7Days },
      { id: UPCOMING_BUCKET_ID.later, events: later },
    ] satisfies UpcomingBucket[]
  ).filter((bucket) => bucket.events.length > 0);
}

export async function listUpcomingApplicationEvents(
  db: PrismaClient,
  userId: string,
): Promise<UpcomingApplicationEvent[]> {
  const [deadlines, steps] = await Promise.all([
    db.jobOpportunity.findMany({
      where: {
        userId,
        archivedAt: null,
        deadline: { not: null },
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
        company: { select: { label: true } },
      },
    }),
    db.applicationProcessStep.findMany({
      where: {
        status: { not: PROCESS_STEP_STATUS.COMPLETED },
        completedAt: null,
        OR: [{ scheduledAt: { not: null } }, { deadlineAt: { not: null } }],
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
        deadlineAt: true,
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
      if (!opportunity.deadline) return [];
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
          deadlineAt: toIso(opportunity.deadline),
          attentionAt: opportunity.deadline.toISOString(),
        } satisfies UpcomingApplicationEvent,
      ];
    }),
    ...steps.map((step) => ({
      kind: UPCOMING_EVENT_KIND.PROCESS_STEP,
      jobOpportunityId: step.applicationAttempt.jobOpportunity.id,
      companyName: step.applicationAttempt.jobOpportunity.company.label,
      roleTitle: step.applicationAttempt.jobOpportunity.title,
      applicationAttemptId: step.applicationAttempt.id,
      processStepId: step.id,
      category: step.category,
      label: step.label,
      stepStatus: step.status,
      scheduledAt: toIso(step.scheduledAt),
      deadlineAt: toIso(step.deadlineAt),
      attentionAt: earlierIso(step.scheduledAt, step.deadlineAt),
    })),
  ];

  return events.sort(compareUpcomingEvents);
}

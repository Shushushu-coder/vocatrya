import type { Prisma, PrismaClient } from "@prisma/client";
import {
  addDaysToDateOnly,
  dateOnlyUtcWindow,
  todayDateOnly,
} from "@/lib/datetime";
import { APPLIED_ATTEMPT_WHERE, isAppliedAttempt } from "./applicationFact";
import { PROCESS_STEP_CATEGORY } from "./identities";
import type { JobsReadFamily } from "./jobsReadDispatch";
import type { ResumeReadFamily } from "./resumeReadDispatch";
import { deriveUiStatus, pickLatestAttempt } from "./uiStatus";
import {
  isUpcomingOverdue,
  listUpcomingApplicationEvents,
  UPCOMING_EVENT_KIND,
} from "./upcomingReadModel";

// NEXT-ACTIONS deterministic suggestions (frozen contract §4). Pure read
// model: no AI calls, no writes, no fabricated state — a gated-out or
// unreadable family simply emits no candidates for its rules.
//
// Rule map: R1 resume materials, R2 AI not configured, R3 no position /
// none applied, R4 active position without a resume variant, R5 upcoming or
// past-scheduled real interview, R6 completed interview awaiting debrief,
// R7 broken AI assignment.
//
// R6 stays silent until the INTERVIEW-DEBRIEF §7.3
// listAwaitingReflectionInterviews read model lands: the frozen contract
// (§4.2/§4.7) forbids content-presence substitutes, and the awaiting-
// reflection predicate belongs to that domain. The slot is marked below in
// priority order so wiring it later changes nothing else here.

import {
  NEXT_ACTION_LIMIT,
  NEXT_ACTION_RULE,
  type NextActionItem,
  type NextActionRuleId,
} from "./nextActionsContract";

export {
  NEXT_ACTION_LIMIT,
  NEXT_ACTION_RULE,
} from "./nextActionsContract";
export type {
  NextActionItem,
  NextActionRuleId,
  NextActionVariant,
} from "./nextActionsContract";

// Frozen priority (§4.3): time-sensitive interviews first, optional AI
// guidance last. R6 reserves its place ahead of R4 for when the domain read
// model exists.
const RULE_PRIORITY: NextActionRuleId[] = [
  NEXT_ACTION_RULE.R5,
  NEXT_ACTION_RULE.R6,
  NEXT_ACTION_RULE.R4,
  NEXT_ACTION_RULE.R3,
  NEXT_ACTION_RULE.R1,
  NEXT_ACTION_RULE.R7,
  NEXT_ACTION_RULE.R2,
];

export type NextActionsQueryInput = {
  jobsFamily: JobsReadFamily;
  resumeFamily: ResumeReadFamily;
  /** Decides the R3 no-positions href (add-job deep link vs plain list). */
  jobMutationsEnabled: boolean;
  /** Stored-state resolution of the CAREER_DIALOGUE purpose (§9 D2). */
  aiConfigStatus:
    | "RESOLVED"
    | "NOT_CONFIGURED"
    | "INVALID_ASSIGNMENT"
    | "LEGACY_INTERVIEW_CONFIG";
  /** Account zone — every window/overdue decision uses it, never the host. */
  timeZone: string;
  /** Injectable for tests; defaults to the current instant. */
  now?: Date;
};

// Mirrors AB_TERMINAL_UI_STATUSES in jobsReadDispatch: derived uiStatus
// values where the position is concluded and must not drive suggestions.
const TERMINAL_UI_STATUSES = new Set([
  "archived",
  "expired",
  "rejected",
  "offer-accepted",
  "offer-declined",
  "transferred",
]);

// Legacy positions hidden from every surface: archived status rows and
// dismissed automation discoveries. R3's "no positions" predicate follows
// the visible surface, not the raw row count (frozen §9 D8 — the
// all-rows loadJobsExistence exists for data-state, not for suggestions).
const LEGACY_VISIBLE_JOB_WHERE = {
  Status: { value: { notIn: ["archived"] } },
  AND: [
    { OR: [{ discoveryStatus: null }, { discoveryStatus: { not: "dismissed" } }] },
  ],
} satisfies Prisma.JobWhereInput;

function makeItem(
  partial: Omit<NextActionItem, "id">,
): NextActionItem {
  return { ...partial, id: `${partial.ruleId}:${partial.entityKey}` };
}

// R5 — real interviews in the upcoming-events window (attentionAt < +7d in
// the account zone) or already overdue. Overdue-and-unfinished is only a
// "confirm the status" hint (frozen §9 D3), never an awaiting-debrief claim.
async function upcomingInterviewActions(
  db: PrismaClient,
  userId: string,
  timeZone: string,
  now: Date,
): Promise<NextActionItem[]> {
  const { events } = await listUpcomingApplicationEvents(db, userId, timeZone);
  const next7End = dateOnlyUtcWindow(
    addDaysToDateOnly(todayDateOnly(timeZone, now), 7),
    timeZone,
  ).endIsoExclusive;

  const items: NextActionItem[] = [];
  for (const event of events) {
    if (
      event.kind !== UPCOMING_EVENT_KIND.PROCESS_STEP ||
      event.category !== PROCESS_STEP_CATEGORY.INTERVIEW ||
      event.processStepId === null
    ) {
      continue;
    }
    const overdue = isUpcomingOverdue(event, now, timeZone);
    if (!overdue && event.attentionAt >= next7End) continue;
    items.push(
      makeItem({
        ruleId: NEXT_ACTION_RULE.R5,
        entityKey: event.processStepId,
        variant: overdue ? "confirmStatus" : "prepare",
        href: `/dashboard/myjobs/${event.jobOpportunityId}?tab=timeline`,
        jobTitle: event.roleTitle,
        companyName: event.companyName,
        stepLabel: event.label,
        attentionAt: event.attentionAt,
        // Same carrier labeling as getOverviewReminders: dateOn only when the
        // DateOnly deadline is what produced attentionAt.
        dateOn:
          event.deadlineOn &&
          dateOnlyUtcWindow(event.deadlineOn, timeZone).startIso ===
            event.attentionAt
            ? event.deadlineOn
            : null,
        overdue,
      }),
    );
  }
  // The read model already sorted by attentionAt/kind/stable id — the
  // contract's "R5 by event time ascending".
  return items;
}

// R4 — active (unarchived, non-terminal, never applied) positions with no
// live resume variant bound to them (frozen §9 D9 candidate set).
async function unboundPositionActions(
  db: PrismaClient,
  userId: string,
): Promise<NextActionItem[]> {
  const opportunities = await db.jobOpportunity.findMany({
    where: {
      userId,
      archivedAt: null,
      targetedResumeVariants: { none: { archivedAt: null } },
    },
    select: {
      id: true,
      title: true,
      status: true,
      archivedAt: true,
      company: { select: { label: true } },
      applicationAttempts: {
        where: { archivedAt: null },
        select: {
          id: true,
          currentStageCategory: true,
          outcome: true,
          submittedAt: true,
          createdAt: true,
        },
      },
    },
  });

  return opportunities
    .filter(
      (opportunity) =>
        !opportunity.applicationAttempts.some(isAppliedAttempt) &&
        !TERMINAL_UI_STATUSES.has(
          deriveUiStatus({
            archivedAt: opportunity.archivedAt,
            opportunityStatus: opportunity.status,
            attempt: pickLatestAttempt(opportunity.applicationAttempts),
          }),
        ),
    )
    // Same-rule ordering is the stable entity id (frozen §4.3).
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((opportunity) =>
      makeItem({
        ruleId: NEXT_ACTION_RULE.R4,
        entityKey: opportunity.id,
        variant: "default",
        href: "/dashboard/profile/resumes",
        jobTitle: opportunity.title,
        companyName: opportunity.company.label,
      }),
    );
}

// R3 — no unarchived positions at all, or positions without a single applied
// record. Family-specific predicates (frozen §9 D8): ab counts unarchived
// JobOpportunity rows and the shared APPLIED_ATTEMPT_WHERE fact; legacy
// counts visible Job rows and the `applied` flag. Blocked stays silent.
async function jobRecordActions(
  db: PrismaClient,
  userId: string,
  input: NextActionsQueryInput,
): Promise<NextActionItem[]> {
  const addJobHref = input.jobMutationsEnabled
    ? "/dashboard/myjobs?add-job=true"
    : "/dashboard/myjobs";

  if (input.jobsFamily === "ab") {
    const positions = await db.jobOpportunity.count({
      where: { userId, archivedAt: null },
    });
    if (positions === 0) {
      return [
        makeItem({
          ruleId: NEXT_ACTION_RULE.R3,
          entityKey: "account",
          variant: "noJobs",
          href: addJobHref,
        }),
      ];
    }
    // "Ever applied" is a global fact (frozen §4.2): an archived
    // opportunity's submission still happened, matching
    // attemptInRangeWhere's archived-parent treatment — so no
    // jobOpportunity.archivedAt filter here.
    const applied = await db.applicationAttempt.count({
      where: { userId, ...APPLIED_ATTEMPT_WHERE },
    });
    return applied === 0
      ? [
          makeItem({
            ruleId: NEXT_ACTION_RULE.R3,
            entityKey: "account",
            variant: "unapplied",
            href: "/dashboard/myjobs",
          }),
        ]
      : [];
  }

  if (input.jobsFamily === "legacy") {
    const positions = await db.job.count({
      where: { userId, ...LEGACY_VISIBLE_JOB_WHERE },
    });
    if (positions === 0) {
      return [
        makeItem({
          ruleId: NEXT_ACTION_RULE.R3,
          entityKey: "account",
          variant: "noJobs",
          href: addJobHref,
        }),
      ];
    }
    // Same global-fact scope as the ab branch: applied=true on an archived
    // or dismissed row still means the user recorded a submission.
    const applied = await db.job.count({
      where: { userId, applied: true },
    });
    return applied === 0
      ? [
          makeItem({
            ruleId: NEXT_ACTION_RULE.R3,
            entityKey: "account",
            variant: "unappliedLegacy",
            href: "/dashboard/myjobs",
          }),
        ]
      : [];
  }

  return [];
}

// R1 — nothing to build a resume from. ab: zero unarchived
// CareerMaterialItem AND zero unarchived ResumeVariant; legacy: zero Resume
// rows. A blocked resume family cannot judge and emits nothing.
async function resumeRecordActions(
  db: PrismaClient,
  userId: string,
  family: ResumeReadFamily,
): Promise<NextActionItem[]> {
  const item = () =>
    makeItem({
      ruleId: NEXT_ACTION_RULE.R1,
      entityKey: "account",
      variant: "default",
      href: "/dashboard/profile",
    });

  if (family === "ab") {
    const [materials, variants] = await Promise.all([
      db.careerMaterialItem.count({
        where: { userId, archivedAt: null },
      }),
      db.resumeVariant.count({ where: { userId, archivedAt: null } }),
    ]);
    return materials + variants === 0 ? [item()] : [];
  }
  if (family === "legacy") {
    const resumes = await db.resume.count({
      where: { profile: { userId } },
    });
    return resumes === 0 ? [item()] : [];
  }
  return [];
}

// R2/R7 — mutually exclusive by construction: one stored-state resolution
// per purpose, NOT_CONFIGURED → R2 (optional setup), INVALID_ASSIGNMENT →
// R7 (repair). RESOLVED and the INTERVIEW-only legacy fallback stay silent.
function aiConfigActions(input: NextActionsQueryInput): NextActionItem[] {
  const href = "/dashboard/settings?section=ai-services";
  if (input.aiConfigStatus === "INVALID_ASSIGNMENT") {
    return [
      makeItem({
        ruleId: NEXT_ACTION_RULE.R7,
        entityKey: "account",
        variant: "default",
        href,
      }),
    ];
  }
  if (input.aiConfigStatus === "NOT_CONFIGURED") {
    return [
      makeItem({
        ruleId: NEXT_ACTION_RULE.R2,
        entityKey: "account",
        variant: "default",
        href,
      }),
    ];
  }
  return [];
}

// Full ordered candidate list after family gating and rule+entity dedup —
// uncapped, so callers can report the true "+N" remainder.
export async function listNextActionCandidates(
  db: PrismaClient,
  userId: string,
  input: NextActionsQueryInput,
): Promise<NextActionItem[]> {
  const now = input.now ?? new Date();
  const [r5, r4, r3, r1] = await Promise.all([
    input.jobsFamily === "ab"
      ? upcomingInterviewActions(db, userId, input.timeZone, now)
      : Promise.resolve([]),
    input.jobsFamily === "ab" && input.resumeFamily === "ab"
      ? unboundPositionActions(db, userId)
      : Promise.resolve([]),
    jobRecordActions(db, userId, input),
    resumeRecordActions(db, userId, input.resumeFamily),
  ]);

  const grouped = new Map<NextActionRuleId, NextActionItem[]>([
    [NEXT_ACTION_RULE.R5, r5],
    // [R6]: awaiting the §7.3 listAwaitingReflectionInterviews read model.
    [NEXT_ACTION_RULE.R4, r4],
    [NEXT_ACTION_RULE.R3, r3],
    [NEXT_ACTION_RULE.R1, r1],
  ]);
  const ai = aiConfigActions(input);
  grouped.set(
    NEXT_ACTION_RULE.R7,
    ai.filter((item) => item.ruleId === NEXT_ACTION_RULE.R7),
  );
  grouped.set(
    NEXT_ACTION_RULE.R2,
    ai.filter((item) => item.ruleId === NEXT_ACTION_RULE.R2),
  );

  const seen = new Set<string>();
  const ordered: NextActionItem[] = [];
  for (const ruleId of RULE_PRIORITY) {
    for (const item of grouped.get(ruleId) ?? []) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      ordered.push(item);
    }
  }
  return ordered;
}

export function selectNextActions(
  candidates: NextActionItem[],
  limit: number = NEXT_ACTION_LIMIT,
): { items: NextActionItem[]; overflowCount: number } {
  return {
    items: candidates.slice(0, limit),
    overflowCount: Math.max(0, candidates.length - limit),
  };
}

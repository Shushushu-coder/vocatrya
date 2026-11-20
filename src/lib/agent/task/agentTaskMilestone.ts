import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  ACCEPTANCE_EVIDENCE_KIND,
  AGENT_TASK_TEMPLATE_KEY,
  INTERVIEW_SPRINT_MILESTONE,
  buildInitialAcceptanceItems,
  getAgentTaskTemplate,
  isAgentTaskTemplateKey,
  parseAcceptanceItems,
  type AgentTaskAcceptanceItem,
  type TaskMilestoneDerivation,
} from "./agentTaskTemplates";
import { AgentTaskError, updateAgentTaskMilestone } from "./agentTaskStore";

/**
 * Milestone + acceptance derivation (card C). Pure code over domain
 * entities: no model, no caller-supplied pass flags. `passes` / `evidenceRef`
 * are written here and nowhere else, always from a fresh ownership-scoped
 * read, so an evidenceRef that points at a deleted (or no longer valid)
 * entity simply does not survive the next derivation: the item falls back to
 * not passed.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export interface InterviewSprintFacts {
  job: { id: string; status: string; archived: boolean } | null;
  goal: {
    id: string;
    status: string;
    pinnedJdVersionExists: boolean;
  } | null;
  /** Newest COMPLETED analysis for the opportunity, stale or not. */
  latestMatch: {
    id: string;
    isStale: boolean;
    score: number | null;
    verdict: string | null;
  } | null;
  /** Newest COMPLETED, non-stale analysis. */
  freshMatchId: string | null;
  /** A live practice session with >= 1 ANSWERED question. */
  answeredSessionId: string | null;
  /** A live practice session whose current summary generation SUCCEEDED. */
  summarizedSessionId: string | null;
}

export interface SprintAnchor {
  userId: string;
  jobOpportunityId: string | null;
  interviewPrepGoalId: string | null;
}

/**
 * Load the facts the interview-sprint derivation needs. The prep goal is the
 * task's linked goal, else the opportunity's live (ACTIVE/PAUSED) goal; a
 * goal created after the task was is therefore still found.
 */
export async function loadInterviewSprintFacts(
  db: Db,
  anchor: SprintAnchor,
): Promise<InterviewSprintFacts> {
  const { userId } = anchor;
  const job = anchor.jobOpportunityId
    ? await db.jobOpportunity.findFirst({
        where: { id: anchor.jobOpportunityId, userId },
        select: { id: true, status: true, archivedAt: true },
      })
    : null;

  let goalRow = anchor.interviewPrepGoalId
    ? await db.interviewPrepGoal.findFirst({
        where: { id: anchor.interviewPrepGoalId, userId },
        select: { id: true, status: true, pinnedJobDescriptionVersionId: true },
      })
    : null;
  if (!goalRow && job) {
    goalRow = await db.interviewPrepGoal.findFirst({
      where: { userId, jobOpportunityId: job.id, status: { in: ["ACTIVE", "PAUSED"] } },
      select: { id: true, status: true, pinnedJobDescriptionVersionId: true },
    });
  }
  const pinnedExists = goalRow
    ? (await db.jobDescriptionVersion.findFirst({
        where: { id: goalRow.pinnedJobDescriptionVersionId, jobOpportunity: { userId } },
        select: { id: true },
      })) !== null
    : false;

  const matches = job
    ? await db.matchAnalysis.findMany({
        where: { userId, jobOpportunityId: job.id, status: "COMPLETED" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 10,
        select: {
          id: true,
          isStale: true,
          deepMatchDetail: { select: { overallScore: true } },
          fastScreeningDetail: { select: { verdict: true } },
        },
      })
    : [];
  const latest = matches[0] ?? null;
  const fresh = matches.find((row) => !row.isStale) ?? null;

  const sessionScope: Prisma.InterviewSessionWhereInput | null =
    job || goalRow
      ? {
          userId,
          archivedAt: null,
          status: { not: "ARCHIVED" },
          OR: [
            ...(job ? [{ jobOpportunityId: job.id }] : []),
            ...(goalRow ? [{ interviewPrepGoalId: goalRow.id }] : []),
          ],
        }
      : null;
  const answered = sessionScope
    ? await db.interviewSession.findFirst({
        where: { ...sessionScope, questionInstances: { some: { status: "ANSWERED" } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      })
    : null;
  const summarized = sessionScope
    ? await db.interviewSession.findFirst({
        where: {
          ...sessionScope,
          summaryGenerations: { some: { status: "SUCCEEDED", isCurrent: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        select: { id: true },
      })
    : null;

  return {
    job: job
      ? { id: job.id, status: job.status, archived: job.archivedAt !== null }
      : null,
    goal: goalRow
      ? { id: goalRow.id, status: goalRow.status, pinnedJdVersionExists: pinnedExists }
      : null,
    latestMatch: latest
      ? {
          id: latest.id,
          isStale: latest.isStale,
          score: latest.deepMatchDetail?.overallScore ?? null,
          verdict: latest.fastScreeningDetail?.verdict ?? null,
        }
      : null,
    freshMatchId: fresh?.id ?? null,
    answeredSessionId: answered?.id ?? null,
    summarizedSessionId: summarized?.id ?? null,
  };
}

/** Evidence entity id (or null = not proven) for each acceptance key. */
function evidenceFor(facts: InterviewSprintFacts): Record<string, string | null> {
  return {
    "prep-goal-active":
      facts.goal && facts.goal.pinnedJdVersionExists && facts.goal.status !== "ENDED"
        ? facts.goal.id
        : null,
    "jd-fit-reviewed": facts.freshMatchId,
    "mock-session-1": facts.answeredSessionId,
    "session-summary-reviewed": facts.summarizedSessionId,
  };
}

/**
 * Pure derivation of the interview-sprint checklist and milestone. Every
 * item starts default-FAIL; one flips only when `facts` yields an evidence
 * entity for it. Labels come from the template, never from stored data.
 */
export function deriveTaskMilestone(
  facts: InterviewSprintFacts,
): TaskMilestoneDerivation {
  const template = getAgentTaskTemplate(AGENT_TASK_TEMPLATE_KEY.INTERVIEW_SPRINT);
  const evidence = evidenceFor(facts);
  const acceptanceItems: AgentTaskAcceptanceItem[] = template.acceptanceItems.map((def) => {
    const ref = evidence[def.key] ?? null;
    return ref
      ? { key: def.key, label: def.label, passes: true, evidenceRef: ref }
      : { key: def.key, label: def.label, passes: false };
  });
  const pass = (key: string) => acceptanceItems.find((item) => item.key === key)?.passes === true;

  let milestone: string = INTERVIEW_SPRINT_MILESTONE.PREPARING;
  if (acceptanceItems.every((item) => item.passes)) {
    milestone = INTERVIEW_SPRINT_MILESTONE.DONE;
  } else if (pass("mock-session-1")) {
    milestone = INTERVIEW_SPRINT_MILESTONE.REVIEWING;
  } else if (pass("prep-goal-active") && pass("jd-fit-reviewed")) {
    milestone = INTERVIEW_SPRINT_MILESTONE.PRACTICING;
  }
  return { milestone, acceptanceItems };
}

function sameItems(
  a: readonly AgentTaskAcceptanceItem[],
  b: readonly AgentTaskAcceptanceItem[],
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SyncDerivationResult {
  milestone: string;
  acceptanceItems: AgentTaskAcceptanceItem[];
  facts: InterviewSprintFacts;
  milestoneChanged: boolean;
  itemsChanged: boolean;
}

/**
 * Re-derive and persist milestone + acceptance for an owned, unarchived,
 * non-terminal task. Idempotent: writes nothing when nothing changed. The
 * checklist write is a CAS on the serialized value read; the milestone move
 * goes through updateAgentTaskMilestone (CAS + MILESTONE event). Losing
 * either race is harmless: the winner wrote the same derivation.
 */
export async function syncAgentTaskDerivation(
  db: Db,
  input: { userId: string; taskId: string },
): Promise<SyncDerivationResult | null> {
  const task = await db.agentTask.findFirst({
    where: { id: input.taskId, userId: input.userId, archivedAt: null },
  });
  if (!task || !isAgentTaskTemplateKey(task.templateKey)) return null;
  const facts = await loadInterviewSprintFacts(db, {
    userId: input.userId,
    jobOpportunityId: task.jobOpportunityId,
    interviewPrepGoalId: task.interviewPrepGoalId,
  });
  const storedItems = parseAcceptanceItems(task.acceptanceItems);
  const derived = deriveTaskMilestone(facts);

  // Terminal tasks keep their final record untouched.
  if (task.status === "DONE" || task.status === "ABANDONED") {
    return {
      milestone: task.milestone,
      acceptanceItems: storedItems.length ? storedItems : buildInitialAcceptanceItems(task.templateKey),
      facts,
      milestoneChanged: false,
      itemsChanged: false,
    };
  }

  const itemsChanged = !sameItems(storedItems, derived.acceptanceItems);
  if (itemsChanged) {
    await db.agentTask.updateMany({
      where: { id: task.id, userId: input.userId, acceptanceItems: task.acceptanceItems },
      data: { acceptanceItems: JSON.stringify(derived.acceptanceItems) },
    });
  }
  // Link a prep goal that appeared after the task was created.
  if (facts.goal && task.interviewPrepGoalId === null) {
    await db.agentTask.updateMany({
      where: { id: task.id, userId: input.userId, interviewPrepGoalId: null },
      data: { interviewPrepGoalId: facts.goal.id },
    });
  }
  let milestoneChanged = false;
  if (task.milestone !== derived.milestone) {
    try {
      await updateAgentTaskMilestone(db, {
        userId: input.userId,
        taskId: task.id,
        from: task.milestone,
        to: derived.milestone,
      });
      milestoneChanged = true;
    } catch (error) {
      if (!(error instanceof AgentTaskError && error.code === "MILESTONE_CONFLICT")) throw error;
    }
  }
  return { ...derived, facts, milestoneChanged, itemsChanged };
}

/**
 * Re-verify persisted evidence refs against the database (existence, owner,
 * and the validity the evidence kind requires). Items whose evidence no
 * longer holds come back `passes: false` with no ref; anything that never
 * had evidence stays false. Used wherever stored items are shown without a
 * full re-derivation.
 */
export async function verifyAcceptanceEvidence(
  db: Db,
  input: {
    userId: string;
    templateKey: string;
    items: readonly AgentTaskAcceptanceItem[];
  },
): Promise<{ items: AgentTaskAcceptanceItem[]; revoked: string[] }> {
  const out: AgentTaskAcceptanceItem[] = [];
  const revoked: string[] = [];
  const kindByKey = new Map<string, string>(
    isAgentTaskTemplateKey(input.templateKey)
      ? getAgentTaskTemplate(input.templateKey).acceptanceItems.map((def) => [
          def.key,
          def.evidenceKind,
        ])
      : [],
  );
  for (const item of input.items) {
    const kind = kindByKey.get(item.key);
    let holds = false;
    if (item.passes && item.evidenceRef && kind) {
      holds = await evidenceHolds(db, input.userId, kind, item.evidenceRef);
    }
    if (holds) out.push(item);
    else {
      if (item.passes) revoked.push(item.key);
      out.push({ key: item.key, label: item.label, passes: false });
    }
  }
  return { items: out, revoked };
}

async function evidenceHolds(
  db: Db,
  userId: string,
  kind: string,
  id: string,
): Promise<boolean> {
  switch (kind) {
    case ACCEPTANCE_EVIDENCE_KIND.INTERVIEW_PREP_GOAL:
      return (
        (await db.interviewPrepGoal.findFirst({
          where: { id, userId, status: { not: "ENDED" } },
          select: { id: true },
        })) !== null
      );
    case ACCEPTANCE_EVIDENCE_KIND.MATCH_ANALYSIS:
      return (
        (await db.matchAnalysis.findFirst({
          where: { id, userId, status: "COMPLETED", isStale: false },
          select: { id: true },
        })) !== null
      );
    case ACCEPTANCE_EVIDENCE_KIND.INTERVIEW_SESSION:
      return (
        (await db.interviewSession.findFirst({
          where: { id, userId, archivedAt: null, status: { not: "ARCHIVED" } },
          select: { id: true },
        })) !== null
      );
    default:
      return false;
  }
}

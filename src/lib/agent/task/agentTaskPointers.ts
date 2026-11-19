import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  AGENT_TASK_HANDOFF_POINTER_KEYS,
  type AgentTaskHandoffPointerKey,
  type AgentTaskHandoffPointers,
} from "@/models/agentTask.schema";

/**
 * Shared, ownership-scoped entity queries for task handoffs.
 *
 * Two jobs, one set of queries (card C's grounding verifier reuses both):
 *  - collectInterviewSprintPointers: the deterministic source of every
 *    pointer written into a handoff. A model never supplies an id.
 *  - findMissingPointers: existence re-check of every pointer id. A bare id
 *    is never authority, so each lookup also filters by userId. Restored
 *    backups may carry ids that no longer resolve; callers surface those as
 *    discrepancies instead of crashing.
 */
type Db = PrismaClient | Prisma.TransactionClient;

export interface MissingPointer {
  key: AgentTaskHandoffPointerKey;
  id: string;
}

export const EMPTY_HANDOFF_POINTERS: AgentTaskHandoffPointers = {
  jobOpportunityIds: [],
  jobDescriptionVersionIds: [],
  interviewPrepGoalIds: [],
  matchAnalysisIds: [],
  interviewSessionIds: [],
};

function unique(ids: Array<string | null | undefined>): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === "string" && id !== ""))];
}

const CAP = APP_CONSTANTS.AGENT_TASK_HANDOFF_MAX_POINTERS;

/**
 * Collect the interview-sprint evidence pointers for a task from domain
 * state (newest first, capped): the anchor opportunity, the linked prep goal
 * and its pinned JD version, completed match analyses for the opportunity,
 * and the practice (interview) sessions for the opportunity or goal.
 */
export async function collectInterviewSprintPointers(
  db: Db,
  input: {
    userId: string;
    jobOpportunityId: string | null;
    interviewPrepGoalId: string | null;
  },
): Promise<AgentTaskHandoffPointers> {
  const { userId, jobOpportunityId, interviewPrepGoalId } = input;
  const job = jobOpportunityId
    ? await db.jobOpportunity.findFirst({
        where: { id: jobOpportunityId, userId },
        select: { id: true },
      })
    : null;
  const goal = interviewPrepGoalId
    ? await db.interviewPrepGoal.findFirst({
        where: { id: interviewPrepGoalId, userId },
        select: { id: true, pinnedJobDescriptionVersionId: true },
      })
    : null;
  const matches = job
    ? await db.matchAnalysis.findMany({
        where: { userId, jobOpportunityId: job.id, status: "COMPLETED" },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: CAP,
        select: { id: true },
      })
    : [];
  const sessions =
    job || goal
      ? await db.interviewSession.findMany({
          where: {
            userId,
            OR: [
              ...(job ? [{ jobOpportunityId: job.id }] : []),
              ...(goal ? [{ interviewPrepGoalId: goal.id }] : []),
            ],
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: CAP,
          select: { id: true },
        })
      : [];
  return {
    jobOpportunityIds: unique([job?.id]),
    jobDescriptionVersionIds: unique([goal?.pinnedJobDescriptionVersionId]),
    interviewPrepGoalIds: unique([goal?.id]),
    matchAnalysisIds: unique(matches.map((row) => row.id)),
    interviewSessionIds: unique(sessions.map((row) => row.id)),
  };
}

async function existingIds(
  db: Db,
  userId: string,
  key: AgentTaskHandoffPointerKey,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  let rows: Array<{ id: string }>;
  switch (key) {
    case "jobOpportunityIds":
      rows = await db.jobOpportunity.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true },
      });
      break;
    case "jobDescriptionVersionIds":
      rows = await db.jobDescriptionVersion.findMany({
        where: { id: { in: ids }, jobOpportunity: { userId } },
        select: { id: true },
      });
      break;
    case "interviewPrepGoalIds":
      rows = await db.interviewPrepGoal.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true },
      });
      break;
    case "matchAnalysisIds":
      rows = await db.matchAnalysis.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true },
      });
      break;
    case "interviewSessionIds":
      rows = await db.interviewSession.findMany({
        where: { id: { in: ids }, userId },
        select: { id: true },
      });
      break;
  }
  return new Set(rows.map((row) => row.id));
}

/**
 * Every pointer id that does not resolve to a row owned by `userId`
 * (missing, deleted, or belonging to someone else). Existence only: status
 * drift (archived, stale analysis) is card C's grounding concern.
 */
export async function findMissingPointers(
  db: Db,
  input: { userId: string; pointers: AgentTaskHandoffPointers },
): Promise<MissingPointer[]> {
  const missing: MissingPointer[] = [];
  for (const key of AGENT_TASK_HANDOFF_POINTER_KEYS) {
    const ids = unique(input.pointers[key] ?? []);
    const found = await existingIds(db, input.userId, key, ids);
    for (const id of ids) if (!found.has(id)) missing.push({ key, id });
  }
  return missing;
}

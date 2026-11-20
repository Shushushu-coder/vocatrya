import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  AGENT_TASK_TEMPLATE_KEY,
  buildInitialAcceptanceItems,
  getAgentTaskTemplate,
  initialMilestoneFor,
  parseAcceptanceItems,
  type AgentTaskAcceptanceItem,
  type AgentTaskTemplateKey,
} from "./agentTaskTemplates";
import { AGENT_TASK_EVENT_KIND, recordTaskEvent } from "./agentTaskEvents";

/**
 * Agent long-task ledger store (card A).
 *
 * Every read and write is scoped by task id AND userId; a bare id is never
 * authority. Concurrency is enforced here, not by callers:
 *  - single active session: claim is a compare-and-swap on the observed
 *    (activeSessionId, activeSessionClaimedAt) pair, with stale-claim
 *    recovery after AGENT_TASK_SESSION_STALE_MS;
 *  - handoff baseline: commitAgentTaskRevision is a CAS on `revision`
 *    (card B inserts the AgentTaskHandoff row in the same transaction;
 *    @@unique([taskId, revision]) is the second gate).
 * Task sessions belong to the Pilot role: only a live conversation with
 * agentRole "pilot" can be claimed (never agentRole NULL).
 */
type Db = PrismaClient | Prisma.TransactionClient;

export const AGENT_TASK_STATUS = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  BLOCKED: "BLOCKED",
  DONE: "DONE",
  ABANDONED: "ABANDONED",
} as const;
export type AgentTaskStatus =
  (typeof AGENT_TASK_STATUS)[keyof typeof AGENT_TASK_STATUS];

export const AGENT_TASK_BLOCKED_REASON = {
  WAITING_USER_CONFIRMATION: "WAITING_USER_CONFIRMATION",
  WAITING_SCHEDULE: "WAITING_SCHEDULE",
  MISSING_FACTS: "MISSING_FACTS",
  EXTERNAL_REPLY: "EXTERNAL_REPLY",
} as const;
export type AgentTaskBlockedReason =
  (typeof AGENT_TASK_BLOCKED_REASON)[keyof typeof AGENT_TASK_BLOCKED_REASON];

/** Statuses that hold the (user, template, opportunity) live slot. */
const LIVE_STATUSES: readonly string[] = [
  AGENT_TASK_STATUS.ACTIVE,
  AGENT_TASK_STATUS.PAUSED,
  AGENT_TASK_STATUS.BLOCKED,
];

const TRANSITIONS: Record<AgentTaskStatus, readonly AgentTaskStatus[]> = {
  ACTIVE: ["PAUSED", "BLOCKED", "DONE", "ABANDONED"],
  PAUSED: ["ACTIVE", "ABANDONED"],
  BLOCKED: ["ACTIVE", "PAUSED", "ABANDONED"],
  DONE: [],
  ABANDONED: [],
};

export type AgentTaskErrorCode =
  | "TASK_NOT_FOUND"
  | "JOB_NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "STATUS_CONFLICT"
  | "ACCEPTANCE_INCOMPLETE"
  | "INVALID_MILESTONE"
  | "MILESTONE_CONFLICT";

export class AgentTaskError extends Error {
  constructor(
    readonly code: AgentTaskErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AgentTaskError";
  }
}

export interface AgentTaskDTO {
  id: string;
  title: string;
  templateKey: string;
  jobOpportunityId: string | null;
  interviewPrepGoalId: string | null;
  milestone: string;
  status: string;
  acceptanceItems: AgentTaskAcceptanceItem[];
  revision: number;
  activeSessionId: string | null;
  activeSessionClaimedAt: Date | null;
  blockedReason: string | null;
  blockedInputKey: string | null;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

type TaskRow = Prisma.AgentTaskGetPayload<Record<string, never>>;

function toDTO(row: TaskRow): AgentTaskDTO {
  return {
    id: row.id,
    title: row.title,
    templateKey: row.templateKey,
    jobOpportunityId: row.jobOpportunityId,
    interviewPrepGoalId: row.interviewPrepGoalId,
    milestone: row.milestone,
    status: row.status,
    acceptanceItems: parseAcceptanceItems(row.acceptanceItems),
    revision: row.revision,
    activeSessionId: row.activeSessionId,
    activeSessionClaimedAt: row.activeSessionClaimedAt,
    blockedReason: row.blockedReason,
    blockedInputKey: row.blockedInputKey,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt,
  };
}

async function inTransaction<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db) return db.$transaction(fn);
  return fn(db);
}

export function liveSlotFor(
  templateKey: string,
  jobOpportunityId: string | null,
): string | null {
  return jobOpportunityId ? `${templateKey}:${jobOpportunityId}` : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

/* ------------------------------ create / read ------------------------------ */

export interface CreateAgentTaskInput {
  userId: string;
  jobOpportunityId: string;
  title?: string;
  templateKey?: AgentTaskTemplateKey;
}

/**
 * Create an interview-sprint task bound to a JobOpportunity the user owns.
 * One live task per (user, template, opportunity): a second create returns
 * the existing live task with `created: false`. A live InterviewPrepGoal for
 * the opportunity, if any, is linked as a pointer (never copied).
 */
export async function createAgentTask(
  db: Db,
  input: CreateAgentTaskInput,
): Promise<{ task: AgentTaskDTO; created: boolean }> {
  const templateKey = input.templateKey ?? AGENT_TASK_TEMPLATE_KEY.INTERVIEW_SPRINT;
  const template = getAgentTaskTemplate(templateKey);
  const job = await db.jobOpportunity.findFirst({
    where: { id: input.jobOpportunityId, userId: input.userId, archivedAt: null },
    select: { id: true, title: true },
  });
  if (!job) throw new AgentTaskError("JOB_NOT_FOUND");

  const liveSlot = liveSlotFor(templateKey, job.id);
  const existing = await db.agentTask.findFirst({
    where: { userId: input.userId, liveSlot },
  });
  if (existing) return { task: toDTO(existing), created: false };

  const title = (input.title ?? "").trim() || `${template.titlePrefix} · ${job.title}`;
  if (title.length > 200) throw new AgentTaskError("INVALID_INPUT", "title too long");

  const goal = await db.interviewPrepGoal.findFirst({
    where: {
      userId: input.userId,
      jobOpportunityId: job.id,
      status: { in: ["ACTIVE", "PAUSED"] },
    },
    select: { id: true },
  });

  try {
    const row = await inTransaction(db, async (tx) => {
      const created = await tx.agentTask.create({
        data: {
          userId: input.userId,
          title,
          templateKey,
          jobOpportunityId: job.id,
          interviewPrepGoalId: goal?.id ?? null,
          milestone: initialMilestoneFor(templateKey),
          status: AGENT_TASK_STATUS.ACTIVE,
          acceptanceItems: JSON.stringify(buildInitialAcceptanceItems(templateKey)),
          liveSlot,
        },
      });
      await recordTaskEvent(tx, {
        userId: input.userId,
        taskId: created.id,
        kind: AGENT_TASK_EVENT_KIND.CREATED,
        payload: { templateKey, jobOpportunityId: job.id },
      });
      return created;
    });
    return { task: toDTO(row), created: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost the create race to a concurrent request: return the winner.
    const winner = await db.agentTask.findFirst({
      where: { userId: input.userId, liveSlot },
    });
    if (!winner) throw error;
    return { task: toDTO(winner), created: false };
  }
}

export async function getAgentTask(
  db: Db,
  input: { userId: string; taskId: string },
): Promise<AgentTaskDTO | null> {
  const row = await db.agentTask.findFirst({
    where: { id: input.taskId, userId: input.userId },
  });
  return row ? toDTO(row) : null;
}

export async function requireAgentTask(
  db: Db,
  input: { userId: string; taskId: string },
): Promise<AgentTaskDTO> {
  const task = await getAgentTask(db, input);
  if (!task) throw new AgentTaskError("TASK_NOT_FOUND");
  return task;
}

export async function listAgentTasks(
  db: Db,
  input: {
    userId: string;
    status?: AgentTaskStatus;
    jobOpportunityId?: string;
    includeArchived?: boolean;
    limit?: number;
  },
): Promise<AgentTaskDTO[]> {
  const rows = await db.agentTask.findMany({
    where: {
      userId: input.userId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.jobOpportunityId ? { jobOpportunityId: input.jobOpportunityId } : {}),
      ...(input.includeArchived ? {} : { archivedAt: null }),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: Math.min(Math.max(input.limit ?? 50, 1), 200),
  });
  return rows.map(toDTO);
}

/* ------------------------------ status / milestone ------------------------------ */

export interface TransitionAgentTaskInput {
  userId: string;
  taskId: string;
  to: AgentTaskStatus;
  blockedReason?: AgentTaskBlockedReason;
  blockedInputKey?: string;
}

/**
 * Status transition with CAS on the observed status. Leaving ACTIVE drops
 * the session claim (the session degrades to an ordinary chat); terminal
 * states free the live slot. DONE requires every acceptance item to hold
 * evidence — default-FAIL, never self-declared.
 */
export async function transitionAgentTaskStatus(
  db: Db,
  input: TransitionAgentTaskInput,
): Promise<AgentTaskDTO> {
  return inTransaction(db, async (tx) => {
    const current = await tx.agentTask.findFirst({
      where: { id: input.taskId, userId: input.userId, archivedAt: null },
    });
    if (!current) throw new AgentTaskError("TASK_NOT_FOUND");
    const from = current.status as AgentTaskStatus;
    if (!(TRANSITIONS[from] ?? []).includes(input.to)) {
      throw new AgentTaskError("INVALID_TRANSITION", `${from} -> ${input.to}`);
    }
    if (input.to === AGENT_TASK_STATUS.BLOCKED && !input.blockedReason) {
      throw new AgentTaskError("INVALID_INPUT", "blockedReason required");
    }
    if (input.to === AGENT_TASK_STATUS.DONE) {
      const items = parseAcceptanceItems(current.acceptanceItems);
      if (items.length === 0 || !items.every((item) => item.passes)) {
        throw new AgentTaskError("ACCEPTANCE_INCOMPLETE");
      }
    }
    const terminal =
      input.to === AGENT_TASK_STATUS.DONE || input.to === AGENT_TASK_STATUS.ABANDONED;
    const blocked = input.to === AGENT_TASK_STATUS.BLOCKED;
    const result = await tx.agentTask.updateMany({
      where: { id: current.id, userId: input.userId, status: from },
      data: {
        status: input.to,
        blockedReason: blocked ? input.blockedReason! : null,
        blockedInputKey: blocked ? (input.blockedInputKey ?? null) : null,
        ...(input.to === AGENT_TASK_STATUS.ACTIVE
          ? {}
          : { activeSessionId: null, activeSessionClaimedAt: null }),
        ...(terminal ? { liveSlot: null } : {}),
      },
    });
    if (result.count !== 1) throw new AgentTaskError("STATUS_CONFLICT");
    await recordTaskEvent(tx, {
      userId: input.userId,
      taskId: current.id,
      kind: blocked ? AGENT_TASK_EVENT_KIND.BLOCKED : AGENT_TASK_EVENT_KIND.STATUS,
      payload: {
        from,
        to: input.to,
        ...(blocked ? { reason: input.blockedReason! } : {}),
      },
    });
    const updated = await tx.agentTask.findFirstOrThrow({
      where: { id: current.id, userId: input.userId },
    });
    return toDTO(updated);
  });
}

/**
 * Milestone CAS: only moves when the stored milestone still equals `from`
 * and `to` is a milestone of the task's template. Derivation (deciding what
 * `to` should be) is card C.
 */
export async function updateAgentTaskMilestone(
  db: Db,
  input: { userId: string; taskId: string; from: string; to: string },
): Promise<AgentTaskDTO> {
  return inTransaction(db, async (tx) => {
    const current = await tx.agentTask.findFirst({
      where: { id: input.taskId, userId: input.userId, archivedAt: null },
    });
    if (!current) throw new AgentTaskError("TASK_NOT_FOUND");
    const template = getAgentTaskTemplate(current.templateKey as AgentTaskTemplateKey);
    if (!template || !template.milestones.includes(input.to)) {
      throw new AgentTaskError("INVALID_MILESTONE", input.to);
    }
    const result = await tx.agentTask.updateMany({
      where: { id: current.id, userId: input.userId, milestone: input.from },
      data: { milestone: input.to },
    });
    if (result.count !== 1) throw new AgentTaskError("MILESTONE_CONFLICT");
    await recordTaskEvent(tx, {
      userId: input.userId,
      taskId: current.id,
      kind: AGENT_TASK_EVENT_KIND.MILESTONE,
      payload: { from: input.from, to: input.to },
    });
    const updated = await tx.agentTask.findFirstOrThrow({
      where: { id: current.id, userId: input.userId },
    });
    return toDTO(updated);
  });
}

/* ------------------------------ session claim ------------------------------ */

export type ClaimResult =
  | { ok: true; task: AgentTaskDTO; recoveredStale: boolean; renewed: boolean }
  | {
      ok: false;
      reason: "TASK_NOT_FOUND" | "NOT_ACTIVE" | "SESSION_INVALID" | "HELD";
    };

/**
 * Claim the single active session slot for `sessionId`.
 *
 * The session must be a live (unarchived) conversation of the same user with
 * agentRole "pilot" that is either unbound or already bound to this task.
 * The slot is free when no claim exists, when the same session re-claims
 * (renewal), or when the existing claim is older than the stale window
 * (recovered; the old session gets a SESSION_END/stale event). The write is
 * a CAS on the observed claim pair, so two concurrent claimers cannot both
 * win.
 */
export async function claimAgentTaskSession(
  db: Db,
  input: {
    userId: string;
    taskId: string;
    sessionId: string;
    now?: Date;
    staleMs?: number;
  },
): Promise<ClaimResult> {
  const now = input.now ?? new Date();
  const staleMs = input.staleMs ?? APP_CONSTANTS.AGENT_TASK_SESSION_STALE_MS;
  return inTransaction(db, async (tx) => {
    const task = await tx.agentTask.findFirst({
      where: { id: input.taskId, userId: input.userId, archivedAt: null },
    });
    if (!task) return { ok: false, reason: "TASK_NOT_FOUND" } as const;
    if (task.status !== AGENT_TASK_STATUS.ACTIVE) {
      return { ok: false, reason: "NOT_ACTIVE" } as const;
    }
    const session = await tx.chatConversation.findFirst({
      where: {
        id: input.sessionId,
        userId: input.userId,
        archivedAt: null,
        agentRole: "pilot",
        OR: [{ agentTaskId: null }, { agentTaskId: task.id }],
      },
      select: { id: true },
    });
    if (!session) return { ok: false, reason: "SESSION_INVALID" } as const;

    const holder = task.activeSessionId;
    const claimedAt = task.activeSessionClaimedAt;
    const renewed = holder === input.sessionId;
    const stale =
      holder !== null &&
      !renewed &&
      (claimedAt === null || now.getTime() - claimedAt.getTime() >= staleMs);
    if (holder !== null && !renewed && !stale) {
      return { ok: false, reason: "HELD" } as const;
    }

    // CAS on exactly what we observed: a concurrent claimer or release
    // changes the pair and this update matches nothing.
    const won = await tx.agentTask.updateMany({
      where: {
        id: task.id,
        userId: input.userId,
        status: AGENT_TASK_STATUS.ACTIVE,
        activeSessionId: holder,
        activeSessionClaimedAt: claimedAt,
      },
      data: { activeSessionId: input.sessionId, activeSessionClaimedAt: now },
    });
    if (won.count !== 1) return { ok: false, reason: "HELD" } as const;

    await tx.chatConversation.updateMany({
      where: { id: input.sessionId, userId: input.userId },
      data: { agentTaskId: task.id },
    });
    if (stale) {
      await recordTaskEvent(tx, {
        userId: input.userId,
        taskId: task.id,
        kind: AGENT_TASK_EVENT_KIND.SESSION_END,
        payload: { sessionId: holder, reason: "stale" },
      });
    }
    if (!renewed) {
      await recordTaskEvent(tx, {
        userId: input.userId,
        taskId: task.id,
        kind: AGENT_TASK_EVENT_KIND.SESSION_START,
        payload: { sessionId: input.sessionId, recoveredStale: stale },
      });
    }
    const fresh = await tx.agentTask.findFirstOrThrow({
      where: { id: task.id, userId: input.userId },
    });
    return {
      ok: true,
      task: toDTO(fresh),
      recoveredStale: stale,
      renewed,
    } as const;
  });
}

/**
 * Release the claim, only if `sessionId` still holds it. Returns false when
 * someone else holds (or took over) the slot — a stale session cannot evict
 * its successor.
 */
export async function releaseAgentTaskSession(
  db: Db,
  input: { userId: string; taskId: string; sessionId: string; reason?: string },
): Promise<boolean> {
  return inTransaction(db, async (tx) => {
    const result = await tx.agentTask.updateMany({
      where: {
        id: input.taskId,
        userId: input.userId,
        activeSessionId: input.sessionId,
      },
      data: { activeSessionId: null, activeSessionClaimedAt: null },
    });
    if (result.count !== 1) return false;
    await recordTaskEvent(tx, {
      userId: input.userId,
      taskId: input.taskId,
      kind: AGENT_TASK_EVENT_KIND.SESSION_END,
      payload: { sessionId: input.sessionId, reason: input.reason ?? "released" },
    });
    return true;
  });
}

/* ------------------------------ handoff baseline ------------------------------ */

/**
 * Handoff revision CAS primitive for card B: bumps AgentTask.revision from
 * `expectedRevision` to expectedRevision + 1 and returns the new revision, or
 * null if another writer already advanced it. Call inside the same
 * transaction that inserts the AgentTaskHandoff row with that revision
 * (@@unique([taskId, revision]) backs this up).
 */
export async function commitAgentTaskRevision(
  db: Db,
  input: { userId: string; taskId: string; expectedRevision: number },
): Promise<number | null> {
  const result = await db.agentTask.updateMany({
    where: {
      id: input.taskId,
      userId: input.userId,
      revision: input.expectedRevision,
    },
    data: { revision: { increment: 1 } },
  });
  return result.count === 1 ? input.expectedRevision + 1 : null;
}

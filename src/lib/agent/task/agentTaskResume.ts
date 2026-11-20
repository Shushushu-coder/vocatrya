import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildTaskHandoffLine, normalizeGroundingLocale } from "./agentTaskBootstrap";
import { AGENT_TASK_EVENT_KIND, recordTaskEvent } from "./agentTaskEvents";
import type { GroundingDiscrepancy } from "./agentTaskGrounding";
import {
  AGENT_TASK_STATUS,
  claimAgentTaskSession,
  getAgentTask,
  releaseAgentTaskSession,
  transitionAgentTaskStatus,
  type AgentTaskDTO,
} from "./agentTaskStore";
import type { AgentTaskAcceptanceItem } from "./agentTaskTemplates";

/**
 * Resume / cold start (card C). "Continue task" = (re)activate the task,
 * claim ONE Pilot session for it (a fresh conversation bound to the task, or
 * the caller's current one), run the deterministic grounding pass and hand
 * the UI the verified state line. The single-active-session rule is the
 * claim CAS in agentTaskStore; this layer never bypasses it.
 */
type Db = PrismaClient | Prisma.TransactionClient;

/** Fixed (not model-written) first user message the UI may send. */
export const TASK_KICKOFF_TEXT = {
  "zh-CN": "继续推进这个任务。",
  en: "Continue this task.",
} as const;

export type ResumeAgentTaskFailure =
  | "TASK_NOT_FOUND"
  | "NOT_RESUMABLE"
  | "SESSION_INVALID"
  | "HELD";

export type ResumeAgentTaskResult =
  | {
      ok: true;
      task: AgentTaskDTO;
      conversationId: string;
      /** A new conversation was created for this resume. */
      created: boolean;
      /** The live session already holding the claim was reopened. */
      reused: boolean;
      recoveredStale: boolean;
      /** The verified "Active task state" line a session is given. */
      handoffLine: string;
      milestone: string;
      acceptanceItems: AgentTaskAcceptanceItem[];
      discrepancies: GroundingDiscrepancy[];
      handoffRevision: number | null;
      kickoffText: string;
    }
  | {
      ok: false;
      code: ResumeAgentTaskFailure;
      /** The session holding the claim, for HELD. */
      activeSessionId?: string;
    };

export type ResumeAgentTaskData = Omit<
  Extract<ResumeAgentTaskResult, { ok: true }>,
  "ok"
>;

async function ownedPilotSession(
  db: Db,
  userId: string,
  conversationId: string,
  taskId: string,
): Promise<boolean> {
  const row = await db.chatConversation.findFirst({
    where: {
      id: conversationId,
      userId,
      archivedAt: null,
      agentRole: "pilot",
      OR: [{ agentTaskId: null }, { agentTaskId: taskId }],
    },
    select: { id: true },
  });
  return row !== null;
}

export async function resumeAgentTaskSession(
  db: Db,
  input: {
    userId: string;
    taskId: string;
    /** Use this conversation as the task session instead of creating one. */
    conversationId?: string;
    locale?: string;
    now?: Date;
    /** Creates the Pilot conversation bound to the task (lock resolution lives with the caller). */
    createConversation: (args: { task: AgentTaskDTO }) => Promise<{ id: string }>;
  },
): Promise<ResumeAgentTaskResult> {
  const now = input.now ?? new Date();
  let task = await getAgentTask(db, { userId: input.userId, taskId: input.taskId });
  if (!task) return { ok: false, code: "TASK_NOT_FOUND" };
  if (task.status === AGENT_TASK_STATUS.DONE || task.status === AGENT_TASK_STATUS.ABANDONED) {
    return { ok: false, code: "NOT_RESUMABLE" };
  }
  if (task.status !== AGENT_TASK_STATUS.ACTIVE) {
    task = await transitionAgentTaskStatus(db, {
      userId: input.userId,
      taskId: input.taskId,
      to: AGENT_TASK_STATUS.ACTIVE,
    });
  }

  let conversationId: string | null = null;
  let created = false;
  let reused = false;
  let recoveredStale = false;

  if (input.conversationId) {
    if (!(await ownedPilotSession(db, input.userId, input.conversationId, task.id))) {
      return { ok: false, code: "SESSION_INVALID" };
    }
    const claim = await claimAgentTaskSession(db, {
      userId: input.userId,
      taskId: task.id,
      sessionId: input.conversationId,
      now,
    });
    if (!claim.ok) {
      return claim.reason === "HELD"
        ? { ok: false, code: "HELD", activeSessionId: task.activeSessionId ?? undefined }
        : { ok: false, code: claim.reason === "TASK_NOT_FOUND" ? "TASK_NOT_FOUND" : "SESSION_INVALID" };
    }
    conversationId = input.conversationId;
    recoveredStale = claim.recoveredStale;
    task = claim.task;
  } else {
    const holder = task.activeSessionId;
    if (holder) {
      const holderLive = await ownedPilotSession(db, input.userId, holder, task.id);
      const claimedAt = task.activeSessionClaimedAt;
      const fresh =
        claimedAt !== null &&
        now.getTime() - claimedAt.getTime() < APP_CONSTANTS.AGENT_TASK_SESSION_STALE_MS;
      if (!holderLive) {
        // The claiming conversation was deleted/archived: free the slot.
        await releaseAgentTaskSession(db, {
          userId: input.userId,
          taskId: task.id,
          sessionId: holder,
          reason: "session_gone",
        });
      } else if (fresh) {
        const claim = await claimAgentTaskSession(db, {
          userId: input.userId,
          taskId: task.id,
          sessionId: holder,
          now,
        });
        if (claim.ok) {
          conversationId = holder;
          reused = true;
          task = claim.task;
        }
      }
    }
    if (!conversationId) {
      const fresh = await createClaimedConversation(db, input, task, now);
      if (!fresh.ok) return fresh.failure;
      conversationId = fresh.conversationId;
      created = true;
      recoveredStale = fresh.recoveredStale;
      task = fresh.task;
    }
  }

  const locale = normalizeGroundingLocale(input.locale);
  const built = await buildTaskHandoffLine(db, {
    userId: input.userId,
    taskId: task.id,
    locale,
    recordEvents: true,
    now,
  });
  if (!built) return { ok: false, code: "TASK_NOT_FOUND" };
  try {
    await recordTaskEvent(db, {
      userId: input.userId,
      taskId: task.id,
      kind: AGENT_TASK_EVENT_KIND.RESUMED,
      payload: { sessionId: conversationId, created, reused },
    });
  } catch {
    // Audit is best-effort.
  }
  const { grounding } = built;
  return {
    ok: true,
    task: grounding.task,
    conversationId,
    created,
    reused,
    recoveredStale,
    handoffLine: built.line,
    milestone: grounding.milestone,
    acceptanceItems: grounding.acceptanceItems,
    discrepancies: grounding.discrepancies,
    handoffRevision: grounding.handoffRevision,
    kickoffText: TASK_KICKOFF_TEXT[locale],
  };
}

async function createClaimedConversation(
  db: Db,
  input: {
    userId: string;
    createConversation: (args: { task: AgentTaskDTO }) => Promise<{ id: string }>;
  },
  task: AgentTaskDTO,
  now: Date,
): Promise<
  | { ok: true; conversationId: string; recoveredStale: boolean; task: AgentTaskDTO }
  | { ok: false; failure: ResumeAgentTaskResult }
> {
  const conversation = await input.createConversation({ task });
  const claim = await claimAgentTaskSession(db, {
    userId: input.userId,
    taskId: task.id,
    sessionId: conversation.id,
    now,
  });
  if (claim.ok) {
    return {
      ok: true,
      conversationId: conversation.id,
      recoveredStale: claim.recoveredStale,
      task: claim.task,
    };
  }
  // Lost the claim race: the fresh, empty conversation is ours alone — remove it.
  try {
    await db.chatConversation.deleteMany({
      where: { id: conversation.id, userId: input.userId },
    });
  } catch {
    // A stray empty task-bound row is harmless; the claim was never taken.
  }
  const current = await getAgentTask(db, { userId: input.userId, taskId: task.id });
  return {
    ok: false,
    failure:
      claim.reason === "HELD"
        ? { ok: false, code: "HELD", activeSessionId: current?.activeSessionId ?? undefined }
        : { ok: false, code: claim.reason === "TASK_NOT_FOUND" ? "TASK_NOT_FOUND" : "SESSION_INVALID" },
  };
}

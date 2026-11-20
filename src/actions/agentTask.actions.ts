"use server";

import prisma from "@/lib/db";
import {
  AGENT_TASK_STATUS,
  AgentTaskError,
  createAgentTask as createAgentTaskRecord,
  getAgentTask as getAgentTaskRecord,
  listAgentTasks as listAgentTaskRecords,
  requireAgentTask,
  transitionAgentTaskStatus,
  type AgentTaskDTO,
  type AgentTaskStatus,
} from "@/lib/agent/task/agentTaskStore";
import {
  AgentTaskEventError,
  listTaskEvents,
  type AgentTaskEventDTO,
} from "@/lib/agent/task/agentTaskEvents";
import { resumeAgentTaskSession, type ResumeAgentTaskData } from "@/lib/agent/task/agentTaskResume";
import { syncAgentTaskDerivation } from "@/lib/agent/task/agentTaskMilestone";
import { loadLatestHandoff } from "@/lib/agent/task/agentTaskHandoffStore";
import { createChatConversationRecord } from "@/lib/agent/chatConversationStore";
import { resolveOwnedContext } from "@/lib/agent/conversationContext.server";
import { EMPTY_CONVERSATION_CONTEXT } from "@/lib/agent/conversationContext";
import { loadAgentPreferences } from "@/lib/agent/preferences.server";
import { getServerLocale } from "@/i18n/server";
import { handleError } from "@/lib/utils";
import type { ActionResult } from "@/models/action.model";
import { requireUser } from "./shared";

/**
 * Agent long-task surface (card A skeleton, no UI). Every entry point
 * authenticates and passes the session user into the store, which scopes
 * each query by userId. Nothing here calls a model. resumeAgentTask claims a
 * Pilot session (card C).
 */
function actionError(error: unknown, msg: string): ActionResult<never> {
  if (error instanceof AgentTaskError || error instanceof AgentTaskEventError) {
    return { success: false, message: error.message, code: error.code };
  }
  return handleError(error, msg) as ActionResult<never>;
}

const STATUSES = Object.values(AGENT_TASK_STATUS) as string[];

export async function createAgentTask(input: {
  jobOpportunityId: string;
  title?: string;
}): Promise<ActionResult<{ task: AgentTaskDTO; created: boolean }>> {
  try {
    const user = await requireUser();
    if (typeof input?.jobOpportunityId !== "string" || !input.jobOpportunityId) {
      return { success: false, message: "jobOpportunityId is required", code: "INVALID_INPUT" };
    }
    const data = await createAgentTaskRecord(prisma, {
      userId: user.id,
      jobOpportunityId: input.jobOpportunityId,
      title: typeof input.title === "string" ? input.title : undefined,
    });
    return { success: true, data };
  } catch (error) {
    return actionError(error, "Failed to create the task.");
  }
}

export async function listAgentTasks(filter?: {
  status?: string;
  jobOpportunityId?: string;
}): Promise<ActionResult<AgentTaskDTO[]>> {
  try {
    const user = await requireUser();
    if (filter?.status !== undefined && !STATUSES.includes(filter.status)) {
      return { success: false, message: "Invalid status filter", code: "INVALID_INPUT" };
    }
    const data = await listAgentTaskRecords(prisma, {
      userId: user.id,
      status: filter?.status as AgentTaskStatus | undefined,
      jobOpportunityId: filter?.jobOpportunityId,
    });
    return { success: true, data };
  } catch (error) {
    return actionError(error, "Failed to list tasks.");
  }
}

export async function getAgentTask(
  taskId: string,
): Promise<ActionResult<{ task: AgentTaskDTO; events: AgentTaskEventDTO[] }>> {
  try {
    const user = await requireUser();
    // Re-derive milestone + checklist from domain state so the page never
    // shows evidence that no longer holds (idempotent; failures are non-fatal).
    await syncAgentTaskDerivation(prisma, { userId: user.id, taskId }).catch(() => null);
    const task = await requireAgentTask(prisma, { userId: user.id, taskId });
    const events = await listTaskEvents(prisma, { userId: user.id, taskId });
    return { success: true, data: { task, events } };
  } catch (error) {
    return actionError(error, "Failed to load the task.");
  }
}

export async function pauseAgentTask(
  taskId: string,
): Promise<ActionResult<AgentTaskDTO>> {
  try {
    const user = await requireUser();
    const data = await transitionAgentTaskStatus(prisma, {
      userId: user.id,
      taskId,
      to: AGENT_TASK_STATUS.PAUSED,
    });
    return { success: true, data };
  } catch (error) {
    return actionError(error, "Failed to pause the task.");
  }
}

/**
 * 继续任务: re-activate a paused/blocked task, claim ONE Pilot session for it
 * and return what the UI needs to open it.
 *  - no `conversationId`: reopens the live session already holding the claim
 *    (`reused: true`), else creates a new Pilot conversation bound to the task
 *    (`created: true`, context = the task's job page);
 *  - `conversationId`: binds + claims that existing Pilot conversation.
 * Fails with code HELD (plus `activeSessionId`) when another live session
 * holds the claim and `conversationId` was given; SESSION_INVALID when the
 * given conversation is not an owned, unarchived Pilot conversation;
 * NOT_RESUMABLE for DONE/ABANDONED tasks.
 * The UI should send `kickoffText` as the first message of a new session; the
 * session's prompt already carries `handoffLine`.
 */
export async function resumeAgentTask(
  taskId: string,
  opts?: { conversationId?: string },
): Promise<ActionResult<ResumeAgentTaskData>> {
  try {
    const user = await requireUser();
    const locale = await getServerLocale();
    const result = await resumeAgentTaskSession(prisma, {
      userId: user.id,
      taskId,
      conversationId: typeof opts?.conversationId === "string" ? opts.conversationId : undefined,
      locale,
      createConversation: async ({ task }) => {
        const context = task.jobOpportunityId
          ? await resolveOwnedContext(user.id, [
              { kind: "job", entityId: task.jobOpportunityId, source: "AUTO" },
            ]).catch(() => ({ ...EMPTY_CONVERSATION_CONTEXT, items: [] }))
          : { ...EMPTY_CONVERSATION_CONTEXT, items: [] };
        context.permissionMode = (await loadAgentPreferences(user.id)).defaultPermission;
        const row = await createChatConversationRecord({
          userId: user.id,
          messages: [],
          context,
          explicit: null,
          // Task sessions are Pilot conversations (never agentRole NULL).
          agentRole: "pilot",
          agentTaskId: task.id,
        });
        return { id: row.id };
      },
    });
    if (!result.ok) {
      return {
        success: false,
        message: result.activeSessionId
          ? `${result.code}:${result.activeSessionId}`
          : result.code,
        code: result.code,
      };
    }
    const { ok: _ok, ...data } = result;
    void _ok;
    return { success: true, data };
  } catch (error) {
    return actionError(error, "Failed to resume the task.");
  }
}

/** One row of the Agent window's task progress card. */
export interface AgentTaskCardDTO {
  task: AgentTaskDTO;
  /** First queued next action from the latest verified-shape handoff, if any. */
  nextAction: string | null;
}

const LIVE_TASK_STATUSES: string[] = [
  AGENT_TASK_STATUS.ACTIVE,
  AGENT_TASK_STATUS.PAUSED,
  AGENT_TASK_STATUS.BLOCKED,
];

/**
 * In-progress tasks (ACTIVE/PAUSED/BLOCKED) for the task progress card, most
 * recently updated first. Milestone/checklist are re-derived from domain state
 * first (idempotent, failures non-fatal) so the card never shows stale evidence.
 */
export async function listAgentTaskCards(): Promise<ActionResult<AgentTaskCardDTO[]>> {
  try {
    const user = await requireUser();
    const all = await listAgentTaskRecords(prisma, { userId: user.id, limit: 20 });
    const live = all.filter((task) => LIVE_TASK_STATUSES.includes(task.status));
    const cards: AgentTaskCardDTO[] = [];
    for (const row of live) {
      await syncAgentTaskDerivation(prisma, { userId: user.id, taskId: row.id }).catch(() => null);
      const task = (await getAgentTaskRecord(prisma, { userId: user.id, taskId: row.id })) ?? row;
      const handoff = await loadLatestHandoff(prisma, { userId: user.id, taskId: row.id }).catch(() => null);
      cards.push({
        task,
        nextAction:
          handoff && handoff.status === "ok" ? handoff.state.nextActions[0]?.action ?? null : null,
      });
    }
    return { success: true, data: cards };
  } catch (error) {
    return actionError(error, "Failed to list tasks.");
  }
}

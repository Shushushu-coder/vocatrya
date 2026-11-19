"use server";

import prisma from "@/lib/db";
import {
  AGENT_TASK_STATUS,
  AgentTaskError,
  createAgentTask as createAgentTaskRecord,
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
import { handleError } from "@/lib/utils";
import type { ActionResult } from "@/models/action.model";
import { requireUser } from "./shared";

/**
 * Agent long-task surface (card A skeleton, no UI). Every entry point
 * authenticates and passes the session user into the store, which scopes
 * each query by userId. Nothing here calls a model. Session creation
 * (resume -> Pilot conversation claim) is card C; resumeAgentTask only
 * re-activates the ledger row for now.
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
 * Placeholder: re-activates a paused/blocked task. Claiming a Pilot session
 * and returning a conversation id arrives with card C.
 */
export async function resumeAgentTask(
  taskId: string,
): Promise<ActionResult<AgentTaskDTO>> {
  try {
    const user = await requireUser();
    const data = await transitionAgentTaskStatus(prisma, {
      userId: user.id,
      taskId,
      to: AGENT_TASK_STATUS.ACTIVE,
    });
    return { success: true, data };
  } catch (error) {
    return actionError(error, "Failed to resume the task.");
  }
}

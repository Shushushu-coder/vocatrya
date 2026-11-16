"use server";

import prisma from "@/lib/db";
import { CareerRuntimeError } from "@/lib/career/errors";
import { assertPrepSurfaceEnabled } from "@/lib/interviewPrep/surfaceGate";
import {
  createPrepGoal,
  endPrepGoal,
  getPrepGoal,
  getPrepGoalForJob,
  linkPrepSession,
  listLinkablePrepSessions,
  pausePrepGoal,
  resumePrepGoal,
  startNewPrepRound,
  verifyAndSyncGoal,
} from "@/lib/interviewPrep/service";
import type {
  PrepGoalDTO,
  PrepLinkableSessionDTO,
} from "@/lib/interviewPrep/contract";
import { handleError } from "@/lib/utils";
import type { ActionResult } from "@/models/action.model";
import { requireUser } from "./shared";

/**
 * Interview prep goal surface: business commands only
 * (create/read/continue/pause/resume/end/new-round/link). The server owns
 * every transition and re-verifies progress from business records on each
 * read. Nothing here calls a model; any generation stays inside the
 * existing interview actions the user explicitly triggers.
 */
function actionError(error: unknown, msg: string): ActionResult<never> {
  if (error instanceof CareerRuntimeError) {
    return { success: false, message: error.message, code: error.code };
  }
  return handleError(error, msg) as ActionResult<never>;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function revisionOf(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : -1;
}

export async function createInterviewPrepGoal(input: {
  jobOpportunityId: string;
  requestKey: string;
  linkSessionId?: string | null;
}): Promise<ActionResult<{ goal: PrepGoalDTO; created: boolean }>> {
  try {
    const user = await requireUser();
    await assertPrepSurfaceEnabled(prisma);
    const { goal, created } = await createPrepGoal(prisma, user.id, {
      jobOpportunityId: input?.jobOpportunityId ?? "",
      requestKey: input?.requestKey ?? "",
      linkSessionId: input?.linkSessionId ?? null,
    });
    const dto = await verifyAndSyncGoal(prisma, user.id, goal.id);
    return { success: true, data: { goal: dto, created } };
  } catch (error) {
    return actionError(error, "Failed to create prep goal");
  }
}

/** Read + continue share one path: both return the freshly verified DTO. */
export async function getInterviewPrepGoalForJob(input: {
  jobOpportunityId: string;
}): Promise<ActionResult<{ goal: PrepGoalDTO | null }>> {
  try {
    const user = await requireUser();
    await assertPrepSurfaceEnabled(prisma);
    const goal = await getPrepGoalForJob(
      prisma,
      user.id,
      input?.jobOpportunityId ?? "",
    );
    return { success: true, data: { goal } };
  } catch (error) {
    return actionError(error, "Failed to load prep goal");
  }
}

/**
 * Continue preparation: re-verifies goal state before telling the client where to
 * go, so a stale page can never launch an outdated action.
 */
export async function continueInterviewPrepGoal(input: {
  goalId: string;
}): Promise<ActionResult<{ goal: PrepGoalDTO }>> {
  try {
    const user = await requireUser();
    await assertPrepSurfaceEnabled(prisma);
    const goal = await getPrepGoal(prisma, user.id, input?.goalId ?? "");
    return { success: true, data: { goal } };
  } catch (error) {
    return actionError(error, "Failed to continue prep goal");
  }
}

export async function pauseInterviewPrepGoal(input: {
  goalId: string;
  expectedRevision: number;
}): Promise<ActionResult<{ goal: PrepGoalDTO }>> {
  try {
    const user = await requireUser();
    await assertPrepSurfaceEnabled(prisma);
    const goal = await pausePrepGoal(prisma, user.id, {
      goalId: input?.goalId ?? "",
      expectedRevision: revisionOf(input?.expectedRevision),
    });
    return { success: true, data: { goal } };
  } catch (error) {
    return actionError(error, "Failed to pause prep goal");
  }
}

export async function resumeInterviewPrepGoal(input: {
  goalId: string;
  expectedRevision: number;
}): Promise<ActionResult<{ goal: PrepGoalDTO }>> {
  try {
    const user = await requireUser();
    await assertPrepSurfaceEnabled(prisma);
    const goal = await resumePrepGoal(prisma, user.id, {
      goalId: input?.goalId ?? "",
      expectedRevision: revisionOf(input?.expectedRevision),
    });
    return { success: true, data: { goal } };
  } catch (error) {
    return actionError(error, "Failed to resume prep goal");
  }
}

export async function endInterviewPrepGoal(input: {
  goalId: string;
  expectedRevision: number;
}): Promise<ActionResult<{ goal: PrepGoalDTO }>> {
  try {
    const user = await requireUser();
    await assertPrepSurfaceEnabled(prisma);
    const goal = await endPrepGoal(prisma, user.id, {
      goalId: input?.goalId ?? "",
      expectedRevision: revisionOf(input?.expectedRevision),
    });
    return { success: true, data: { goal } };
  } catch (error) {
    return actionError(error, "Failed to end prep goal");
  }
}

export async function startNewInterviewPrepRound(input: {
  goalId: string;
  expectedRevision: number;
  requestKey: string;
}): Promise<ActionResult<{ goal: PrepGoalDTO; created: boolean }>> {
  try {
    const user = await requireUser();
    await assertPrepSurfaceEnabled(prisma);
    const { goal, created } = await startNewPrepRound(prisma, user.id, {
      goalId: input?.goalId ?? "",
      expectedRevision: revisionOf(input?.expectedRevision),
      requestKey: input?.requestKey ?? "",
    });
    const dto = await verifyAndSyncGoal(prisma, user.id, goal.id);
    return { success: true, data: { goal: dto, created } };
  } catch (error) {
    return actionError(error, "Failed to start a new prep round");
  }
}

export async function listLinkableInterviewPrepSessions(input: {
  goalId: string;
}): Promise<ActionResult<{ sessions: PrepLinkableSessionDTO[] }>> {
  try {
    const user = await requireUser();
    await assertPrepSurfaceEnabled(prisma);
    if (!nonEmpty(input?.goalId)) {
      throw new CareerRuntimeError(
        "PREP_GOAL_REQUEST_INVALID",
        "A goal id is required.",
      );
    }
    const sessions = await listLinkablePrepSessions(
      prisma,
      user.id,
      input.goalId,
    );
    return { success: true, data: { sessions } };
  } catch (error) {
    return actionError(error, "Failed to list practice sessions");
  }
}

export async function linkInterviewPrepSession(input: {
  goalId: string;
  expectedRevision: number;
  sessionId: string;
}): Promise<ActionResult<{ goal: PrepGoalDTO }>> {
  try {
    const user = await requireUser();
    await assertPrepSurfaceEnabled(prisma);
    if (!nonEmpty(input?.sessionId)) {
      throw new CareerRuntimeError(
        "PREP_GOAL_REQUEST_INVALID",
        "A session id is required.",
      );
    }
    const goal = await linkPrepSession(prisma, user.id, {
      goalId: input.goalId ?? "",
      expectedRevision: revisionOf(input?.expectedRevision),
      sessionId: input.sessionId,
    });
    return { success: true, data: { goal } };
  } catch (error) {
    return actionError(error, "Failed to link practice session");
  }
}

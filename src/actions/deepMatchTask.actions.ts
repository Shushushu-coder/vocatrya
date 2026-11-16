"use server";

import prisma from "@/lib/db";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { isFullAbCapabilityEnabled } from "@/lib/career/capabilities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { careerMutationDeniedMessage } from "@/lib/career/userMessages";
import { listDeepMatchAnalyses } from "@/lib/career/deepMatchAnalyses";
import type {
  DeepMatchAnalysisItem,
  DeepMatchTaskDTO,
} from "@/lib/career/deepMatchContract";
import {
  createDeepMatchTask,
  getHarnessTask,
  getLatestDeepMatchTaskForJob,
  requestTaskCancel,
  requestTaskRetry,
  toDeepMatchTaskDTO,
} from "@/lib/harness/taskService";
import { kickHarnessRunner } from "@/lib/harness/runner";
import { handleError } from "@/lib/utils";
import type { ActionResult } from "@/models/action.model";
import { requireUser } from "./shared";

/**
 * Durable DEEP_MATCH task surface (RM-MATCH deep path).
 *
 * The client asks for business commands only — create/cancel/retry/read;
 * the server owns every state transition. `requestKey` is the create
 * identity: retransmits return the same task, a distinct user intent
 * mints a new key. The runner is kicked after a successful create/retry;
 * discovery never depends on the kick landing because claim reads the
 * database, not the page.
 */
async function assertMatchSurfaceEnabled() {
  const runtime = await resolveCareerRuntimeMode(prisma);
  if (!isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
    throw new CareerRuntimeError(
      "MATCH_UNAVAILABLE",
      careerMutationDeniedMessage(runtime.mode),
    );
  }
}

function actionError(error: unknown, msg: string): ActionResult<never> {
  if (error instanceof CareerRuntimeError) {
    return { success: false, message: error.message, code: error.code };
  }
  return handleError(error, msg) as ActionResult<never>;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

export async function startDeepMatchTask(input: {
  jobOpportunityId: string;
  resumeVariantVersionId: string;
  requestKey: string;
}): Promise<ActionResult<{ task: DeepMatchTaskDTO; created: boolean }>> {
  try {
    const user = await requireUser();
    await assertMatchSurfaceEnabled();
    if (
      !nonEmpty(input?.jobOpportunityId) ||
      !nonEmpty(input?.resumeVariantVersionId) ||
      !nonEmpty(input?.requestKey)
    ) {
      throw new CareerRuntimeError(
        "DEEP_MATCH_REQUEST_INVALID",
        "A job, a resume version and a request key are required.",
      );
    }
    const { task, created } = await createDeepMatchTask(prisma, user.id, {
      jobOpportunityId: input.jobOpportunityId,
      resumeVariantVersionId: input.resumeVariantVersionId,
      requestKey: input.requestKey,
    });
    if (created) kickHarnessRunner();
    return {
      success: true,
      data: { task: await toDeepMatchTaskDTO(prisma, task), created },
    };
  } catch (error) {
    return actionError(error, "Failed to start deep match");
  }
}

export async function getDeepMatchTask(input: {
  taskId: string;
}): Promise<ActionResult<{ task: DeepMatchTaskDTO }>> {
  try {
    const user = await requireUser();
    await assertMatchSurfaceEnabled();
    const task = await getHarnessTask(prisma, user.id, input?.taskId ?? "");
    return {
      success: true,
      data: { task: await toDeepMatchTaskDTO(prisma, task) },
    };
  } catch (error) {
    return actionError(error, "Failed to load deep match task");
  }
}

export async function getDeepMatchTaskForJob(input: {
  jobOpportunityId: string;
}): Promise<ActionResult<{ task: DeepMatchTaskDTO | null }>> {
  try {
    const user = await requireUser();
    await assertMatchSurfaceEnabled();
    const task = await getLatestDeepMatchTaskForJob(
      prisma,
      user.id,
      input?.jobOpportunityId ?? "",
    );
    return {
      success: true,
      data: { task: task ? await toDeepMatchTaskDTO(prisma, task) : null },
    };
  } catch (error) {
    return actionError(error, "Failed to load deep match task");
  }
}

export async function cancelDeepMatchTask(input: {
  taskId: string;
}): Promise<ActionResult<{ status: string }>> {
  try {
    const user = await requireUser();
    await assertMatchSurfaceEnabled();
    const data = await requestTaskCancel(prisma, user.id, input?.taskId ?? "");
    return { success: true, data };
  } catch (error) {
    return actionError(error, "Failed to cancel deep match");
  }
}

export async function retryDeepMatchTask(input: {
  taskId: string;
}): Promise<ActionResult<{ task: DeepMatchTaskDTO }>> {
  try {
    const user = await requireUser();
    await assertMatchSurfaceEnabled();
    const task = await requestTaskRetry(prisma, user.id, input?.taskId ?? "");
    kickHarnessRunner();
    return {
      success: true,
      data: { task: await toDeepMatchTaskDTO(prisma, task) },
    };
  } catch (error) {
    return actionError(error, "Failed to retry deep match");
  }
}

export async function listDeepMatchAnalysisItems(input: {
  jobOpportunityId: string;
}): Promise<ActionResult<DeepMatchAnalysisItem[]>> {
  try {
    const user = await requireUser();
    await assertMatchSurfaceEnabled();
    const data = await listDeepMatchAnalyses(
      prisma,
      user.id,
      input?.jobOpportunityId ?? "",
    );
    return { success: true, data };
  } catch (error) {
    return actionError(error, "Failed to load deep match results");
  }
}

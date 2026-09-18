"use server";
import prisma from "@/lib/db";
import { ApplicationService } from "@/lib/career/applicationService";
import type { ApplicationTimelineDTO } from "@/lib/career/applicationTimeline";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { handleError } from "@/lib/utils";
import type { ActionResult } from "@/models/action.model";
import { revalidatePath } from "next/cache";
import { requireUser } from "./shared";
import type { ApplicationProcessStep } from "@prisma/client";

function isAbReadMode(mode: string): boolean {
  return (
    mode === CAREER_RUNTIME_MODE.AB_ENABLED ||
    mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED
  );
}

function assertAbApplicationWrites(mode: string): void {
  if (mode === CAREER_RUNTIME_MODE.AB_ENABLED) return;
  throw new CareerRuntimeError(
    "JOB_MUTATIONS_DISABLED",
    `Application process steps cannot be mutated in ${mode}`,
  );
}

function parseOptionalDate(value: Date | string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CareerRuntimeError("PROCESS_STEP_SCHEDULE_INVALID", "scheduledAt is invalid");
  }
  return parsed;
}

function applicationsFor(userId: string) {
  return new ApplicationService(prisma, userId);
}

export async function getApplicationTimeline(
  jobOpportunityId: string,
): Promise<ActionResult<ApplicationTimelineDTO>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (!isAbReadMode(runtime.mode)) {
      throw new CareerRuntimeError(
        "APPLICATION_TIMELINE_UNAVAILABLE",
        `Application timeline is not available in ${runtime.mode}`,
      );
    }
    const data = await applicationsFor(user.id).getTimeline(jobOpportunityId);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load application timeline.");
  }
}

export async function createApplicationProcessStep(input: {
  jobOpportunityId: string;
  category: string;
  label: string;
  scheduledAt?: Date | string | null;
  notes?: string | null;
}): Promise<ActionResult<ApplicationProcessStep>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime.mode);
    const data = await applicationsFor(user.id).createUserProcessStep({
      jobOpportunityId: input.jobOpportunityId,
      category: input.category,
      label: input.label,
      scheduledAt: parseOptionalDate(input.scheduledAt) ?? null,
      notes: input.notes ?? null,
    });
    revalidatePath("/dashboard");
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to create process step.");
  }
}

export async function updateApplicationProcessStep(input: {
  stepId: string;
  category?: string;
  label?: string;
  scheduledAt?: Date | string | null;
  notes?: string | null;
  result?: string | null;
}): Promise<ActionResult<ApplicationProcessStep>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime.mode);
    const data = await applicationsFor(user.id).updateUserProcessStep({
      stepId: input.stepId,
      category: input.category,
      label: input.label,
      scheduledAt: parseOptionalDate(input.scheduledAt),
      notes: input.notes,
      result: input.result,
    });
    revalidatePath("/dashboard");
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to update process step.");
  }
}

export async function completeApplicationProcessStep(
  stepId: string,
): Promise<ActionResult<ApplicationProcessStep>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime.mode);
    const data = await applicationsFor(user.id).completeProcessStep(stepId);
    revalidatePath("/dashboard");
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to complete process step.");
  }
}

"use server";
import prisma from "@/lib/db";
import { ApplicationService } from "@/lib/career/applicationService";
import type { ApplicationTimelineDTO } from "@/lib/career/applicationTimeline";
import type {
  InterviewReflectionDTO,
  SaveInterviewReflectionInput,
} from "@/lib/career/interviewReflection";
import {
  listUpcomingApplicationEvents as queryUpcomingApplicationEvents,
  type UpcomingApplicationEvent,
} from "@/lib/career/upcomingReadModel";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { assertCareerDataWritable } from "@/lib/career/access";
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

function parseOptionalDate(
  value: Date | string | null | undefined,
  field: string,
): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  if (value instanceof Date) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new CareerRuntimeError(
      field === "deadlineAt"
        ? "PROCESS_STEP_DEADLINE_INVALID"
        : "PROCESS_STEP_SCHEDULE_INVALID",
      `${field} is invalid`,
    );
  }
  return parsed;
}

function applicationsFor(userId: string) {
  return new ApplicationService(prisma, userId);
}

export async function getInterviewReflection(
  stepId: string,
): Promise<ActionResult<InterviewReflectionDTO>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (!isAbReadMode(runtime.mode)) {
      throw new CareerRuntimeError(
        "APPLICATION_TIMELINE_UNAVAILABLE",
        `Interview reflection is not available in ${runtime.mode}`,
      );
    }
    const data = await applicationsFor(user.id).getInterviewReflection(stepId);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load interview reflection.");
  }
}

export async function saveInterviewReflection(
  input: SaveInterviewReflectionInput,
): Promise<ActionResult<InterviewReflectionDTO>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime.mode);
    const data = await applicationsFor(user.id).saveInterviewReflection({
      applicationProcessStepId: input.applicationProcessStepId,
      reflectionText: input.reflectionText,
      items: input.items ?? [],
    });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to save interview reflection.");
  }
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

export async function listUpcomingApplicationEvents(): Promise<
  ActionResult<UpcomingApplicationEvent[]>
> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (!isAbReadMode(runtime.mode)) {
      throw new CareerRuntimeError(
        "UPCOMING_UNAVAILABLE",
        `Upcoming events are not available in ${runtime.mode}`,
      );
    }
    const data = await queryUpcomingApplicationEvents(prisma, user.id);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load upcoming events.");
  }
}

export async function createApplicationProcessStep(input: {
  jobOpportunityId: string;
  category: string;
  label: string;
  scheduledAt?: Date | string | null;
  deadlineAt?: Date | string | null;
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
      scheduledAt: parseOptionalDate(input.scheduledAt, "scheduledAt") ?? null,
      deadlineAt: parseOptionalDate(input.deadlineAt, "deadlineAt") ?? null,
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
  deadlineAt?: Date | string | null;
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
      scheduledAt: parseOptionalDate(input.scheduledAt, "scheduledAt"),
      deadlineAt: parseOptionalDate(input.deadlineAt, "deadlineAt"),
      notes: input.notes,
      result: input.result,
    });
    revalidatePath("/dashboard");
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to update process step.");
  }
}

export async function createTransferredAttempt(input: {
  sourceAttemptId: string;
  targetJobOpportunityId: string;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime.mode);
    const data = await applicationsFor(user.id).createTransferredAttempt({
      sourceAttemptId: input.sourceAttemptId,
      targetJobOpportunityId: input.targetJobOpportunityId,
    });
    revalidatePath("/dashboard");
    return { success: true, data: { id: data.id } };
  } catch (error) {
    return handleError(error, "Failed to transfer application.");
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

export async function submitAttemptResumeVersion(input: {
  attemptId: string;
  submittedResumeVersionId: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertCareerDataWritable(prisma as never);
    if (
      typeof input?.attemptId !== "string" ||
      input.attemptId.trim() === "" ||
      typeof input?.submittedResumeVersionId !== "string" ||
      input.submittedResumeVersionId.trim() === ""
    ) {
      throw new CareerRuntimeError("INVALID_ID", "Invalid submit binding input");
    }
    const data = await applicationsFor(user.id).markSubmitted({
      attemptId: input.attemptId.trim(),
      submittedResumeVersionId: input.submittedResumeVersionId.trim(),
    });
    revalidatePath("/dashboard");
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to bind submitted resume version.");
  }
}

export async function deleteApplicationProcessStep(
  stepId: string,
): Promise<ActionResult<ApplicationProcessStep>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime.mode);
    const data = await applicationsFor(user.id).deleteUserProcessStep(stepId);
    revalidatePath("/dashboard");
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to delete process step.");
  }
}

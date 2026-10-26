"use server";
import prisma from "@/lib/db";
import { ApplicationService } from "@/lib/career/applicationService";
import type {
  ApplicationTimelineDTO,
  SubmittedResumeBindingsDTO,
  TransferTargetPageDTO,
} from "@/lib/career/applicationTimeline";
import type {
  InterviewReflectionDTO,
  SaveInterviewReflectionInput,
} from "@/lib/career/interviewReflection";
import {
  listUpcomingApplicationEvents as queryUpcomingApplicationEvents,
  type UpcomingApplicationEvent,
} from "@/lib/career/upcomingReadModel";
import { listJobs } from "@/lib/career/jobsReadDispatch";
import {
  assertResumeV1Readable,
  assertResumeV1Writable,
  isFullAbCapabilityEnabled,
} from "@/lib/career/capabilities";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { CareerRuntimeError } from "@/lib/career/errors";
import {
  CAREER_REFLECTION_UNAVAILABLE_MESSAGE,
  CAREER_TIMELINE_UNAVAILABLE_MESSAGE,
  CAREER_UPCOMING_UNAVAILABLE_MESSAGE,
  careerMutationDeniedMessage,
} from "@/lib/career/userMessages";
import {
  resolveCareerRuntimeMode,
  type CareerRuntimeResolution,
} from "@/lib/career/runtimeMode";
import { handleError } from "@/lib/utils";
import type { ActionResult } from "@/models/action.model";
import { revalidatePath } from "next/cache";
import { requireUser } from "./shared";
import type { ApplicationProcessStep } from "@prisma/client";

function isFullAbReadSurface(runtime: CareerRuntimeResolution): boolean {
  if (runtime.mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED) return true;
  return isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope);
}

function assertAbApplicationWrites(runtime: CareerRuntimeResolution): void {
  if (isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope)) return;
  throw new CareerRuntimeError(
    "JOB_MUTATIONS_DISABLED",
    careerMutationDeniedMessage(runtime.mode),
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
    if (!isFullAbReadSurface(runtime)) {
      throw new CareerRuntimeError(
        "APPLICATION_TIMELINE_UNAVAILABLE",
        CAREER_REFLECTION_UNAVAILABLE_MESSAGE,
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
    assertAbApplicationWrites(runtime);
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

export async function getSubmittedResumeBindings(
  legacyJobId: string,
): Promise<ActionResult<SubmittedResumeBindingsDTO>> {
  try {
    const user = await requireUser();
    await assertResumeV1Readable(prisma as never);
    if (typeof legacyJobId !== "string" || legacyJobId.trim() === "") {
      throw new CareerRuntimeError("INVALID_ID", "Invalid job id");
    }
    const data =
      await applicationsFor(user.id).getSubmittedResumeBindingsForLegacyJob(
        legacyJobId.trim(),
      );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load submitted resume binding.");
  }
}

export async function getApplicationTimeline(
  jobOpportunityId: string,
): Promise<ActionResult<ApplicationTimelineDTO>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (!isFullAbReadSurface(runtime)) {
      throw new CareerRuntimeError(
        "APPLICATION_TIMELINE_UNAVAILABLE",
        CAREER_TIMELINE_UNAVAILABLE_MESSAGE,
      );
    }
    const data = await applicationsFor(user.id).getTimeline(jobOpportunityId);
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load application timeline.");
  }
}

// Transfer targets come from the same read path as the jobs list so the
// picker shows exactly the positions the user owns in the current runtime
// family. Rows the picker offers must stay transfer-legal: the source
// opportunity is excluded and the service still re-validates everything.
const TRANSFER_TARGET_LIMIT = 200;

export async function listTransferTargetOpportunities(
  excludeJobOpportunityId?: string,
  offset = 0,
): Promise<ActionResult<TransferTargetPageDTO>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (!isFullAbReadSurface(runtime)) {
      throw new CareerRuntimeError(
        "APPLICATION_TIMELINE_UNAVAILABLE",
        CAREER_TIMELINE_UNAVAILABLE_MESSAGE,
      );
    }
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw new CareerRuntimeError("INVALID_OFFSET", "Invalid page offset");
    }
    const result = await listJobs(prisma, user.id, {
      skip: offset,
      take: TRANSFER_TARGET_LIMIT,
    });
    if (result.blocked) {
      return { success: false, message: result.message };
    }
    const rows = result.data as Array<{
      id?: string | null;
      JobTitle?: { label?: string | null } | null;
      Company?: { label?: string | null } | null;
    }>;
    const data = rows
      .filter(
        (job) =>
          typeof job?.id === "string" &&
          job.id !== "" &&
          job.id !== excludeJobOpportunityId,
      )
      .map((job) => ({
        id: job.id as string,
        title: job.JobTitle?.label ?? "",
        company: job.Company?.label ?? "",
      }));
    const nextOffset = offset + rows.length;
    return {
      success: true,
      data: { items: data, nextOffset: nextOffset < result.total ? nextOffset : null },
    };
  } catch (error) {
    return handleError(error, "Failed to load transfer targets.");
  }
}

export async function listUpcomingApplicationEvents(): Promise<
  ActionResult<UpcomingApplicationEvent[]>
> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    if (!isFullAbReadSurface(runtime)) {
      throw new CareerRuntimeError(
        "UPCOMING_UNAVAILABLE",
        CAREER_UPCOMING_UNAVAILABLE_MESSAGE,
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
  applicationAttemptId?: string | null;
  createDraftAttempt?: boolean;
  category: string;
  label: string;
  scheduledAt?: Date | string | null;
  deadlineAt?: Date | string | null;
  notes?: string | null;
}): Promise<ActionResult<ApplicationProcessStep>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime);
    const applicationAttemptId = input.applicationAttemptId ?? undefined;
    if (
      applicationAttemptId !== undefined &&
      (typeof applicationAttemptId !== "string" ||
        applicationAttemptId.trim() === "")
    ) {
      throw new CareerRuntimeError(
        "INVALID_ID",
        "Invalid application attempt id",
      );
    }
    const data = await applicationsFor(user.id).createUserProcessStep({
      jobOpportunityId: input.jobOpportunityId,
      applicationAttemptId: applicationAttemptId?.trim(),
      createDraftAttempt: input.createDraftAttempt === true,
      category: input.category,
      label: input.label,
      scheduledAt: parseOptionalDate(input.scheduledAt, "scheduledAt") ?? null,
      deadlineAt: parseOptionalDate(input.deadlineAt, "deadlineAt") ?? null,
      notes: input.notes ?? null,
    });
    revalidatePath("/dashboard");
    return { success: true, data };
  } catch (error) {
    const result = handleError(error, "Failed to create process step.");
    if (error instanceof CareerRuntimeError) {
      return { success: false, code: error.code, message: result.message };
    }
    return result;
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
    assertAbApplicationWrites(runtime);
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

export async function createApplicationAttempt(input: {
  jobOpportunityId: string;
  channelLabel: string;
  channelCategory?: string | null;
  sourceUrl?: string | null;
  notes?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime);
    if (
      typeof input?.jobOpportunityId !== "string" ||
      input.jobOpportunityId.trim() === ""
    ) {
      throw new CareerRuntimeError("INVALID_ID", "Invalid job id");
    }
    if (
      typeof input?.channelLabel !== "string" ||
      input.channelLabel.trim() === ""
    ) {
      throw new CareerRuntimeError(
        "ATTEMPT_CHANNEL_REQUIRED",
        "Application channel is required",
      );
    }
    const data = await applicationsFor(user.id).createAttempt({
      jobOpportunityId: input.jobOpportunityId.trim(),
      channelLabel: input.channelLabel.trim(),
      channelCategory: input.channelCategory ?? null,
      sourceUrl: input.sourceUrl ?? null,
      notes: input.notes ?? null,
      createdVia: "USER",
    });
    revalidatePath("/dashboard");
    return { success: true, data: { id: data.id } };
  } catch (error) {
    const result = handleError(error, "Failed to create application.");
    if (error instanceof CareerRuntimeError) {
      return { success: false, code: error.code, message: result.message };
    }
    return result;
  }
}

export async function createTransferredAttempt(input: {
  sourceAttemptId: string;
  targetJobOpportunityId: string;
}): Promise<ActionResult<{ id: string }>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime);
    const data = await applicationsFor(user.id).createTransferredAttempt({
      sourceAttemptId: input.sourceAttemptId,
      targetJobOpportunityId: input.targetJobOpportunityId,
    });
    revalidatePath("/dashboard");
    return { success: true, data: { id: data.id } };
  } catch (error) {
    const result = handleError(error, "Failed to transfer application.");
    if (error instanceof CareerRuntimeError) {
      return { success: false, code: error.code, message: result.message };
    }
    return result;
  }
}

export async function completeApplicationProcessStep(
  stepId: string,
): Promise<ActionResult<ApplicationProcessStep>> {
  try {
    const user = await requireUser();
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertAbApplicationWrites(runtime);
    const data = await applicationsFor(user.id).completeProcessStep(stepId);
    revalidatePath("/dashboard");
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to complete process step.");
  }
}

export async function attachAttemptResumeVersion(input: {
  attemptId: string;
  submittedResumeVersionId: string;
}): Promise<ActionResult> {
  try {
    const user = await requireUser();
    await assertResumeV1Writable(prisma as never);
    if (
      typeof input?.attemptId !== "string" ||
      input.attemptId.trim() === "" ||
      typeof input?.submittedResumeVersionId !== "string" ||
      input.submittedResumeVersionId.trim() === ""
    ) {
      throw new CareerRuntimeError("INVALID_ID", "Invalid provenance binding input");
    }
    const data = await applicationsFor(user.id).attachSubmissionProvenance({
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
    assertAbApplicationWrites(runtime);
    const data = await applicationsFor(user.id).deleteUserProcessStep(stepId);
    revalidatePath("/dashboard");
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to delete process step.");
  }
}

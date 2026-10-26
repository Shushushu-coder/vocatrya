"use server";
import { saveMatchInTransaction } from "@/lib/jobs/generatedResults";
import prisma from "@/lib/db";
import { isFullAbCapabilityEnabled } from "@/lib/career/capabilities";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { careerMutationDeniedMessage } from "@/lib/career/userMessages";
import { syncApplicationFromUiStatus } from "@/lib/career/jobOpportunityAdapter";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { assertLegacyCareerWriteAllowed } from "@/lib/career/writeGuard";
import { handleError } from "@/lib/utils";
import { localizedJobError } from "./mutations";
import { JobStatus } from "@/models/job.model";
import { revalidatePath } from "next/cache";
import { requireUser } from "../shared";

export const updateJobStatus = async (
  jobId: string,
  status: JobStatus,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    // appliedDate is the first-ever application timestamp: setting the
    // "applied" stage must not rewrite a date that already exists, and later
    // stages never touch it.
    const dataToUpdate = (currentAppliedDate: Date | null | undefined) => {
      switch (status.value) {
        case "applied":
          return {
            statusId: status.id,
            applied: true,
            appliedDate: currentAppliedDate ?? new Date(),
          };
        case "interview":
          return {
            statusId: status.id,
            applied: true,
          };
        default:
          return {
            statusId: status.id,
          };
      }
    };

    const runtime = await resolveCareerRuntimeMode(prisma);
    if (
      runtime.mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED ||
      runtime.mode === CAREER_RUNTIME_MODE.BLOCKED
    ) {
      throw new CareerRuntimeError(
        runtime.mode === CAREER_RUNTIME_MODE.BLOCKED
          ? "CAREER_RUNTIME_BLOCKED"
          : "JOB_MUTATIONS_DISABLED",
        careerMutationDeniedMessage(runtime.mode),
      );
    }
    if (isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
      // Header status writes Attempt stage/outcome only. It must not touch
      // legacy Job rows or create ApplicationProcessStep records.
      await syncApplicationFromUiStatus(prisma, user.id, jobId, status.value, {
        applied: status.value === "applied" || status.value === "interview",
      });
      revalidatePath("/dashboard");
      return { success: true };
    }

    await assertLegacyCareerWriteAllowed(prisma);
    const current = await prisma.job.findFirst({
      where: { id: jobId, userId: user.id },
      select: { appliedDate: true },
    });
    const job = await prisma.job.update({
      where: {
        id: jobId,
        userId: user.id,
      },
      data: dataToUpdate(current?.appliedDate),
    });
    revalidatePath("/dashboard");
    return { job, success: true };
  } catch (error) {
    const msg = "Failed to update job status.";
    return localizedJobError(error, msg);
  }
};

export const saveJobMatchResult = async (
  jobId: string,
  matchScore: number,
  matchData: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    await saveMatchInTransaction(prisma, user.id, jobId, matchScore, matchData);

    return { success: true };
  } catch (error) {
    const msg = "Failed to save match result.";
    return handleError(error, msg);
  }
};

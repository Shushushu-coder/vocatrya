"use server";
import prisma from "@/lib/db";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { syncApplicationFromUiStatus } from "@/lib/career/jobOpportunityAdapter";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { assertLegacyCareerWriteAllowed } from "@/lib/career/writeGuard";
import { handleError } from "@/lib/utils";
import { JobStatus } from "@/models/job.model";
import { revalidatePath } from "next/cache";
import { requireUser } from "../shared";

export const updateJobStatus = async (
  jobId: string,
  status: JobStatus,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();
    const dataToUpdate = () => {
      switch (status.value) {
        case "applied":
          return {
            statusId: status.id,
            applied: true,
            appliedDate: new Date(),
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
        `Job mutations are not allowed in ${runtime.mode}`,
      );
    }
    if (runtime.mode === CAREER_RUNTIME_MODE.AB_ENABLED) {
      await syncApplicationFromUiStatus(prisma, user.id, jobId, status.value, {
        applied: status.value === "applied" || status.value === "interview",
      });
      revalidatePath("/dashboard");
      return { success: true };
    }

    await assertLegacyCareerWriteAllowed(prisma);
    const job = await prisma.job.update({
      where: {
        id: jobId,
        userId: user.id,
      },
      data: dataToUpdate(),
    });
    revalidatePath("/dashboard");
    return { job, success: true };
  } catch (error) {
    const msg = "Failed to update job status.";
    return handleError(error, msg);
  }
};

export const saveJobMatchResult = async (
  jobId: string,
  matchScore: number,
  matchData: string,
): Promise<any | undefined> => {
  try {
    const user = await requireUser();

    await assertLegacyCareerWriteAllowed(prisma);
    await prisma.job.update({
      where: { id: jobId, userId: user.id },
      data: { matchScore, matchData },
    });

    return { success: true };
  } catch (error) {
    const msg = "Failed to save match result.";
    return handleError(error, msg);
  }
};

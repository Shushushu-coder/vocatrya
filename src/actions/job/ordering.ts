"use server";
import prisma from "@/lib/db";
import { handleError } from "@/lib/utils";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { assertJobMutationsAllowed } from "@/lib/career/jobMutationGate";
import { applyJobOrderChange } from "@/lib/career/jobOrderService";
import { JobOrderError, type JobOrderChange } from "@/lib/jobs/jobOrder";
import { revalidatePath } from "next/cache";
import { requireUser } from "../shared";
import { getServerI18n } from "@/i18n/server";

// Ordering writes ride the same gates as every other job mutation: a signed-in
// user, a readable jobs family (blocked runtimes get the shared
// jobs-unavailable message) and the mutation capability for that mode.
async function runOrderChange(change: JobOrderChange) {
  try {
    const user = await requireUser();
    const { family } = await resolveJobsReadFamily(prisma);
    if (family === "blocked") {
      const { t } = await getServerI18n();
      return { success: false, message: t("errors.careerJobsUnavailable") };
    }
    const runtime = await resolveCareerRuntimeMode(prisma);
    assertJobMutationsAllowed(runtime.mode);
    await applyJobOrderChange(prisma, family, user.id, change);
    revalidatePath("/dashboard");
    return { success: true };
  } catch (error) {
    if (error instanceof JobOrderError) {
      return { success: false, message: error.message };
    }
    return handleError(error, "Failed to save job order. ");
  }
}

export const reorderJob = async (
  jobId: string,
  afterJobId: string | null,
): Promise<any | undefined> => {
  if (!jobId) {
    return { success: false, message: "Please provide job id" };
  }
  return runOrderChange({ kind: "move", jobId, afterJobId });
};

export const setJobPinned = async (
  jobId: string,
  pinned: boolean,
): Promise<any | undefined> => {
  if (!jobId) {
    return { success: false, message: "Please provide job id" };
  }
  return runOrderChange({ kind: pinned ? "pin" : "unpin", jobId });
};

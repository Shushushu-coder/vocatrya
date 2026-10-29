"use server";
import prisma from "@/lib/db";
import { requireUser } from "./shared";
import { revalidatePath } from "next/cache";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { isFullAbCapabilityEnabled } from "@/lib/career/capabilities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { careerMutationDeniedMessage } from "@/lib/career/userMessages";
import {
  listArchivedOpportunities,
  unarchiveOpportunity,
} from "@/lib/career/jobOpportunityAdapter";
import { localizedJobError } from "./job/mutations";

export type ArchivedJobItem = {
  id: string;
  title: string;
  company: string;
  status: string;
  archivedAt: string;
  updatedAt: string;
};

/**
 * Archive Center job surface:
 * - "ab": canonical jobs exist and reversible archive is available.
 * - "legacy": this instance runs Legacy jobs only — archive does not apply
 *   (D1 boundary; a Legacy row's archived status cannot restore its prior
 *   status, so it is never mixed into this list).
 * - "blocked": career runtime is unavailable.
 */
export type ArchivedJobSurface =
  | { kind: "ab"; jobs: ArchivedJobItem[] }
  | { kind: "legacy" }
  | { kind: "blocked" };

async function archivedJobSurfaceKind(): Promise<"ab" | "legacy" | "blocked"> {
  const runtime = await resolveCareerRuntimeMode(prisma);
  if (isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
    return "ab";
  }
  return runtime.mode === "BLOCKED" || runtime.mode === "AB_READY_DISABLED"
    ? "blocked"
    : "legacy";
}

export const listArchivedJobs = async (input?: {
  search?: string;
}): Promise<{
  success: boolean;
  data?: ArchivedJobSurface;
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    const kind = await archivedJobSurfaceKind();
    if (kind !== "ab") {
      return { success: true, data: { kind } };
    }
    const rows = await listArchivedOpportunities(
      prisma,
      user.id,
      input?.search,
    );
    return {
      success: true,
      data: {
        kind: "ab",
        jobs: rows.map((row) => ({
          id: row.id,
          title: row.title,
          company: row.company.label,
          status: row.status,
          archivedAt: row.archivedAt!.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
      },
    };
  } catch (error) {
    return localizedJobError(error, "Failed to list archived jobs.");
  }
};

export const restoreArchivedJob = async (
  jobId: string,
): Promise<
  | { success: true }
  | { success: false; message: string; code?: string }
> => {
  try {
    const user = await requireUser();
    const kind = await archivedJobSurfaceKind();
    if (kind !== "ab") {
      throw new CareerRuntimeError(
        "JOB_MUTATIONS_DISABLED",
        careerMutationDeniedMessage(
          kind === "blocked" ? "BLOCKED" : "LEGACY_ONLY",
        ),
      );
    }
    const row = await unarchiveOpportunity(prisma, user.id, jobId);
    if (!row) {
      throw new CareerRuntimeError(
        "OPPORTUNITY_NOT_FOUND",
        "Opportunity not found",
      );
    }
    revalidatePath("/dashboard");
    revalidatePath("/dashboard/myjobs");
    revalidatePath("/dashboard/settings");
    return { success: true };
  } catch (error) {
    return localizedJobError(error, "Failed to restore the job.");
  }
};

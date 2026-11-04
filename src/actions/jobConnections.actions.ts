"use server";
import prisma from "@/lib/db";
import { getJobConnections as readJobConnections } from "@/lib/career/jobOpportunityAdapter";
import type { JobConnectionsDTO } from "@/lib/career/applicationTimeline";
import { CareerRuntimeError } from "@/lib/career/errors";
import { handleError } from "@/lib/utils";
import type { ActionResult } from "@/models/action.model";
import { requireUser } from "./shared";

/**
 * P-B JOB-CONNECTIONS aggregate read for the job-details "planned vs actual
 * submission" comparison (contract §14.1). Read-only; the capability gate
 * (`assertFullAbReadable`) and ownership checks live in the read model.
 */
export async function getJobConnections(
  jobOpportunityId: string,
): Promise<ActionResult<JobConnectionsDTO>> {
  try {
    const user = await requireUser();
    if (
      typeof jobOpportunityId !== "string" ||
      jobOpportunityId.trim() === ""
    ) {
      throw new CareerRuntimeError("INVALID_ID", "Invalid job id");
    }
    const data = await readJobConnections(
      prisma,
      user.id,
      jobOpportunityId.trim(),
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load job connections.");
  }
}

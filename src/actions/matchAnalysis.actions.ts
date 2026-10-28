"use server";

import prisma from "@/lib/db";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { isFullAbCapabilityEnabled } from "@/lib/career/capabilities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { careerMutationDeniedMessage } from "@/lib/career/userMessages";
import {
  loadFastScreeningPreflight,
  listFastScreeningAnalyses,
  runFastScreening,
} from "@/lib/career/fastScreening";
import type {
  FastScreeningPreflight,
  FastScreeningRunResult,
  FastScreeningSource,
  MatchAnalysisListItem,
} from "@/lib/career/fastScreeningContract";
import { handleError } from "@/lib/utils";
import type { ActionResult } from "@/models/action.model";
import { requireUser } from "./shared";

/**
 * Canonical minimal match chain actions (RM-MATCH, FAST_SCREENING only).
 * The same full-A+B capability contract the MatchAnalysisService enforces
 * is checked up front so an unavailable surface reports the runtime
 * message instead of a generic failure. A run's business failures
 * (missing JD, insufficient material, connection/execution errors) come
 * back inside `data.kind === "failed"` — they are retryable outcomes,
 * not action-call failures.
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

function parseSource(input: FastScreeningSource | undefined): FastScreeningSource {
  if (input?.kind === "career-profile") {
    return { kind: "career-profile" };
  }
  if (
    input?.kind === "resume-version" &&
    typeof input.versionId === "string" &&
    input.versionId.trim() !== ""
  ) {
    return { kind: "resume-version", versionId: input.versionId };
  }
  throw new CareerRuntimeError(
    "MATCH_SOURCE_INVALID",
    "Choose a career profile or a resume version to match against.",
  );
}

export async function getFastScreeningPreflight(input: {
  jobOpportunityId: string;
}): Promise<ActionResult<FastScreeningPreflight>> {
  try {
    const user = await requireUser();
    await assertMatchSurfaceEnabled();
    const data = await loadFastScreeningPreflight(
      prisma,
      user.id,
      input?.jobOpportunityId ?? "",
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load match preflight");
  }
}

export async function listMatchAnalyses(input: {
  jobOpportunityId: string;
}): Promise<ActionResult<MatchAnalysisListItem[]>> {
  try {
    const user = await requireUser();
    await assertMatchSurfaceEnabled();
    const data = await listFastScreeningAnalyses(
      prisma,
      user.id,
      input?.jobOpportunityId ?? "",
    );
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to load match analyses");
  }
}

export async function runFastScreeningMatch(input: {
  jobOpportunityId: string;
  source: FastScreeningSource;
}): Promise<ActionResult<FastScreeningRunResult>> {
  try {
    const user = await requireUser();
    await assertMatchSurfaceEnabled();
    const data = await runFastScreening(prisma, user.id, {
      jobOpportunityId: input?.jobOpportunityId ?? "",
      source: parseSource(input?.source),
    });
    return { success: true, data };
  } catch (error) {
    return handleError(error, "Failed to run fast screening");
  }
}

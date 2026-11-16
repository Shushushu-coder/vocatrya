import "server-only";

import type { PrismaClient } from "@prisma/client";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { isFullAbCapabilityEnabled } from "@/lib/career/capabilities";
import { CareerRuntimeError } from "@/lib/career/errors";
import { careerMutationDeniedMessage } from "@/lib/career/userMessages";

/**
 * Shared capability gate for every prep-goal surface. The goal feature is a
 * canonical-mutation surface, so it follows the same full-AB contract as the
 * rest of the canonical writes — never loosened per entry point. Call this
 * from the goal actions AND from the goal-bound interview session creation
 * path; hiding the tab in JobDetails is only a UX mirror of this rule.
 */
export async function assertPrepSurfaceEnabled(db: PrismaClient) {
  const runtime = await resolveCareerRuntimeMode(db);
  if (!isFullAbCapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
    throw new CareerRuntimeError(
      "PREP_GOAL_UNAVAILABLE",
      careerMutationDeniedMessage(runtime.mode),
    );
  }
}

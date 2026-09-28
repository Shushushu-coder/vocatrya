import "server-only";

/**
 * Interview product readiness — the single "can the user start a new
 * interview" answer, computed with the exact same resolver session
 * creation uses (resolveInterviewAiRuntime over the INTERVIEW business
 * assignment chain).
 *
 * Semantics mirror creation time:
 * - RESOLVED (INTERVIEW assignment or GLOBAL_DEFAULT) → ready
 * - LEGACY_INTERVIEW_CONFIG (settings.ai.interview) → ready
 * - INVALID_ASSIGNMENT → not ready; the explicit broken assignment is
 *   reported verbatim, never masked by a fallback
 * - NOT_CONFIGURED → not ready
 *
 * This intentionally replaces the legacy-only `getInterviewConfig` check
 * as the product gate. Existing sessions never consult this value — they
 * execute against their persisted AI lock instead.
 */
import {
  resolveInterviewAiRuntime,
  type InterviewAiRuntimePlan,
} from "./interviewRuntimePlan";
import type { AIBusinessErrorCode } from "@/lib/ai/connections";
import type { PrismaClient } from "@prisma/client";

export type InterviewReadinessSource =
  | "BUSINESS_ASSIGNMENT"
  | "GLOBAL_DEFAULT"
  | "LEGACY_INTERVIEW_CONFIG";

export type InterviewReadiness =
  | {
      status: "ready";
      source: InterviewReadinessSource;
      provider: string;
      model: string;
    }
  | { status: "not_configured" }
  | { status: "invalid_assignment"; code: AIBusinessErrorCode };

export function readinessFromPlan(
  plan: InterviewAiRuntimePlan,
): InterviewReadiness {
  if (plan.kind === "account") {
    return {
      status: "ready",
      source: plan.assignmentSource,
      provider: plan.provider,
      model: plan.model,
    };
  }
  if (plan.kind === "legacy") {
    return {
      status: "ready",
      source: "LEGACY_INTERVIEW_CONFIG",
      provider: plan.provider,
      model: plan.model,
    };
  }
  if (plan.kind === "invalid") {
    return { status: "invalid_assignment", code: plan.code };
  }
  return { status: "not_configured" };
}

export async function getInterviewReadiness(
  userId: string,
  dbClient?: Parameters<typeof resolveInterviewAiRuntime>[1],
): Promise<InterviewReadiness> {
  const { plan } = await resolveInterviewAiRuntime(
    userId,
    dbClient as PrismaClient | undefined,
  );
  return readinessFromPlan(plan);
}

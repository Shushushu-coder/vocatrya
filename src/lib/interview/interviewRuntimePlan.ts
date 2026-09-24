/**
 * Interview AI runtime plan — resolves the INTERVIEW business assignment
 * once, at InterviewSession creation time. The lock fields are persisted
 * on the session row atomically with its creation; the plan tells the
 * model port which execution path the session is bound to.
 *
 * Semantics (frozen):
 * - RESOLVED → session locked to that connectionId + model, executed via
 *   the account runtime (TEXT_ONLY one-shot). A later assignment change
 *   must not affect this session.
 * - LEGACY_INTERVIEW_CONFIG → session locked to the legacy
 *   provider/model pair (encoded lock, `resolvedConnectionId` stays
 *   null). Later `settings.ai.interview` edits must not retarget it.
 * - INVALID_ASSIGNMENT → explicit failure: session creation fails with
 *   the resolution code. No fallback to GLOBAL_DEFAULT, no fallback to
 *   the legacy config — the assignment was explicit.
 * - NOT_CONFIGURED → unlocked session; the legacy path keeps its current
 *   behaviour (INTERVIEW_MODEL_NOT_CONFIGURED surfaces at generation
 *   time when no legacy config exists).
 */
import "server-only";
import {
  resolveBusinessAIConfig,
  type BusinessAIResolution,
} from "@/lib/ai/assignments";
import type { AIBusinessErrorCode } from "@/lib/ai/connections";
import { encodeLegacyInterviewLock } from "./sessionAiLock";

export type InterviewAiRuntimePlan =
  | {
      kind: "account";
      connectionId: string;
      model: string;
      provider: string;
      backendKind: string;
      assignmentSource: "BUSINESS_ASSIGNMENT" | "GLOBAL_DEFAULT";
    }
  | { kind: "invalid"; code: AIBusinessErrorCode }
  | { kind: "legacy"; provider: string; model: string }
  | { kind: "unconfigured" };

export interface InterviewAiResolution {
  /**
   * Diagnostic description of the resolution outcome. Callers gate on
   * `kind` (currently only "invalid" — which must abort creation); the
   * account/legacy payload fields describe what the lock captured and are
   * re-derived at execution time from the persisted lock + connection row.
   */
  plan: InterviewAiRuntimePlan;
  lock: {
    resolvedConnectionId?: string;
    resolvedModel?: string;
  };
}

export function interviewPlanFromResolution(
  resolution: BusinessAIResolution,
): InterviewAiResolution {
  if (resolution.status === "RESOLVED") {
    return {
      plan: {
        kind: "account",
        connectionId: resolution.connectionId,
        model: resolution.model,
        provider: resolution.provider,
        backendKind: resolution.backendKind,
        assignmentSource: resolution.source,
      },
      lock: {
        resolvedConnectionId: resolution.connectionId,
        resolvedModel: resolution.model,
      },
    };
  }
  if (resolution.status === "INVALID_ASSIGNMENT") {
    return { plan: { kind: "invalid", code: resolution.code }, lock: {} };
  }
  if (resolution.status === "LEGACY_INTERVIEW_CONFIG") {
    return {
      plan: {
        kind: "legacy",
        provider: resolution.provider,
        model: resolution.model,
      },
      lock: {
        resolvedModel: encodeLegacyInterviewLock(
          resolution.provider,
          resolution.model,
        ),
      },
    };
  }
  return { plan: { kind: "unconfigured" }, lock: {} };
}

export async function resolveInterviewAiRuntime(
  userId: string,
  dbClient?: Parameters<typeof resolveBusinessAIConfig>[1],
): Promise<InterviewAiResolution> {
  const resolution = await resolveBusinessAIConfig(
    { userId, purpose: "INTERVIEW" },
    dbClient,
  );
  return interviewPlanFromResolution(resolution);
}

/**
 * Automation match runtime plan — resolves the MATCH_ANALYSIS business
 * assignment once, at AutomationRun creation time. The lock fields are
 * persisted on the run row atomically with its creation; the plan tells the
 * matcher which execution path the run is bound to.
 *
 * Semantics (frozen):
 * - RESOLVED  → run locked to that connectionId + model, executed via the
 *   account runtime. A later assignment change must not affect this run.
 * - INVALID_ASSIGNMENT → explicit failure: the AI step fails with the
 *   resolution code. No fallback to GLOBAL_DEFAULT and no fallback to the
 *   legacy API-key path — the user explicitly configured this assignment.
 * - NOT_CONFIGURED / LEGACY_INTERVIEW_CONFIG → legacy provider/model path
 *   stays in charge (coexistence; nothing new was configured).
 */
import "server-only";
import {
  resolveBusinessAIConfig,
  type BusinessAIResolution,
} from "@/lib/ai/assignments";
import type { AIBusinessErrorCode } from "@/lib/ai/connections";

export type AutomationMatchRuntimePlan =
  | {
      kind: "account";
      connectionId: string;
      model: string;
      provider: string;
      backendKind: string;
      assignmentSource: "BUSINESS_ASSIGNMENT" | "GLOBAL_DEFAULT";
    }
  | { kind: "invalid"; code: AIBusinessErrorCode }
  | { kind: "legacy" };

export interface AutomationMatchResolution {
  plan: AutomationMatchRuntimePlan;
  lock: {
    resolvedConnectionId?: string;
    resolvedModel?: string;
  };
}

export function matchRuntimePlanFromResolution(
  resolution: BusinessAIResolution,
): AutomationMatchResolution {
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
  return { plan: { kind: "legacy" }, lock: {} };
}

export async function resolveAutomationMatchRuntime(
  userId: string,
): Promise<AutomationMatchResolution> {
  const resolution = await resolveBusinessAIConfig({
    userId,
    purpose: "MATCH_ANALYSIS",
  });
  return matchRuntimePlanFromResolution(resolution);
}

/** Persisted run history must decode Managed provenance before considering legacy. */
export { managedLockFromRow as managedAutomationLockFromRow } from "@/lib/ai/managed-provenance";

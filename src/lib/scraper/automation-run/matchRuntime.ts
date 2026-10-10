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
import {
  bindManagedBusinessLock,
  isManagedResolution,
} from "@/lib/ai/business-execution-lock";
import type { AIBusinessErrorCode } from "@/lib/ai/connections";
import type { HostedManagedClient } from "@/lib/ai/managed-client";
import type { ManagedAiProvenanceV1 } from "@/lib/ai/managed-provenance";

export type AutomationMatchRuntimePlan =
  | {
      kind: "account";
      connectionId: string;
      model: string;
      provider: string;
      backendKind: string;
      assignmentSource: "BUSINESS_ASSIGNMENT" | "GLOBAL_DEFAULT";
    }
  | {
      kind: "managed";
      connectionId: string;
      model: string;
      /** First-bind provenance — persisted on the run row verbatim. */
      provenance: ManagedAiProvenanceV1;
      /** `automation-run:<id>` — the binding identity of this run. */
      resourceKey: string;
      assignmentSource: "BUSINESS_ASSIGNMENT" | "GLOBAL_DEFAULT";
    }
  | {
      /**
       * Preview-only managed resolution — carries no provenance and must
       * NEVER reach matchJobToResume (it fails closed there). Distinct
       * from "account" so a non-executable plan is never lazily bound.
       */
      kind: "managed-preview";
      connectionId: string;
      model: string;
      provider: "VOCATRYA";
      backendKind: "MANAGED_GATEWAY";
      assignmentSource: "BUSINESS_ASSIGNMENT" | "GLOBAL_DEFAULT";
    }
  | { kind: "invalid"; code: AIBusinessErrorCode }
  | { kind: "legacy" };

export interface AutomationMatchResolution {
  plan: AutomationMatchRuntimePlan;
  lock: {
    resolvedConnectionId?: string;
    resolvedModel?: string;
    managedAiProvenance?: string;
  };
}

export function matchRuntimePlanFromResolution(
  resolution: BusinessAIResolution,
): AutomationMatchResolution {
  if (resolution.status === "RESOLVED" && isManagedResolution(resolution)) {
    // A managed resolution without a Hosted bind is preview-only — it can
    // describe the intended runtime but must never execute.
    return {
      plan: {
        kind: "managed-preview",
        connectionId: resolution.connectionId,
        model: resolution.model,
        provider: "VOCATRYA",
        backendKind: "MANAGED_GATEWAY",
        assignmentSource: resolution.source,
      },
      lock: {},
    };
  }
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

/**
 * Preflight resolution — answers "which runtime class would a new run use"
 * without binding. The managed plan carries no provenance and must not be
 * used for execution; it exists so callers can skip legacy preflights.
 */
export async function previewAutomationMatchRuntime(
  userId: string,
): Promise<AutomationMatchResolution> {
  const resolution = await resolveBusinessAIConfig({
    userId,
    purpose: "MATCH_ANALYSIS",
  });
  if (resolution.status === "RESOLVED" && isManagedResolution(resolution)) {
    return {
      plan: {
        kind: "managed-preview",
        connectionId: resolution.connectionId,
        model: resolution.model,
        provider: "VOCATRYA",
        backendKind: "MANAGED_GATEWAY",
        assignmentSource: resolution.source,
      },
      lock: {},
    };
  }
  return matchRuntimePlanFromResolution(resolution);
}

/**
 * Resolves the MATCH_ANALYSIS assignment once for a run being created.
 * `resourceKey` is the run's stable binding identity — the caller
 * pre-allocates the run id and derives `automation-run:<id>` so the Hosted
 * binding exists before the run row and persists into it atomically.
 */
export async function resolveAutomationMatchRuntime(
  userId: string,
  options: { resourceKey: string; managedClient?: HostedManagedClient },
): Promise<AutomationMatchResolution> {
  const resolution = await resolveBusinessAIConfig({
    userId,
    purpose: "MATCH_ANALYSIS",
  });
  if (resolution.status === "RESOLVED" && isManagedResolution(resolution)) {
    const lock = await bindManagedBusinessLock({
      userId,
      connectionId: resolution.connectionId,
      model: resolution.model,
      business: "MATCH_ANALYSIS",
      resourceKey: options.resourceKey,
      client: options.managedClient,
    });
    return {
      plan: {
        kind: "managed",
        connectionId: lock.connectionId,
        model: lock.model,
        provenance: lock.provenance,
        resourceKey: options.resourceKey,
        assignmentSource: resolution.source,
      },
      lock: {
        resolvedConnectionId: lock.connectionId,
        resolvedModel: lock.model,
        managedAiProvenance: lock.managedAiProvenance,
      },
    };
  }
  return matchRuntimePlanFromResolution(resolution);
}

/** Persisted run history must decode Managed provenance before considering legacy. */
export { managedLockFromRow as managedAutomationLockFromRow } from "@/lib/ai/managed-provenance";

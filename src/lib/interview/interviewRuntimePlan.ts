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
import {
  bindManagedBusinessLock,
  isManagedResolution,
} from "@/lib/ai/business-execution-lock";
import type { AIBusinessErrorCode } from "@/lib/ai/connections";
import type { HostedManagedClient } from "@/lib/ai/managed-client";
import type { ManagedAiProvenanceV1 } from "@/lib/ai/managed-provenance";
import type { InterviewCreationPlanRef } from "./hostPorts";
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
  | {
      kind: "managed";
      connectionId: string;
      model: string;
      provider: "VOCATRYA";
      backendKind: "MANAGED_GATEWAY";
      assignmentSource: "BUSINESS_ASSIGNMENT" | "GLOBAL_DEFAULT";
      /** First-bind provenance — persisted on the session row verbatim. */
      provenance: ManagedAiProvenanceV1;
      /** The stable resource identity the binding was issued for. */
      resourceKey: string;
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
    managedAiProvenance?: string;
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

/**
 * The port-facing ref of a resolved plan. The encoded provenance string
 * comes from `lock` (what the session row persists) — a managed plan's
 * `provenance` object and the ref's `managedAiProvenance` are the same
 * binding in different representations, so callers must use this mapper
 * rather than passing the plan structurally.
 */
export function interviewCreationPlanRef(
  resolution: InterviewAiResolution,
): InterviewCreationPlanRef {
  const { plan, lock } = resolution;
  return {
    kind: plan.kind,
    connectionId: "connectionId" in plan ? plan.connectionId : undefined,
    model: plan.kind === "unconfigured" || plan.kind === "invalid"
      ? undefined
      : plan.model,
    provider: "provider" in plan ? plan.provider : undefined,
    managedAiProvenance: lock.managedAiProvenance,
    resourceKey: plan.kind === "managed" ? plan.resourceKey : undefined,
  };
}

/**
 * Resolves the INTERVIEW assignment once for a session being created.
 * `resourceKey` is the session's stable binding identity — the caller
 * pre-allocates the session id and derives it (`interview-session:<id>`)
 * before persistence, because the Hosted binding must exist before the
 * first planning call and the session row then stores it atomically.
 */
export async function resolveInterviewAiRuntime(
  userId: string,
  dbClient?: Parameters<typeof resolveBusinessAIConfig>[1],
  options?: { resourceKey?: string; managedClient?: HostedManagedClient },
): Promise<InterviewAiResolution> {
  const resolution = await resolveBusinessAIConfig(
    { userId, purpose: "INTERVIEW" },
    dbClient,
  );
  if (resolution.status === "RESOLVED" && isManagedResolution(resolution)) {
    // A Managed assignment first-binds the session resource now — Hosted
    // is the binding authority, and every later model call replays this
    // exact provenance instead of re-resolving the assignment.
    const lock = await bindManagedBusinessLock({
      userId,
      connectionId: resolution.connectionId,
      model: resolution.model,
      business: "INTERVIEW",
      resourceKey: options?.resourceKey ?? "",
      client: options?.managedClient,
    });
    return {
      plan: {
        kind: "managed",
        connectionId: lock.connectionId,
        model: lock.model,
        provider: "VOCATRYA",
        backendKind: "MANAGED_GATEWAY",
        assignmentSource: resolution.source,
        provenance: lock.provenance,
        resourceKey: options?.resourceKey ?? "",
      },
      lock: {
        resolvedConnectionId: lock.connectionId,
        resolvedModel: lock.model,
        managedAiProvenance: lock.managedAiProvenance,
      },
    };
  }
  return interviewPlanFromResolution(resolution);
}

import "server-only";
import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { resolveBusinessAIConfig, type BusinessAISource } from "@/lib/ai/assignments";
import {
  agentRoleAssignmentPurpose,
  AI_BUSINESS_ERROR_CODES,
  AIBusinessError,
  classifyAIConnection,
} from "@/lib/ai/connections";
import { checkStreamingTurnReadiness } from "@/lib/ai/streaming-execution";
import { bindManagedBusinessLock, isManagedResolution } from "@/lib/ai/business-execution-lock";
import { decodeManagedAiProvenance, type ManagedAiProvenanceV1 } from "@/lib/ai/managed-provenance";
import type { AgentRole } from "./agentRoles";
import { APP_PATH, NATIVE_PATH, nativeReadinessReport } from "./nativeSession.server";
import type { PlannedRouteStep } from "./unifiedRouter";

export type UnifiedConfigSource =
  | "explicit"
  | "default"
  | "legacy_dialogue";

export type ResolvedUnifiedRouterTarget = {
  connectionId: string;
  model: string;
  provider: string;
  backendKind: string;
  configSource: UnifiedConfigSource;
  connectionClass: "MANAGED" | "BYOK" | "ACCOUNT_LOGIN";
  managedAiProvenance?: ManagedAiProvenanceV1;
};

export type ResolvedUnifiedStepTarget = {
  role: AgentRole;
  objective: string;
  connectionId: string;
  model: string;
  provider: string;
  backendKind: string;
  executionPath: typeof APP_PATH | typeof NATIVE_PATH;
  configSource: UnifiedConfigSource;
  connectionClass: "MANAGED" | "BYOK" | "ACCOUNT_LOGIN";
  managedAiProvenance?: ManagedAiProvenanceV1;
};

function mapConfigSource(resolution: {
  source: BusinessAISource;
  legacyFallbackPurpose?: "CAREER_DIALOGUE";
}): UnifiedConfigSource {
  if (resolution.legacyFallbackPurpose === "CAREER_DIALOGUE") {
    return "legacy_dialogue";
  }
  if (resolution.source === "BUSINESS_ASSIGNMENT") return "explicit";
  return "default";
}

/**
 * Checks whether the user has ANY unified/new-era assignment configured
 * (GLOBAL_DEFAULT, AGENT_*, or CAREER_DIALOGUE). Used to distinguish
 * unified-ready users from legacy null-lock `settings.ai` fixtures.
 */
export async function userHasUnifiedModelConfig(
  userId: string,
  db: PrismaClient = prisma,
): Promise<boolean> {
  const count = await db.aIBusinessAssignment.count({
    where: {
      userId,
      purpose: {
        in: [
          "GLOBAL_DEFAULT",
          "AGENT_ROUTER",
          "AGENT_PILOT",
          "AGENT_INSIGHT",
          "AGENT_REFLECT",
          "CAREER_DIALOGUE",
        ],
      },
    },
  });
  return count > 0;
}

/**
 * Resolves the Layer 1 router model (D01/D07/D08-Q3):
 * AGENT_ROUTER -> GLOBAL_DEFAULT -> read-only legacy CAREER_DIALOGUE.
 * Explicit broken AGENT_ROUTER fails closed (never silently falls back).
 */
export async function resolveUnifiedRouterConfig(
  userId: string,
  db: PrismaClient = prisma,
): Promise<ResolvedUnifiedRouterTarget> {
  const resolution = await resolveBusinessAIConfig(
    { userId, purpose: "AGENT_ROUTER" },
    db,
  );
  if (resolution.status === "INVALID_ASSIGNMENT") {
    throw new AIBusinessError(
      resolution.code,
      `Smart Router configuration is unavailable (${resolution.code}). Check Model Configuration in Settings.`,
    );
  }
  if (resolution.status !== "RESOLVED") {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
      "No Default Model or Smart Router model is configured. Configure one in Settings > Model Configuration.",
    );
  }
  const connection = await db.aIConnection.findFirst({
    where: { id: resolution.connectionId, userId, archivedAt: null },
    select: {
      id: true,
      provider: true,
      backendKind: true,
      authType: true,
      credentialRef: true,
      runtimeProfileRef: true,
      accountIdentity: true,
      status: true,
      archivedAt: true,
    },
  });
  if (!connection) {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
      "Smart Router connection is unavailable.",
    );
  }
  const cls = classifyAIConnection(connection);
  if (cls === "INVALID") {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
      "Smart Router connection has an invalid identity.",
    );
  }
  let managedAiProvenance: ManagedAiProvenanceV1 | undefined;
  if (isManagedResolution(resolution)) {
    const lock = await bindManagedBusinessLock({
      userId,
      connectionId: resolution.connectionId,
      model: resolution.model,
      business: "CAREER_DIALOGUE",
      resourceKey: `router:${userId}`,
    });
    managedAiProvenance =
      decodeManagedAiProvenance(lock.managedAiProvenance) ?? undefined;
  }
  return {
    connectionId: resolution.connectionId,
    model: resolution.model,
    provider: resolution.provider,
    backendKind: resolution.backendKind,
    configSource: mapConfigSource(resolution),
    connectionClass: cls,
    managedAiProvenance,
  };
}

/**
 * Resolves and pre-validates one role step (D07 + D08-Q3):
 * AGENT_<ROLE> -> GLOBAL_DEFAULT -> read-only legacy CAREER_DIALOGUE.
 * Explicit broken binding fails closed with the stable business error code.
 *
 * Respects `defaultPathSwitchGate` (HARNESS_OPTIMIZATION_ROADMAP): Codex
 * account connections stay APP_ORCHESTRATED by default until native Slice 2
 * desktop acceptance passes; when `preferNative === true` (e.g. a native
 * conversation) and native readiness passes, executes as NATIVE_CODEX_V1.
 */
export async function resolveUnifiedStepConfig(
  userId: string,
  step: PlannedRouteStep,
  options: {
    conversationId: string;
    preferNative?: boolean;
  },
  db: PrismaClient = prisma,
): Promise<ResolvedUnifiedStepTarget> {
  const purpose = agentRoleAssignmentPurpose(step.role);
  const resolution = await resolveBusinessAIConfig({ userId, purpose }, db);
  if (resolution.status === "INVALID_ASSIGNMENT") {
    throw new AIBusinessError(
      resolution.code,
      `Model configuration for ${step.role} is unavailable (${resolution.code}). Update it in Settings > Model Configuration.`,
    );
  }
  if (resolution.status !== "RESOLVED") {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
      `No model configured for ${step.role} or Default Model. Configure one in Settings > Model Configuration.`,
    );
  }

  const connection = await db.aIConnection.findFirst({
    where: { id: resolution.connectionId, userId },
    select: {
      id: true,
      status: true,
      backendKind: true,
      provider: true,
      authType: true,
      credentialRef: true,
      runtimeProfileRef: true,
      accountIdentity: true,
      archivedAt: true,
    },
  });
  if (!connection || connection.archivedAt) {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE,
      `Connection for ${step.role} is unavailable.`,
    );
  }
  const cls = classifyAIConnection(connection);
  if (cls === "INVALID") {
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
      `Connection for ${step.role} has no usable identity.`,
    );
  }

  let executionPath: typeof APP_PATH | typeof NATIVE_PATH = APP_PATH;
  if (
    options.preferNative === true &&
    cls === "ACCOUNT_LOGIN" &&
    connection.backendKind === "CODEX_RUNTIME"
  ) {
    const report = await nativeReadinessReport(
      userId,
      connection.id,
      resolution.model,
      db,
    );
    if (report.ok) {
      executionPath = NATIVE_PATH;
    }
  }

  // Pre-validate streaming readiness for non-native steps before starting Step 1 (D07 fail-fast).
  if (executionPath === APP_PATH) {
    await checkStreamingTurnReadiness({
      connection,
      model: resolution.model,
      userId,
    });
  }

  let managedAiProvenance: ManagedAiProvenanceV1 | undefined;
  if (isManagedResolution(resolution)) {
    const lock = await bindManagedBusinessLock({
      userId,
      connectionId: resolution.connectionId,
      model: resolution.model,
      business: "CAREER_DIALOGUE",
      resourceKey: `conversation:${options.conversationId}`,
    });
    managedAiProvenance =
      decodeManagedAiProvenance(lock.managedAiProvenance) ?? undefined;
  }

  return {
    role: step.role,
    objective: step.objective,
    connectionId: resolution.connectionId,
    model: resolution.model,
    provider: resolution.provider,
    backendKind: resolution.backendKind,
    executionPath,
    configSource: mapConfigSource(resolution),
    connectionClass: cls,
    managedAiProvenance,
  };
}

/**
 * Turn-entry fail-fast pre-check (D07 §2.9.1 & §2.9.3):
 * Validates and locks ALL planned steps BEFORE executing Step 1 so a broken
 * Step 2 configuration aborts cleanly without burning Step 1 tokens.
 */
export async function precheckUnifiedPlanSteps(
  userId: string,
  steps: readonly PlannedRouteStep[],
  options: {
    conversationId: string;
    preferNative?: boolean;
  },
  db: PrismaClient = prisma,
): Promise<ResolvedUnifiedStepTarget[]> {
  const locked: ResolvedUnifiedStepTarget[] = [];
  for (const step of steps) {
    const target = await resolveUnifiedStepConfig(userId, step, options, db);
    locked.push(target);
  }
  return locked;
}

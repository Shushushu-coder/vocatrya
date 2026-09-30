/**
 * Business AI assignment service — AIBusinessAssignment CRUD plus the
 * provider-neutral resolver every migrated business surface calls before
 * running AI work.
 *
 * Resolution semantics (frozen):
 *   specific business assignment → GLOBAL_DEFAULT → NOT_CONFIGURED
 * An explicit assignment that is unusable (archived/missing/foreign-owned
 * connection, non-CONNECTED status, missing runtime binding, empty model)
 * is INVALID_ASSIGNMENT — never a silent fallback to GLOBAL_DEFAULT or to
 * the legacy API-key path.
 *
 * INTERVIEW is the one coexistence case: with no explicit INTERVIEW
 * assignment, a legacy `settings.ai.interview` config wins over
 * GLOBAL_DEFAULT (LEGACY_INTERVIEW_CONFIG) so the legacy interview runtime
 * keeps behaving exactly as before. Execution migration is a later phase —
 * this resolver only reports configuration state.
 */
import "server-only";
import prisma from "@/lib/db";
import {
  AI_BUSINESS_ERROR_CODES,
  AIBusinessError,
  isAIBackendKind,
  isAIAssignmentPurpose,
  isStreamingPurpose,
  isSupportedAccountProviderForBackend,
  type AIAssignmentPurpose,
  type AIBusinessErrorCode,
} from "@/lib/ai/connections";
import { isRuntimeProfileRef } from "@/lib/ai/runtime/contract";
import {
  checkStreamingExecutionReadiness,
  type AccountRuntimeCapabilities,
} from "@/lib/ai/runtime/capabilities";
import {
  fetchAccountRuntimeState,
  type StreamExecutionDeps,
} from "@/lib/ai/streaming-execution";
import {
  getInterviewConfig,
  type InterviewContainer,
} from "@/lib/interview/interviewSettings";
import type { PrismaClient } from "@prisma/client";

type DbClient = Pick<
  PrismaClient,
  "aIBusinessAssignment" | "aIConnection" | "userSettings"
>;

export type BusinessAISource = "BUSINESS_ASSIGNMENT" | "GLOBAL_DEFAULT";

export interface ResolvedBusinessAIConfig {
  status: "RESOLVED";
  purpose: AIAssignmentPurpose;
  source: BusinessAISource;
  assignmentId: string;
  connectionId: string;
  model: string;
  provider: string;
  backendKind: string;
}

export type BusinessAIResolution =
  | ResolvedBusinessAIConfig
  | { status: "NOT_CONFIGURED"; purpose: AIAssignmentPurpose }
  | {
      status: "INVALID_ASSIGNMENT";
      purpose: AIAssignmentPurpose;
      code: AIBusinessErrorCode;
      source: BusinessAISource;
      assignmentId: string;
      connectionId: string;
      /** The model the broken assignment pinned — may be empty. */
      model?: string;
    }
  | {
      status: "LEGACY_INTERVIEW_CONFIG";
      purpose: "INTERVIEW";
      provider: string;
      model: string;
    };

const CONNECTION_SELECT = {
  id: true,
  userId: true,
  provider: true,
  backendKind: true,
  displayName: true,
  status: true,
  runtimeProfileRef: true,
  archivedAt: true,
} as const;

type AssignmentRow = {
  id: string;
  purpose: string;
  connectionId: string;
  model: string;
  connection: {
    id: string;
    userId: string;
    provider: string;
    backendKind: string;
    displayName: string;
    status: string;
    runtimeProfileRef: string | null;
    archivedAt: Date | null;
  } | null;
};

function classifyAssignment(
  row: AssignmentRow,
  userId: string,
  purpose: AIAssignmentPurpose,
  source: BusinessAISource,
): BusinessAIResolution {
  const invalid = (code: AIBusinessErrorCode): BusinessAIResolution => ({
    status: "INVALID_ASSIGNMENT",
    purpose,
    code,
    source,
    assignmentId: row.id,
    connectionId: row.connectionId,
    // The assigned pair is reported even when unusable: creation-time
    // locks (ChatConversation) persist it so later turns fail against the
    // pinned binding explicitly instead of silently re-resolving.
    model: row.model,
  });

  const connection = row.connection;
  // A missing or foreign-owned connection is indistinguishable from gone —
  // the user explicitly picked this connection, so no fallback.
  if (!connection || connection.userId !== userId) {
    return invalid(AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE);
  }
  if (connection.archivedAt !== null) {
    return invalid(AI_BUSINESS_ERROR_CODES.ASSIGNED_CONNECTION_UNAVAILABLE);
  }
  switch (connection.status) {
    case "CONNECTED":
      break;
    case "REAUTH_REQUIRED":
      return invalid(AI_BUSINESS_ERROR_CODES.REAUTH_REQUIRED);
    case "DISCONNECTED":
      return invalid(AI_BUSINESS_ERROR_CODES.CONNECTION_DISCONNECTED);
    default:
      return invalid(AI_BUSINESS_ERROR_CODES.CONNECTION_ERROR);
  }
  if (
    !isAIBackendKind(connection.backendKind) ||
    !isRuntimeProfileRef(connection.runtimeProfileRef)
  ) {
    return invalid(AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_AVAILABLE);
  }
  // Same matrix rule as the write path — a hand-edited or stale row must
  // not resolve to a pairing the runtime cannot serve.
  if (
    !isSupportedAccountProviderForBackend(
      connection.backendKind,
      connection.provider,
    )
  ) {
    return invalid(
      AI_BUSINESS_ERROR_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
    );
  }
  if (typeof row.model !== "string" || row.model.trim().length === 0) {
    return invalid(AI_BUSINESS_ERROR_CODES.MODEL_UNAVAILABLE);
  }
  return {
    status: "RESOLVED",
    purpose,
    source,
    assignmentId: row.id,
    connectionId: row.connectionId,
    model: row.model,
    provider: connection.provider,
    backendKind: connection.backendKind,
  };
}

/**
 * Resolves the AI configuration a business purpose must run with.
 *
 * Order for INTERVIEW (coexistence rule):
 *   INTERVIEW assignment → legacy settings.ai.interview → GLOBAL_DEFAULT →
 *   NOT_CONFIGURED
 * Order for every other purpose:
 *   purpose assignment → GLOBAL_DEFAULT → NOT_CONFIGURED
 */
export async function resolveBusinessAIConfig(
  { userId, purpose }: { userId: string; purpose: string },
  dbClient: DbClient = prisma,
): Promise<BusinessAIResolution> {
  if (!isAIAssignmentPurpose(purpose)) {
    return {
      status: "NOT_CONFIGURED",
      purpose: purpose as AIAssignmentPurpose,
    };
  }
  const rows = (await dbClient.aIBusinessAssignment.findMany({
    where: {
      userId,
      purpose: { in: [purpose, "GLOBAL_DEFAULT"] },
    },
    select: {
      id: true,
      purpose: true,
      connectionId: true,
      model: true,
      connection: { select: CONNECTION_SELECT },
    },
  })) as AssignmentRow[];

  const specific = rows.find((row) => row.purpose === purpose);
  if (specific) {
    // Resolving GLOBAL_DEFAULT itself reports that source — the
    // "business assignment" label is for purpose-specific rows only.
    return classifyAssignment(
      specific,
      userId,
      purpose,
      purpose === "GLOBAL_DEFAULT" ? "GLOBAL_DEFAULT" : "BUSINESS_ASSIGNMENT",
    );
  }

  if (purpose === "INTERVIEW") {
    // Legacy coexistence: an explicit settings.ai.interview config outranks
    // GLOBAL_DEFAULT until the user adopts an INTERVIEW assignment.
    const settingsRow = await dbClient.userSettings.findUnique({
      where: { userId },
      select: { settings: true },
    });
    let legacy: { provider: string; model: string } | undefined;
    try {
      const parsed = settingsRow
        ? (JSON.parse(settingsRow.settings) as InterviewContainer)
        : null;
      legacy = getInterviewConfig(parsed);
    } catch {
      legacy = undefined;
    }
    if (legacy) {
      return {
        status: "LEGACY_INTERVIEW_CONFIG",
        purpose: "INTERVIEW",
        provider: legacy.provider,
        model: legacy.model,
      };
    }
  }

  const globalDefault = rows.find((row) => row.purpose === "GLOBAL_DEFAULT");
  if (globalDefault) {
    return classifyAssignment(globalDefault, userId, purpose, "GLOBAL_DEFAULT");
  }
  return { status: "NOT_CONFIGURED", purpose };
}

// ---------------------------------------------------------------------------
// Assignment CRUD
// ---------------------------------------------------------------------------

export interface BusinessAssignmentSummary {
  id: string;
  purpose: string;
  connectionId: string;
  model: string;
  connection: {
    id: string;
    provider: string;
    backendKind: string;
    displayName: string;
    status: string;
  } | null;
}

export async function listBusinessAssignmentsForUser(
  userId: string,
  dbClient: DbClient = prisma,
): Promise<BusinessAssignmentSummary[]> {
  const rows = await dbClient.aIBusinessAssignment.findMany({
    where: { userId },
    select: {
      id: true,
      purpose: true,
      connectionId: true,
      model: true,
      connection: {
        select: {
          id: true,
          provider: true,
          backendKind: true,
          displayName: true,
          status: true,
        },
      },
    },
    orderBy: { purpose: "asc" },
  });
  return rows;
}

export class AssignmentWriteError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AssignmentWriteError";
    this.code = code;
  }
}

/**
 * Atomically saves the connectionId + model pair for a purpose. The
 * connection must belong to the user, must not be archived, and its
 * provider/backend pairing must be a supported ACCOUNT_LOGIN combination.
 * The connection does NOT need to be CONNECTED — users may assign first and
 * re-authenticate later; the resolver surfaces the state at run time.
 *
 * Streaming purposes (CAREER_DIALOGUE) additionally enforce the same
 * readiness the turn gate checks — verified incremental output bound to
 * the installed runtime version, probed live through the desktop's
 * runtime-state channel. The check is fail-closed: when the channel is
 * unreachable the assignment is refused rather than saved as silently
 * compatible.
 */
export async function setBusinessAssignment(
  {
    userId,
    purpose,
    connectionId,
    model,
  }: {
    userId: string;
    purpose: string;
    connectionId: string;
    model: string;
  },
  dbClient: DbClient = prisma,
  deps: StreamExecutionDeps = {},
): Promise<BusinessAssignmentSummary> {
  if (!isAIAssignmentPurpose(purpose)) {
    throw new AssignmentWriteError("INVALID_PURPOSE", "Unknown assignment purpose");
  }
  const trimmedModel = typeof model === "string" ? model.trim() : "";
  if (!trimmedModel) {
    throw new AssignmentWriteError("MODEL_UNAVAILABLE", "Model is required");
  }
  const connection = await dbClient.aIConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      userId: true,
      provider: true,
      backendKind: true,
      status: true,
      archivedAt: true,
    },
  });
  if (!connection || connection.userId !== userId) {
    throw new AssignmentWriteError(
      "CONNECTION_NOT_FOUND",
      "Connection not found",
    );
  }
  if (connection.archivedAt !== null) {
    throw new AssignmentWriteError(
      "CONNECTION_ARCHIVED",
      "Connection is archived",
    );
  }
  if (
    !isAIBackendKind(connection.backendKind) ||
    !isSupportedAccountProviderForBackend(
      connection.backendKind,
      connection.provider,
    )
  ) {
    throw new AssignmentWriteError(
      "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
      "Provider is not supported on this runtime",
    );
  }
  if (isStreamingPurpose(purpose)) {
    await assertStreamingAssignmentReady(connection, deps);
  }
  return dbClient.aIBusinessAssignment.upsert({
    where: { userId_purpose: { userId, purpose } },
    create: { userId, purpose, connectionId, model: trimmedModel },
    update: { connectionId, model: trimmedModel },
    select: {
      id: true,
      purpose: true,
      connectionId: true,
      model: true,
      connection: {
        select: {
          id: true,
          provider: true,
          backendKind: true,
          displayName: true,
          status: true,
        },
      },
    },
  });
}

/**
 * Gate parity with checkStreamingTurnReadiness (streaming-execution.ts):
 * implemented runtime + TEXT_ONLY boundary + verified streaming bound to
 * the probed runtime version. Anything less is refused with the stable
 * code the turn would have failed with — a saved-but-unrunnable
 * assignment is the failure this exists to prevent.
 */
async function assertStreamingAssignmentReady(
  connection: { backendKind: string; provider: string; status: string },
  deps: StreamExecutionDeps,
): Promise<void> {
  let state;
  try {
    state = await fetchAccountRuntimeState(
      {
        backendKind: connection.backendKind,
        accountProvider: connection.provider,
      },
      deps,
    );
  } catch (error) {
    // Fail closed: a runtime capability channel that cannot be reached
    // proves nothing — the assignment is refused, not assumed compatible.
    throw new AssignmentWriteError(
      error instanceof AIBusinessError
        ? error.code
        : AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      error instanceof Error
        ? error.message
        : "Runtime capabilities cannot be verified",
    );
  }
  const capabilities =
    state.capabilities as AccountRuntimeCapabilities | null;
  if (!capabilities?.implemented || capabilities.execution?.localOneShot !== true) {
    throw new AssignmentWriteError(
      AI_BUSINESS_ERROR_CODES.PERMISSION_BOUNDARY_NOT_READY,
      "The runtime does not expose the TEXT_ONLY execution boundary",
    );
  }
  if (state.runtimeReady !== true) {
    throw new AssignmentWriteError(
      AI_BUSINESS_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      "The assigned runtime is not usable on this machine",
    );
  }
  const verdict = checkStreamingExecutionReadiness({
    capabilities,
    // Runtime capability is what this gate proves — connection auth
    // state stays "assign first, authenticate later" like every other
    // purpose; the resolver and the turn gate surface it at run time.
    connectionStatus: "CONNECTED",
    permissionScope: "TEXT_ONLY",
    runtimeVersion: state.runtimeVersion,
  });
  if (!verdict.ready) {
    throw new AssignmentWriteError(
      verdict.code,
      "The assigned runtime cannot stream responses, so it cannot run Career Dialogue",
    );
  }
  // Career Dialogue's decision step is a structured-output one-shot —
  // a runtime that streams but cannot emit a verified decision schema
  // still cannot serve a turn. Same PASS + version binding the desktop
  // executeText gate enforces.
  const structured = capabilities.structuredOutput;
  if (
    !structured ||
    structured.strategy === "UNSUPPORTED" ||
    structured.verification !== "PASS" ||
    !structured.verifiedRuntimeVersion ||
    state.runtimeVersion !== structured.verifiedRuntimeVersion
  ) {
    throw new AssignmentWriteError(
      AI_BUSINESS_ERROR_CODES.STRUCTURED_OUTPUT_NOT_VERIFIED,
      "The assigned runtime is not verified for the structured decisions Career Dialogue needs",
    );
  }
}

export async function clearBusinessAssignment(
  { userId, purpose }: { userId: string; purpose: string },
  dbClient: DbClient = prisma,
): Promise<void> {
  if (!isAIAssignmentPurpose(purpose)) {
    throw new AssignmentWriteError("INVALID_PURPOSE", "Unknown assignment purpose");
  }
  await dbClient.aIBusinessAssignment.deleteMany({
    where: { userId, purpose },
  });
}

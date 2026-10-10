import "server-only";

import { AIBusinessError, AI_BUSINESS_ERROR_CODES } from "@/lib/ai/connections";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import {
  bindManagedBusinessLock,
  isManagedResolution,
} from "@/lib/ai/business-execution-lock";
import {
  executeStructuredForAssignment,
  type StructuredExecutionInput,
  type StructuredExecutionResult,
} from "@/lib/ai/structured-execution";
import type { ExecuteAIConnectionTextDeps } from "@/lib/ai/execution";
import type { ManagedAiProvenanceV1 } from "@/lib/ai/managed-provenance";
import type { PrismaClient } from "@prisma/client";

/**
 * Durable pre-invocation identity for the canonical resume import (M4 P1-01).
 *
 * Ordering invariant 鈥?the durable row exists BEFORE the first model call:
 *
 *   receive request 鈫?identify-or-create attempt (client request id)
 *     鈫?resolve assignment 鈫?bind Managed resource 鈫?persist lock
 *     鈫?Hosted model invocation 鈫?persist result
 *
 * A transport retry re-sends the same request id and therefore finds the
 * same attempt, the same binding, and the same operation identity. The
 * Hosted ledger replays receipts rather than payloads, so the parsed
 * result is cached on the attempt itself 鈥?a post-crash retry is served
 * locally with zero new gateway calls.
 */

export const RESUME_IMPORT_REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

type AttemptDb = Pick<PrismaClient, "resumeImportAttempt">;

export type DurableResumeImportResult =
  | {
      kind: "ok";
      attemptId: string;
      /** True when served from the attempt's cached result 鈥?no model call ran. */
      replayed: boolean;
      value: unknown;
      resolvedConnectionId: string;
      resolvedModel: string;
      managedAiProvenance: string | null;
    }
  | { kind: "failed"; code: string };

const businessKey = (requestId: string) => `resume-version:${requestId}`;
const operationIdFor = (requestId: string, executionSeq: number) =>
  `resume-import:${requestId}:${executionSeq}:import`;

/** Same request id carrying different source content is a caller bug. */
function assertSameImport(
  attempt: { requestSha: string } | null,
  requestSha: string,
): void {
  if (attempt && attempt.requestSha !== requestSha) {
    throw new AIBusinessError(
      "INVOCATION_CONFLICT",
      "This import request id was already used for different content",
    );
  }
}

function replayedResult(attempt: {
  id: string;
  /** Callers only reach this branch when a result was persisted. */
  resultJson: string | null;
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  managedAiProvenance: string | null;
}): DurableResumeImportResult {
  return {
    kind: "ok",
    attemptId: attempt.id,
    replayed: true,
    value: JSON.parse(attempt.resultJson ?? "null"),
    resolvedConnectionId: attempt.resolvedConnectionId ?? "",
    resolvedModel: attempt.resolvedModel ?? "",
    managedAiProvenance: attempt.managedAiProvenance,
  };
}

export async function executeDurableResumeImport(
  db: AttemptDb,
  input: {
    userId: string;
    /** Client-minted durable request id 鈥?reused verbatim on transport retries. */
    requestId: string;
    /** sha256 of the normalized source text 鈥?consistency guard, never a key. */
    requestSha: string;
    execution: Pick<
      StructuredExecutionInput,
      "prompt" | "schema" | "schemaName" | "timeoutMs" | "signal"
    >;
  },
  deps: ExecuteAIConnectionTextDeps = {},
): Promise<DurableResumeImportResult> {
  const { userId, requestId, requestSha } = input;

  // --- 1. Identify or create the durable attempt -------------------------
  let attempt = await db.resumeImportAttempt.findUnique({ where: { id: requestId } });
  if (attempt && attempt.userId !== userId) {
    throw new AIBusinessError("INVOCATION_CONFLICT", "Unknown import request id");
  }
  assertSameImport(attempt, requestSha);
  if (!attempt) {
    try {
      attempt = await db.resumeImportAttempt.create({
        data: { id: requestId, userId, requestSha, state: "PENDING" },
      });
    } catch {
      // A racing first POST won the primary key 鈥?recover its row.
      attempt = await db.resumeImportAttempt.findUniqueOrThrow({ where: { id: requestId } });
      if (attempt.userId !== userId) {
        throw new AIBusinessError("INVOCATION_CONFLICT", "Unknown import request id");
      }
      assertSameImport(attempt, requestSha);
    }
  }
  if (
    (attempt.state === "EXECUTED" || attempt.state === "CONFIRMED") &&
    attempt.resultJson
  ) {
    return replayedResult(attempt);
  }

  // --- 2. Resolve + bind + persist the lock before any invocation --------
  const resolution = await resolveBusinessAIConfig({ userId, purpose: "RESUME" });
  if (resolution.status === "INVALID_ASSIGNMENT") {
    return { kind: "failed", code: resolution.code };
  }
  if (resolution.status !== "RESOLVED") {
    return { kind: "failed", code: "NOT_CONFIGURED" };
  }

  const lock: {
    resolvedConnectionId: string;
    resolvedModel: string;
    managedAiProvenance: string | null;
  } = {
    resolvedConnectionId: resolution.connectionId,
    resolvedModel: resolution.model,
    managedAiProvenance: null,
  };
  let provenance: ManagedAiProvenanceV1 | undefined;
  if (isManagedResolution(resolution)) {
    const bound = await bindManagedBusinessLock({
      userId,
      connectionId: resolution.connectionId,
      model: resolution.model,
      business: "RESUME",
      resourceKey: businessKey(requestId),
      client: deps.managedClient,
    });
    lock.managedAiProvenance = bound.managedAiProvenance;
    provenance = bound.provenance;
  }

  // CAS: fill the lock only while the attempt is pre-result, and never
  // overwrite a different persisted lock 鈥?a bind that raced a state
  // change re-reads and verifies instead of re-resolving.
  const claimed = await db.resumeImportAttempt.updateMany({
    where: {
      id: requestId,
      userId,
      state: { in: ["PENDING", "RUNNING", "FAILED"] },
      OR: [
        { resolvedConnectionId: null },
        { state: "FAILED" },
        {
          resolvedConnectionId: lock.resolvedConnectionId,
          resolvedModel: lock.resolvedModel,
          managedAiProvenance: lock.managedAiProvenance,
        },
      ],
    },
    data: { ...lock, state: "RUNNING" },
  });
  if (claimed.count === 0) {
    const reread = await db.resumeImportAttempt.findUniqueOrThrow({
      where: { id: requestId },
    });
    if (
      (reread.state === "EXECUTED" || reread.state === "CONFIRMED") &&
      reread.resultJson
    ) {
      return replayedResult(reread);
    }
    throw new AIBusinessError(
      AI_BUSINESS_ERROR_CODES.MANAGED_BINDING_UNAVAILABLE,
      "The durable import lock does not match the resolved assignment",
    );
  }

  // --- 3. Invoke under the persisted lock --------------------------------
  const result: StructuredExecutionResult = await executeStructuredForAssignment(
    {
      userId,
      purpose: "RESUME",
      ...input.execution,
      operationId: operationIdFor(requestId, attempt.executionSeq),
      managedResource: { business: "RESUME", resourceKey: businessKey(requestId) },
      managedAiProvenance: provenance,
    },
    deps,
  );

  // --- 4. Persist the outcome --------------------------------------------
  if (result.status === "OK") {
    const executed = await db.resumeImportAttempt.update({
      where: { id: requestId },
      data: {
        state: "EXECUTED",
        resultJson: JSON.stringify(result.value),
        resolvedConnectionId: result.resolvedConnectionId,
        resolvedModel: result.resolvedModel,
        managedAiProvenance: result.managedAiProvenance
          ? JSON.stringify(result.managedAiProvenance)
          : lock.managedAiProvenance,
      },
    });
    return {
      kind: "ok",
      attemptId: executed.id,
      replayed: false,
      value: result.value,
      resolvedConnectionId: executed.resolvedConnectionId ?? "",
      resolvedModel: executed.resolvedModel ?? "",
      managedAiProvenance: executed.managedAiProvenance,
    };
  }

  const code =
    result.status === "NOT_CONFIGURED" ? "NOT_CONFIGURED" : result.code;
  if (
    code === AI_BUSINESS_ERROR_CODES.INVOCATION_STATUS_UNKNOWN ||
    code === AI_BUSINESS_ERROR_CODES.INVOCATION_IN_PROGRESS
  ) {
    // Ambiguous/in-flight: keep the same operation identity so a retry
    // replays the same invocation instead of minting a billable one.
    return { kind: "failed", code };
  }
  // Definitively failed 鈥?the settled invocation replays its failure
  // forever at the Hosted ledger, so the next retry is a new operation.
  await db.resumeImportAttempt.update({
    where: { id: requestId },
    data: { state: "FAILED", executionSeq: { increment: 1 } },
  });
  return { kind: "failed", code };
}

/** Confirm consumed the attempt 鈥?terminal state, never re-executed. */
export async function markResumeImportConfirmed(
  db: AttemptDb,
  userId: string,
  requestId: string,
): Promise<void> {
  await db.resumeImportAttempt.updateMany({
    where: { id: requestId, userId, state: "EXECUTED" },
    data: { state: "CONFIRMED" },
  });
}

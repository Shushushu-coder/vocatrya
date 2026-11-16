import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type HarnessTask, type PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "@/lib/career/errors";
import { hashCanonical } from "@/lib/career/hash";
import { assertFullAbWritable } from "@/lib/career/capabilities";
import { RESUME_VERSION_STATUS } from "@/lib/career/identities";
import type {
  DeepMatchTaskDTO,
  DeepMatchTaskSource,
} from "@/lib/career/deepMatchContract";
import { DEEP_MATCH_START_ERROR_CODES } from "@/lib/career/deepMatchContract";
import {
  ACTIVE_TASK_STATUSES,
  DEEP_MATCH_INPUT_FAILURE_CODES,
  DEEP_MATCH_TASK_INPUT_VERSION,
  HARNESS_TASK_EVENT,
  HARNESS_TASK_KIND,
  HARNESS_TASK_STATUS,
  HarnessOwnershipLost,
  TERMINAL_TASK_STATUSES,
} from "./types";

type Db = PrismaClient | Prisma.TransactionClient;

const SUBMITTABLE_VERSION_STATUSES = [
  RESUME_VERSION_STATUS.DRAFT,
  RESUME_VERSION_STATUS.FROZEN,
  RESUME_VERSION_STATUS.SUBMITTED,
];

const MAX_REQUEST_KEY_CHARS = 128;
const MAX_EVENT_PAYLOAD_CHARS = 16 * 1024;

export type HarnessClaim = {
  taskId: string;
  epoch: number;
  owner: string;
  /** Set by claimNextHarnessTask — the dispatcher reads it to pick the
   *  executor; absent on direct claimHarnessTask calls. */
  kind?: string;
};

// ---------------------------------------------------------------------------
// Trace events
// ---------------------------------------------------------------------------

/**
 * Append one trace event inside an existing transaction. seq is per-task
 * max+1 — only the owning epoch emits events for a claimed task, so the
 * sequence stays contiguous; pre-claim writes (create/user cancel/retry)
 * are serialized by the task row's own CAS updates.
 */
export async function appendTaskEvent(
  tx: Prisma.TransactionClient,
  input: {
    taskId: string;
    epoch: number;
    type: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const last = await tx.harnessTaskEvent.findFirst({
    where: { taskId: input.taskId },
    orderBy: { seq: "desc" },
    select: { seq: true },
  });
  const payloadJson = input.payload
    ? JSON.stringify(input.payload).slice(0, MAX_EVENT_PAYLOAD_CHARS)
    : null;
  await tx.harnessTaskEvent.create({
    data: {
      taskId: input.taskId,
      epoch: input.epoch,
      seq: (last?.seq ?? 0) + 1,
      type: input.type,
      payloadJson,
    },
  });
}

// ---------------------------------------------------------------------------
// Task creation (request dedupe + pinned business inputs)
// ---------------------------------------------------------------------------

/**
 * Create the durable DEEP_MATCH task for one explicit user intent.
 *
 * - `requestKey` is the stable create-request identity: a retransmitted
 *   create (double-click, action retry) lands on the same row; an identical
 *   input hash is required, otherwise CONFLICT.
 * - An identical input that is already active (QUEUED/RUNNING/CANCELLING)
 *   under a different requestKey returns the live task instead of running
 *   the same analysis twice; a finished or differently-shaped run mints a
 *   fresh task.
 * - The business inputs are pinned NOW: the job's current JD version and
 *   the explicit resume version — recovery never re-reads "latest".
 */
export async function createDeepMatchTask(
  db: PrismaClient,
  userId: string,
  input: {
    jobOpportunityId: string;
    resumeVariantVersionId: string;
    requestKey: string;
  },
  env?: NodeJS.ProcessEnv,
): Promise<{ task: HarnessTask; created: boolean }> {
  await assertFullAbWritable(db, env);

  const requestKey =
    typeof input.requestKey === "string" ? input.requestKey.trim() : "";
  if (requestKey === "" || requestKey.length > MAX_REQUEST_KEY_CHARS) {
    throw new CareerRuntimeError(
      "DEEP_MATCH_REQUEST_INVALID",
      "A stable request key is required to start deep match",
    );
  }

  const opportunity = await db.jobOpportunity.findFirst({
    where: { id: input.jobOpportunityId, userId },
    select: { id: true, archivedAt: true, currentJdVersionId: true },
  });
  if (!opportunity) {
    throw new CareerRuntimeError(
      DEEP_MATCH_START_ERROR_CODES.OPPORTUNITY_NOT_FOUND,
      "Opportunity not found",
    );
  }
  if (opportunity.archivedAt !== null) {
    throw new CareerRuntimeError(
      DEEP_MATCH_START_ERROR_CODES.OPPORTUNITY_ARCHIVED,
      "This job is archived. Restore it to run a deep match.",
    );
  }
  if (!opportunity.currentJdVersionId) {
    throw new CareerRuntimeError(
      DEEP_MATCH_START_ERROR_CODES.JD_MISSING,
      "This job has no description to analyze.",
    );
  }

  const version = await db.resumeVariantVersion.findFirst({
    where: { id: input.resumeVariantVersionId, resumeVariant: { userId } },
    select: { id: true, status: true },
  });
  if (!version) {
    throw new CareerRuntimeError(
      DEEP_MATCH_START_ERROR_CODES.RESUME_VERSION_MISSING,
      "The selected resume version is not available.",
    );
  }
  if (!SUBMITTABLE_VERSION_STATUSES.includes(version.status as never)) {
    throw new CareerRuntimeError(
      DEEP_MATCH_START_ERROR_CODES.RESUME_NOT_SUBMITTABLE,
      "The selected resume version is not submittable.",
    );
  }

  const inputJson = JSON.stringify({
    v: DEEP_MATCH_TASK_INPUT_VERSION,
    jobOpportunityId: opportunity.id,
    jobDescriptionVersionId: opportunity.currentJdVersionId,
    resumeVariantVersionId: version.id,
  });
  const inputHash = hashCanonical({
    kind: HARNESS_TASK_KIND.DEEP_MATCH,
    input: inputJson,
  });

  const existing = await db.harnessTask.findUnique({
    where: {
      userId_kind_requestKey: { userId, kind: HARNESS_TASK_KIND.DEEP_MATCH, requestKey },
    },
  });
  if (existing) {
    if (existing.inputHash !== inputHash) {
      throw new CareerRuntimeError(
        DEEP_MATCH_START_ERROR_CODES.REQUEST_CONFLICT,
        "The same request key was reused with different inputs.",
      );
    }
    return { task: existing, created: false };
  }

  const inFlight = await db.harnessTask.findFirst({
    where: {
      userId,
      kind: HARNESS_TASK_KIND.DEEP_MATCH,
      status: { in: [...ACTIVE_TASK_STATUSES] },
      inputHash,
    },
    orderBy: { createdAt: "asc" },
  });
  if (inFlight) return { task: inFlight, created: false };

  try {
    const task = await db.$transaction(async (tx) => {
      const created = await tx.harnessTask.create({
        data: {
          userId,
          kind: HARNESS_TASK_KIND.DEEP_MATCH,
          status: HARNESS_TASK_STATUS.QUEUED,
          requestKey,
          inputHash,
          inputJson,
          jobOpportunityId: opportunity.id,
        },
      });
      await appendTaskEvent(tx, {
        taskId: created.id,
        epoch: 0,
        type: HARNESS_TASK_EVENT.TASK_CREATED,
        payload: {
          kind: HARNESS_TASK_KIND.DEEP_MATCH,
          inputHash,
          jobOpportunityId: opportunity.id,
          jobDescriptionVersionId: opportunity.currentJdVersionId,
          resumeVariantVersionId: version.id,
        },
      });
      return created;
    });
    return { task, created: true };
  } catch (error) {
    // A concurrent create with the same requestKey lost the race — the
    // winner's row is authoritative.
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const winner = await db.harnessTask.findUnique({
        where: {
          userId_kind_requestKey: {
            userId,
            kind: HARNESS_TASK_KIND.DEEP_MATCH,
            requestKey,
          },
        },
      });
      if (winner) {
        if (winner.inputHash !== inputHash) {
          throw new CareerRuntimeError(
            DEEP_MATCH_START_ERROR_CODES.REQUEST_CONFLICT,
            "The same request key was reused with different inputs.",
          );
        }
        return { task: winner, created: false };
      }
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Claim / lease — DB CAS, never an in-process map
// ---------------------------------------------------------------------------

function claimableWhere(now: Date) {
  return {
    OR: [
      { status: HARNESS_TASK_STATUS.QUEUED, cancelRequestedAt: null },
      {
        status: HARNESS_TASK_STATUS.RUNNING,
        leaseUntil: { lt: now },
      },
    ],
  };
}

/**
 * Claim one runnable task via conditional update. QUEUED rows and RUNNING
 * rows whose lease already expired are both eligible — expiry is evaluated
 * at claim time, so a lease that lapses later is picked up by the next
 * claim round, not only at process start.
 */
export async function claimNextHarnessTask(
  db: PrismaClient,
  input: {
    owner: string;
    leaseMs: number;
    kind?: string;
    now?: Date;
  },
): Promise<HarnessClaim | null> {
  const now = input.now ?? new Date();
  const candidates = await db.harnessTask.findMany({
    where: {
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...claimableWhere(now),
    },
    orderBy: { createdAt: "asc" },
    take: 5,
    select: { id: true, claimEpoch: true, kind: true },
  });
  for (const candidate of candidates) {
    const claim = await claimHarnessTask(db, {
      taskId: candidate.id,
      owner: input.owner,
      leaseMs: input.leaseMs,
      now,
    });
    if (claim) return { ...claim, kind: candidate.kind };
  }
  return null;
}

/**
 * CAS-claim one task: QUEUED (not cancel-requested) or RUNNING with an
 * expired lease. Each successful claim bumps claimEpoch — the returned
 * epoch is the only identity allowed to checkpoint, renew or commit.
 */
export async function claimHarnessTask(
  db: PrismaClient,
  input: {
    taskId: string;
    owner: string;
    leaseMs: number;
    now?: Date;
  },
): Promise<HarnessClaim | null> {
  const now = input.now ?? new Date();
  return db.$transaction(async (tx) => {
    const previous = await tx.harnessTask.findUnique({
      where: { id: input.taskId },
      select: { claimEpoch: true, startedAt: true },
    });
    const claimed = await tx.harnessTask.updateMany({
      where: { id: input.taskId, ...claimableWhere(now) },
      data: {
        status: HARNESS_TASK_STATUS.RUNNING,
        claimEpoch: { increment: 1 },
        leaseOwner: input.owner,
        leaseUntil: new Date(now.getTime() + input.leaseMs),
        lastHeartbeatAt: now,
        ...(previous?.startedAt ? {} : { startedAt: now }),
      },
    });
    if (claimed.count !== 1) return null;
    const row = await tx.harnessTask.findUniqueOrThrow({
      where: { id: input.taskId },
      select: { claimEpoch: true },
    });
    const epoch = row.claimEpoch;
    if ((previous?.claimEpoch ?? 0) > 0) {
      await appendTaskEvent(tx, {
        taskId: input.taskId,
        epoch,
        type: HARNESS_TASK_EVENT.LEASE_RECLAIMED,
        payload: { fromEpoch: previous!.claimEpoch, toEpoch: epoch },
      });
    }
    await appendTaskEvent(tx, {
      taskId: input.taskId,
      epoch,
      type: HARNESS_TASK_EVENT.TASK_CLAIMED,
      payload: { epoch, owner: input.owner },
    });
    return { taskId: input.taskId, epoch, owner: input.owner };
  });
}

/**
 * Renew the held lease. An expired lease is lost ownership even before
 * another runner reclaims it — renewal is refused the moment leaseUntil
 * has passed, not only after a newer epoch lands. Returns the live row
 * status when refused; RUNNING means the claim is dead either way.
 */
export async function renewHarnessLease(
  db: PrismaClient,
  claim: HarnessClaim,
  leaseMs: number,
): Promise<{ ok: true } | { ok: false; status: string }> {
  const now = new Date();
  const renewed = await db.harnessTask.updateMany({
    where: {
      id: claim.taskId,
      claimEpoch: claim.epoch,
      leaseOwner: claim.owner,
      status: HARNESS_TASK_STATUS.RUNNING,
      leaseUntil: { gt: now },
    },
    data: {
      leaseUntil: new Date(now.getTime() + leaseMs),
      lastHeartbeatAt: now,
    },
  });
  if (renewed.count === 1) return { ok: true };
  const row = await db.harnessTask.findUnique({
    where: { id: claim.taskId },
    select: { status: true },
  });
  return { ok: false, status: row?.status ?? "MISSING" };
}

/**
 * Every ownership-checked write a claimed runner performs goes through
 * this guard — step checkpoints included. A superseded epoch, a
 * cancel/status flip, or a lease whose deadline already passed makes the
 * write fail instead of committing late: expiry alone forfeits ownership,
 * takeover by a newer runner is not required.
 */
export async function guardedTaskUpdate(
  db: Db,
  claim: HarnessClaim,
  data: Prisma.HarnessTaskUpdateManyMutationInput,
): Promise<void> {
  const updated = await db.harnessTask.updateMany({
    where: {
      id: claim.taskId,
      claimEpoch: claim.epoch,
      leaseOwner: claim.owner,
      status: HARNESS_TASK_STATUS.RUNNING,
      leaseUntil: { gt: new Date() },
    },
    data,
  });
  if (updated.count !== 1) throw new HarnessOwnershipLost();
}

/** Persist a step checkpoint under the claiming epoch. */
export async function writeStepCheckpoint(
  db: PrismaClient,
  claim: HarnessClaim,
  input: {
    step: string;
    pinnedJson?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await db.$transaction(async (tx) => {
    await appendTaskEvent(tx, {
      taskId: claim.taskId,
      epoch: claim.epoch,
      type: HARNESS_TASK_EVENT.STEP_CHECKPOINT,
      payload: { step: input.step, ...(input.payload ?? {}) },
    });
    await guardedTaskUpdate(tx, claim, {
      currentStep: input.step,
      ...(input.pinnedJson !== undefined ? { pinnedJson: input.pinnedJson } : {}),
    });
  });
}

// ---------------------------------------------------------------------------
// Terminal transitions (runner side, epoch-guarded where required)
// ---------------------------------------------------------------------------

/**
 * Mark the claimed task FAILED. Guarded by the claim epoch — a superseded
 * runner cannot stamp failure on a task it no longer owns.
 */
export async function failClaimedTask(
  db: PrismaClient,
  claim: HarnessClaim,
  input: { code: string; detail?: string | null },
): Promise<boolean> {
  const now = new Date();
  try {
    return await db.$transaction(async (tx) => {
      await appendTaskEvent(tx, {
        taskId: claim.taskId,
        epoch: claim.epoch,
        type: HARNESS_TASK_EVENT.TASK_FAILED,
        payload: { code: input.code, detail: input.detail ?? null },
      });
      await guardedTaskUpdate(tx, claim, {
        status: HARNESS_TASK_STATUS.FAILED,
        failureCode: input.code,
        failureDetail: input.detail ?? null,
        completedAt: now,
        leaseUntil: null,
      });
      return true;
    });
  } catch (error) {
    if (error instanceof HarnessOwnershipLost) return false;
    throw error;
  }
}

/**
 * Settle a task whose cancel was requested. The current holder calls this
 * after observing CANCELLING; the sweeper calls it for CANCELLING rows
 * whose lease expired. Guarded on CANCELLING so a finished task is never
 * rewritten.
 */
export async function finalizeCancelledTask(
  db: PrismaClient,
  input: { taskId: string; epoch: number },
): Promise<boolean> {
  const now = new Date();
  return db.$transaction(async (tx) => {
    const updated = await tx.harnessTask.updateMany({
      where: { id: input.taskId, status: HARNESS_TASK_STATUS.CANCELLING },
      data: {
        status: HARNESS_TASK_STATUS.CANCELLED,
        completedAt: now,
        leaseUntil: null,
      },
    });
    if (updated.count !== 1) return false;
    await appendTaskEvent(tx, {
      taskId: input.taskId,
      epoch: input.epoch,
      type: HARNESS_TASK_EVENT.TASK_CANCELLED,
      payload: {},
    });
    return true;
  });
}

// ---------------------------------------------------------------------------
// User commands: cancel / retry
// ---------------------------------------------------------------------------

/**
 * Record the user's cancel intent. QUEUED settles immediately; RUNNING
 * flips to CANCELLING — the holder (or the lease sweeper, if the holder
 * is gone) settles CANCELLED. A terminal task reports its state instead
 * of being rewritten.
 */
export async function requestTaskCancel(
  db: PrismaClient,
  userId: string,
  taskId: string,
): Promise<{ status: string }> {
  const task = await db.harnessTask.findFirst({
    where: { id: taskId, userId },
    select: { id: true, status: true },
  });
  if (!task) {
    throw new CareerRuntimeError("TASK_NOT_FOUND", "Task not found");
  }
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    return { status: task.status };
  }
  const now = new Date();
  await db.$transaction(async (tx) => {
    const queued = await tx.harnessTask.updateMany({
      where: { id: task.id, status: HARNESS_TASK_STATUS.QUEUED },
      data: {
        status: HARNESS_TASK_STATUS.CANCELLED,
        cancelRequestedAt: now,
        completedAt: now,
      },
    });
    if (queued.count === 1) {
      await appendTaskEvent(tx, {
        taskId: task.id,
        epoch: 0,
        type: HARNESS_TASK_EVENT.CANCEL_REQUESTED,
        payload: { source: "user", settled: "queued" },
      });
      await appendTaskEvent(tx, {
        taskId: task.id,
        epoch: 0,
        type: HARNESS_TASK_EVENT.TASK_CANCELLED,
        payload: {},
      });
      return;
    }
    const running = await tx.harnessTask.updateMany({
      where: { id: task.id, status: HARNESS_TASK_STATUS.RUNNING },
      data: { status: HARNESS_TASK_STATUS.CANCELLING, cancelRequestedAt: now },
    });
    if (running.count === 1) {
      await appendTaskEvent(tx, {
        taskId: task.id,
        epoch: 0,
        type: HARNESS_TASK_EVENT.CANCEL_REQUESTED,
        payload: { source: "user", settled: "pending" },
      });
      return;
    }
    // CANCELLING already — record nothing new.
  });
  const after = await db.harnessTask.findUniqueOrThrow({
    where: { id: task.id },
    select: { status: true },
  });
  return { status: after.status };
}

/**
 * Requeue a FAILED or CANCELLED task for another run. The pinned inputs
 * and checkpoints are reused exactly as recovery would; the analysis
 * model step re-executes under a new operation identity (a user retry is
 * a fresh billable attempt, not a replay).
 */
export async function requestTaskRetry(
  db: PrismaClient,
  userId: string,
  taskId: string,
): Promise<HarnessTask> {
  return db.$transaction(async (tx) => {
    const updated = await tx.harnessTask.updateMany({
      where: {
        id: taskId,
        userId,
        // Detached writes are never re-armed by a generic retry — a real
        // retry needs a fresh proposal and a fresh approval.
        kind: { not: HARNESS_TASK_KIND.AGENT_TOOL_WRITE },
        status: {
          in: [HARNESS_TASK_STATUS.FAILED, HARNESS_TASK_STATUS.CANCELLED],
        },
      },
      data: {
        status: HARNESS_TASK_STATUS.QUEUED,
        cancelRequestedAt: null,
        failureCode: null,
        failureDetail: null,
        completedAt: null,
        leaseOwner: null,
        leaseUntil: null,
        attemptCount: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new CareerRuntimeError(
        "TASK_NOT_RETRYABLE",
        "Only a failed or cancelled analysis can be retried.",
      );
    }
    const row = await tx.harnessTask.findUniqueOrThrow({
      where: { id: taskId },
    });
    await appendTaskEvent(tx, {
      taskId,
      epoch: 0,
      type: HARNESS_TASK_EVENT.TASK_RETRIED,
      payload: { attemptCount: row.attemptCount },
    });
    return row;
  });
}

// ---------------------------------------------------------------------------
// Sweeper — settles rows whose holder vanished mid-transition
// ---------------------------------------------------------------------------

/**
 * Settle cancel-pending rows whose lease is gone (the holder died between
 * the cancel flag and its own finalize). Claimable RUNNING rows are NOT
 * settled here — claim handles them so a new epoch can resume the work.
 */
export async function sweepHarnessTasks(
  db: PrismaClient,
  now: Date = new Date(),
): Promise<number> {
  const stale = await db.harnessTask.findMany({
    where: {
      status: HARNESS_TASK_STATUS.CANCELLING,
      leaseUntil: { lt: now },
    },
    select: { id: true, claimEpoch: true },
  });
  let settled = 0;
  for (const row of stale) {
    if (await finalizeCancelledTask(db, { taskId: row.id, epoch: row.claimEpoch })) {
      settled += 1;
    }
  }
  return settled;
}

// ---------------------------------------------------------------------------
// Reads + DTO
// ---------------------------------------------------------------------------

export async function getHarnessTask(
  db: PrismaClient,
  userId: string,
  taskId: string,
): Promise<HarnessTask> {
  const task = await db.harnessTask.findFirst({
    where: { id: taskId, userId },
  });
  if (!task) {
    throw new CareerRuntimeError("TASK_NOT_FOUND", "Task not found");
  }
  return task;
}

export async function getLatestDeepMatchTaskForJob(
  db: PrismaClient,
  userId: string,
  jobOpportunityId: string,
): Promise<HarnessTask | null> {
  return db.harnessTask.findFirst({
    where: {
      userId,
      jobOpportunityId,
      kind: HARNESS_TASK_KIND.DEEP_MATCH,
    },
    orderBy: { createdAt: "desc" },
  });
}

/** Resolve display labels for the pinned source. A missing row stays null
 *  — the task pinned the ids, and a deleted input must read as gone. */
export async function loadDeepMatchTaskSource(
  db: PrismaClient,
  task: HarnessTask,
): Promise<DeepMatchTaskSource | null> {
  let ids: {
    jobOpportunityId?: string;
    jobDescriptionVersionId?: string;
    resumeVariantVersionId?: string;
  };
  try {
    ids = JSON.parse(task.inputJson) as typeof ids;
  } catch {
    return null;
  }
  if (
    typeof ids.jobOpportunityId !== "string" ||
    typeof ids.jobDescriptionVersionId !== "string" ||
    typeof ids.resumeVariantVersionId !== "string"
  ) {
    return null;
  }
  const [jdVersion, resumeVersion] = await Promise.all([
    db.jobDescriptionVersion.findUnique({
      where: { id: ids.jobDescriptionVersionId },
      select: { versionNumber: true },
    }),
    db.resumeVariantVersion.findUnique({
      where: { id: ids.resumeVariantVersionId },
      select: {
        versionNumber: true,
        resumeVariant: { select: { name: true } },
      },
    }),
  ]);
  return {
    jobOpportunityId: ids.jobOpportunityId,
    jobDescriptionVersionId: ids.jobDescriptionVersionId,
    jdVersionNumber: jdVersion?.versionNumber ?? null,
    resumeVariantVersionId: ids.resumeVariantVersionId,
    resumeVariantName: resumeVersion?.resumeVariant.name ?? null,
    resumeVersionNumber: resumeVersion?.versionNumber ?? null,
  };
}

export async function toDeepMatchTaskDTO(
  db: PrismaClient,
  task: HarnessTask,
): Promise<DeepMatchTaskDTO> {
  const source = await loadDeepMatchTaskSource(db, task);
  return {
    id: task.id,
    status: task.status as DeepMatchTaskDTO["status"],
    currentStep:
      task.status === HARNESS_TASK_STATUS.RUNNING ? task.currentStep : null,
    recovered: task.claimEpoch > 1 && task.status === HARNESS_TASK_STATUS.RUNNING,
    attemptCount: task.attemptCount,
    cancelRequested: task.cancelRequestedAt !== null,
    failureCode: task.failureCode,
    inputLost:
      task.failureCode !== null &&
      DEEP_MATCH_INPUT_FAILURE_CODES.has(task.failureCode),
    resultAnalysisId: task.resultAnalysisId,
    // DEEP_MATCH rows always carry a job opportunity — AGENT_TOOL_WRITE
    // tasks are the ones that leave it null, and this DTO only serves
    // deep-match tasks.
    jobOpportunityId: task.jobOpportunityId!,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    source,
  };
}

export function mintHarnessRunnerId(): string {
  return `runner-${randomUUID()}`;
}

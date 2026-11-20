import "server-only";

import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@prisma/client";
import {
  AgentTaskHandoffStateSchema,
  type AgentTaskHandoffState,
} from "@/models/agentTask.schema";
import { AGENT_TASK_EVENT_KIND, recordTaskEvent } from "./agentTaskEvents";
import { findMissingPointers, type MissingPointer } from "./agentTaskPointers";
import { commitAgentTaskRevision } from "./agentTaskStore";

/**
 * Handoff chain store (card B). Append-only: the latest handoff is the row
 * with the highest revision. A commit is guarded twice: the AgentTask
 * revision CAS (commitAgentTaskRevision) and @@unique([taskId, revision]),
 * both inside one transaction together with the HANDOFF_COMMIT event, so a
 * losing writer leaves no trace.
 */
type Db = PrismaClient | Prisma.TransactionClient;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = canonical(source[key]);
  return out;
}

/** sha256 of the key-sorted JSON of the state. Stable across key order. */
export function computeHandoffStateHash(state: AgentTaskHandoffState): string {
  return createHash("sha256").update(JSON.stringify(canonical(state))).digest("hex");
}

export type LoadedHandoff =
  | {
      status: "ok";
      revision: number;
      state: AgentTaskHandoffState;
      stateHash: string;
      /** False when the stored state no longer hashes to stateHash. */
      hashMatches: boolean;
      sessionId: string | null;
      createdAt: Date;
      /** Present only when `checkPointers` was requested. */
      missingPointers?: MissingPointer[];
    }
  | { status: "corrupt"; revision: number };

/**
 * Latest handoff for an owned task, or null when none exists. A state that
 * fails the schema (older version, hand-edited) reads as `corrupt` rather
 * than throwing. Pointers are NOT required to resolve: a restored backup
 * keeps `state` verbatim, so dangling ids are reported via `missingPointers`
 * (opt-in) for grounding instead of failing the read.
 */
export async function loadLatestHandoff(
  db: Db,
  input: { userId: string; taskId: string; checkPointers?: boolean },
): Promise<LoadedHandoff | null> {
  const row = await db.agentTaskHandoff.findFirst({
    where: { taskId: input.taskId, task: { userId: input.userId } },
    orderBy: { revision: "desc" },
  });
  if (!row) return null;
  let parsed: ReturnType<typeof AgentTaskHandoffStateSchema.safeParse>;
  try {
    parsed = AgentTaskHandoffStateSchema.safeParse(JSON.parse(row.state));
  } catch {
    return { status: "corrupt", revision: row.revision };
  }
  if (!parsed.success || parsed.data.taskId !== input.taskId) {
    return { status: "corrupt", revision: row.revision };
  }
  const state = parsed.data;
  return {
    status: "ok",
    revision: row.revision,
    state,
    stateHash: row.stateHash,
    hashMatches: computeHandoffStateHash(state) === row.stateHash,
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    ...(input.checkPointers
      ? {
          missingPointers: await findMissingPointers(db, {
            userId: input.userId,
            pointers: state.completedWork,
          }),
        }
      : {}),
  };
}

export type CommitHandoffResult =
  | { status: "committed"; revision: number; stateHash: string }
  | { status: "revision_conflict" }
  | { status: "task_not_found" }
  | { status: "invalid"; issues: string[] }
  | { status: "pointer_missing"; missing: MissingPointer[] };

class RollbackSignal extends Error {
  constructor(readonly result: CommitHandoffResult) {
    super("handoff-commit-rolled-back");
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "P2002"
  );
}

async function inTransaction<T>(
  db: Db,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  if ("$transaction" in db) return db.$transaction(fn);
  return fn(db);
}

/**
 * Validate, re-check every pointer id against the database, then commit the
 * handoff at revision expectedRevision + 1. Nothing is written unless all
 * gates pass; a lost race (revision CAS or unique index) is
 * `revision_conflict`.
 */
export async function commitHandoff(
  db: Db,
  input: {
    userId: string;
    taskId: string;
    expectedRevision: number;
    state: unknown;
    sessionId?: string | null;
    generationMs?: number | null;
  },
): Promise<CommitHandoffResult> {
  const parsed = AgentTaskHandoffStateSchema.safeParse(input.state);
  if (!parsed.success) {
    return {
      status: "invalid",
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const state = parsed.data;
  if (state.taskId !== input.taskId) {
    return { status: "invalid", issues: ["taskId: does not match the target task"] };
  }
  const stateHash = computeHandoffStateHash(state);

  try {
    return await inTransaction(db, async (tx) => {
      const task = await tx.agentTask.findFirst({
        where: { id: input.taskId, userId: input.userId },
        select: { id: true },
      });
      if (!task) throw new RollbackSignal({ status: "task_not_found" });

      const missing = await findMissingPointers(tx, {
        userId: input.userId,
        pointers: state.completedWork,
      });
      if (missing.length > 0) {
        throw new RollbackSignal({ status: "pointer_missing", missing });
      }

      const revision = await commitAgentTaskRevision(tx, {
        userId: input.userId,
        taskId: input.taskId,
        expectedRevision: input.expectedRevision,
      });
      if (revision === null) {
        throw new RollbackSignal({ status: "revision_conflict" });
      }
      await tx.agentTaskHandoff.create({
        data: {
          taskId: input.taskId,
          revision,
          state: JSON.stringify(state),
          stateHash,
          sessionId: input.sessionId ?? null,
          generationMs: input.generationMs ?? null,
        },
      });
      await recordTaskEvent(tx, {
        userId: input.userId,
        taskId: input.taskId,
        kind: AGENT_TASK_EVENT_KIND.HANDOFF_COMMIT,
        payload: {
          revision,
          stateHash: stateHash.slice(0, 16),
          sessionId: input.sessionId ?? null,
        },
      });
      return { status: "committed", revision, stateHash } as const;
    });
  } catch (error) {
    if (error instanceof RollbackSignal) return error.result;
    if (isUniqueViolation(error)) return { status: "revision_conflict" };
    throw error;
  }
}

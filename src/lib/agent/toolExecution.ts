import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { CareerRuntimeError } from "@/lib/career/errors";
import { ConversationRequestError } from "./conversationRequest";

export const AGENT_TOOL_EXECUTION_STATUS = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  ABORTED: "ABORTED",
} as const;

export type AgentToolExecutionStatus =
  (typeof AGENT_TOOL_EXECUTION_STATUS)[keyof typeof AGENT_TOOL_EXECUTION_STATUS];

export const MATCH_JOB_TOOL_NAME = "match_job";

type Db = Pick<PrismaClient, "$transaction"> & {
  agentToolExecution: PrismaClient["agentToolExecution"];
};

export type AgentToolExecutionRow = Prisma.AgentToolExecutionGetPayload<object>;

export type AcquireToolExecutionResult =
  | { state: "fresh"; execution: AgentToolExecutionRow }
  | { state: "resume"; execution: AgentToolExecutionRow }
  | { state: "replay"; execution: AgentToolExecutionRow };

function evaluateExisting(
  execution: AgentToolExecutionRow,
  inputHash: string,
): AcquireToolExecutionResult {
  if (execution.inputHash !== inputHash) {
    // Same persisted turn re-proposing a different tool input is a turn
    // conflict, not a second execution.
    throw new ConversationRequestError("CONVERSATION_TURN_CONFLICT");
  }
  return execution.status === AGENT_TOOL_EXECUTION_STATUS.PENDING
    ? { state: "resume", execution }
    : { state: "replay", execution };
}

/**
 * Create or reuse the durable match_job execution for one persisted turn.
 *
 * The dedupe identity is (conversationId, toolName, turnKey) where turnKey
 * is the originating persisted user-message id — recoverable from the
 * admitted request's persisted messages, never the client requestId or the
 * model's toolCallId. A COMPLETED/FAILED row replays its recorded outcome;
 * a PENDING row resumes under the same operationKey; a PENDING row whose
 * turn was superseded (this acquire observes a different live turnKey) is
 * swept to ABORTED, because admissions serialize turns and a dead turn can
 * never come back.
 */
export async function acquireMatchJobExecution(
  db: Db,
  input: {
    userId: string;
    conversationId: string;
    turnKey: string;
    inputHash: string;
  },
): Promise<AcquireToolExecutionResult> {
  return db.$transaction(async (tx) => {
    await tx.agentToolExecution.updateMany({
      where: {
        conversationId: input.conversationId,
        toolName: MATCH_JOB_TOOL_NAME,
        status: AGENT_TOOL_EXECUTION_STATUS.PENDING,
        turnKey: { not: input.turnKey },
      },
      data: {
        status: AGENT_TOOL_EXECUTION_STATUS.ABORTED,
        completedAt: new Date(),
      },
    });

    const existing = await tx.agentToolExecution.findUnique({
      where: {
        conversationId_toolName_turnKey: {
          conversationId: input.conversationId,
          toolName: MATCH_JOB_TOOL_NAME,
          turnKey: input.turnKey,
        },
      },
    });
    if (existing) return evaluateExisting(existing, input.inputHash);

    try {
      const created = await tx.agentToolExecution.create({
        data: {
          userId: input.userId,
          conversationId: input.conversationId,
          toolName: MATCH_JOB_TOOL_NAME,
          turnKey: input.turnKey,
          inputHash: input.inputHash,
          operationKey: `match-analysis:${randomUUID()}`,
          status: AGENT_TOOL_EXECUTION_STATUS.PENDING,
        },
      });
      return { state: "fresh", execution: created } as const;
    } catch (error) {
      // A concurrent execute on the same turn lost the create race — the
      // winner's row is authoritative, re-read it and take its path.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        const winner = await tx.agentToolExecution.findUnique({
          where: {
            conversationId_toolName_turnKey: {
              conversationId: input.conversationId,
              toolName: MATCH_JOB_TOOL_NAME,
              turnKey: input.turnKey,
            },
          },
        });
        if (winner) return evaluateExisting(winner, input.inputHash);
      }
      throw error;
    }
  });
}

/**
 * Atomically bind a completed MatchAnalysis to this execution. Called inside
 * the same transaction that persists the analysis — a count of zero means
 * the reservation was already settled or swept, and the caller must re-read
 * the execution row to decide whether it is replaying a finished execution.
 */
export async function completeMatchJobExecution(
  tx: Prisma.TransactionClient,
  input: { operationKey: string; matchAnalysisId: string },
): Promise<void> {
  const linked = await tx.agentToolExecution.updateMany({
    where: {
      operationKey: input.operationKey,
      status: AGENT_TOOL_EXECUTION_STATUS.PENDING,
    },
    data: {
      status: AGENT_TOOL_EXECUTION_STATUS.COMPLETED,
      matchAnalysisId: input.matchAnalysisId,
      completedAt: new Date(),
    },
  });
  if (linked.count !== 1) {
    throw new CareerRuntimeError(
      "TOOL_EXECUTION_CONFLICT",
      "match_job execution is no longer pending",
    );
  }
}

/** Record the serialized terminal outcome for a COMPLETED execution. */
export async function recordMatchJobResult(
  db: Db,
  input: { operationKey: string; resultJson: string },
): Promise<void> {
  await db.agentToolExecution.updateMany({
    where: {
      operationKey: input.operationKey,
      status: AGENT_TOOL_EXECUTION_STATUS.COMPLETED,
    },
    data: { resultJson: input.resultJson },
  });
}

/** Record a terminal non-analysis outcome (failure, selection ask, etc). */
export async function failMatchJobExecution(
  db: Db,
  input: {
    operationKey: string;
    failureCode: string | null;
    resultJson: string;
  },
): Promise<void> {
  await db.agentToolExecution.updateMany({
    where: {
      operationKey: input.operationKey,
      status: AGENT_TOOL_EXECUTION_STATUS.PENDING,
    },
    data: {
      status: AGENT_TOOL_EXECUTION_STATUS.FAILED,
      failureCode: input.failureCode,
      resultJson: input.resultJson,
      completedAt: new Date(),
    },
  });
}

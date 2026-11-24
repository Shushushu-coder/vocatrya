import { decodeHistory } from "./historyCodec";
import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { isToolUIPart, type UIMessage } from "ai";
import prisma from "@/lib/db";
import { hashCanonical } from "@/lib/career/hash";
import {
  DETACHED_WRITE_SPECS,
  detachedConnectionMaterial,
  detachedProviderOf,
  detachedWriteInputHash,
  isDetachedToolAllowed,
  isDetachedWriteTool,
} from "./detachedWrite";
import {
  HARNESS_TASK_EVENT,
  HARNESS_TASK_KIND,
  HARNESS_TASK_STATUS,
  TERMINAL_TASK_STATUSES,
} from "@/lib/harness/types";
import { appendTaskEvent } from "@/lib/harness/taskService";
import {
  AGENT_PROPOSAL_DECISION_TTL_MS,
  AGENT_PROPOSAL_OUTCOME,
  AGENT_PROPOSAL_REASON,
  AGENT_PROPOSAL_STATUS,
  type AgentOperationProposalDTO,
  type AgentProposalDerived,
  type AgentProposalStatus,
} from "./operationProposalContract";
import { effectiveAgentToolNames } from "./toolPermissions";

type Db = PrismaClient | Prisma.TransactionClient;

export const AGENT_WRITE_TASK_INPUT_VERSION = "1";

export class OperationProposalError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "OperationProposalError";
  }
}

const fail = (code: string, message?: string): never => {
  throw new OperationProposalError(code, message);
};

// ---------------------------------------------------------------------------
// Transcript-part helpers (the part is display, the row is authority)
// ---------------------------------------------------------------------------

function toolNameOfPart(part: unknown): string | null {
  if (!part || typeof part !== "object") return null;
  const type = (part as { type?: string }).type;
  if (typeof type !== "string" || !type.startsWith("tool-")) return null;
  return type.slice("tool-".length);
}

function flipPartToResponded(
  part: UIMessage["parts"][number],
  input: { approved: boolean; reason?: string },
): void {
  const approval = isToolUIPart(part) ? part.approval : undefined;
  Object.assign(part, {
    state: "approval-responded",
    approval: {
      id: approval?.id ?? randomUUID(),
      approved: input.approved,
      ...(input.reason ? { reason: input.reason } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Proposal creation (finish-time, inside the finish transaction)
// ---------------------------------------------------------------------------

/**
 * Create PROPOSED rows for detached write-tool parts on the message this
 * request just produced. Only the response message is scanned — older
 * proposal-less approval parts are legacy orphans handled by reconcile,
 * never re-armed. Parts whose input fails the tool schema get no row: an
 * unexecutable proposal is marked not-continuable by the same pass.
 */
export async function createProposalsForResponseMessage(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    conversationId: string;
    turnKey: string;
    message: UIMessage;
  },
): Promise<number> {
  const parts = input.message.parts.filter(
    (part) =>
      isToolUIPart(part) &&
      part.state === "approval-requested" &&
      isDetachedWriteTool(toolNameOfPart(part) ?? ""),
  );
  if (parts.length === 0) return 0;
  let created = 0;
  for (const part of parts) {
    if (!isToolUIPart(part)) continue;
    const toolName = toolNameOfPart(part)!;
    const spec = DETACHED_WRITE_SPECS[toolName];
    const parsed = spec?.schema.safeParse(part.input);
    if (!parsed?.success) continue;
    // The proposal binds the connection it was created under — a later
    // dispatch under a different workspace/app refuses WORKSPACE_CHANGED.
    const material = await detachedConnectionMaterial(
      input.userId,
      toolName,
      tx,
    );
    try {
      await tx.agentOperationProposal.create({
        data: {
          userId: input.userId,
          conversationId: input.conversationId,
          messageId: input.message.id,
          toolCallId: part.toolCallId,
          approvalId: part.approval?.id ?? randomUUID(),
          turnKey: input.turnKey,
          toolName,
          inputJson: JSON.stringify(parsed.data),
          inputHash: detachedWriteInputHash(parsed.data),
          materialJson: JSON.stringify(material),
          status: AGENT_PROPOSAL_STATUS.PROPOSED,
          expiresAt: new Date(Date.now() + AGENT_PROPOSAL_DECISION_TTL_MS),
        },
      });
      created += 1;
    } catch (error) {
      // A replayed finish lands on the same toolCallId — the winner's
      // row is authoritative, creation is idempotent.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      )
        continue;
      throw error;
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// Reconcile — proposal row is authority, transcript part is its display
// ---------------------------------------------------------------------------

/**
 * Align transcript parts with the proposal ledger before any admission
 * decision is computed (D3/C08):
 *  - proposal decided elsewhere → part mirrors the stored decision;
 *  - proposal expired → part reads as expired;
 *  - no proposal row (pre-H05 orphan) → part is marked not-continuable —
 *    never silently re-armed, never left to deadlock the conversation;
 *  - a PROPOSED row whose part is gone/decided is SUPERSEDED — an
 *    approval-responded part never auto-approves a row.
 */
export async function reconcileConversationProposals(
  tx: Prisma.TransactionClient,
  conversation: { id: string; userId: string },
  messages: UIMessage[],
  now: Date = new Date(),
): Promise<{ changed: boolean }> {
  let changed = false;
  const pendingToolCallIds = new Set<string>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const toolName = toolNameOfPart(part);
      if (!toolName || !isDetachedWriteTool(toolName)) continue;
      if (part.state !== "approval-requested") continue;
      const proposal = await tx.agentOperationProposal.findUnique({
        where: { toolCallId: part.toolCallId },
      });
      if (!proposal || proposal.userId !== conversation.userId) {
        flipPartToResponded(part, {
          approved: false,
          reason: AGENT_PROPOSAL_REASON.LEGACY_NOT_CONTINUABLE,
        });
        changed = true;
        continue;
      }
      if (
        proposal.status === AGENT_PROPOSAL_STATUS.PROPOSED &&
        proposal.expiresAt <= now
      ) {
        await tx.agentOperationProposal.updateMany({
          where: { id: proposal.id, status: AGENT_PROPOSAL_STATUS.PROPOSED },
          data: { status: AGENT_PROPOSAL_STATUS.EXPIRED, revision: { increment: 1 } },
        });
        flipPartToResponded(part, {
          approved: false,
          reason: AGENT_PROPOSAL_REASON.EXPIRED,
        });
        changed = true;
        continue;
      }
      if (proposal.status === AGENT_PROPOSAL_STATUS.PROPOSED) {
        pendingToolCallIds.add(part.toolCallId);
        continue;
      }
      flipPartToResponded(part, {
        approved: proposal.status === AGENT_PROPOSAL_STATUS.APPROVED,
        reason:
          proposal.decisionReason ??
          (proposal.status === AGENT_PROPOSAL_STATUS.EXPIRED
            ? AGENT_PROPOSAL_REASON.EXPIRED
            : proposal.status),
      });
      changed = true;
    }
  }
  // A PROPOSED row with no live approval-requested part cannot collect a
  // decision — the part was decided without it or removed from the tail.
  const dead = await tx.agentOperationProposal.updateMany({
    where: {
      conversationId: conversation.id,
      status: AGENT_PROPOSAL_STATUS.PROPOSED,
      // Re-proposals carry no transcript part — they stay decidable.
      messageId: { not: null },
      toolCallId: { notIn: [...pendingToolCallIds] },
    },
    data: { status: AGENT_PROPOSAL_STATUS.SUPERSEDED, revision: { increment: 1 } },
  });
  if (dead.count > 0) changed = true;
  return { changed };
}

/** Mirror a stored decision into the transcript part, best-effort CAS. */
async function mirrorProposalDecision(
  tx: Prisma.TransactionClient,
  proposal: {
    conversationId: string | null;
    toolCallId: string;
    userId: string;
  },
  input: { approved: boolean; reason?: string },
): Promise<void> {
  if (!proposal.conversationId) return;
  const row = await tx.chatConversation.findUnique({
    where: { id: proposal.conversationId },
    select: { revision: true, activeRequestId: true, messages: true },
  });
  if (!row || row.activeRequestId !== null) return;
  const messages = JSON.parse(decodeHistory(row.messages)) as UIMessage[];
  let hit = false;
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        isToolUIPart(part) &&
        part.toolCallId === proposal.toolCallId &&
        part.state === "approval-requested"
      ) {
        flipPartToResponded(part, input);
        hit = true;
      }
    }
  }
  if (!hit) return;
  await tx.chatConversation.updateMany({
    where: {
      id: proposal.conversationId,
      revision: row.revision,
      activeRequestId: null,
    },
    data: { messages: JSON.stringify(messages), revision: { increment: 1 } },
  });
}

// ---------------------------------------------------------------------------
// Decide — CAS + atomic task creation (one proposal binds at most one task)
// ---------------------------------------------------------------------------

export type ProposalDecisionResult =
  | { state: "approved"; proposalId: string; taskId: string }
  | { state: "rejected"; proposalId: string }
  | { state: "already"; proposalId: string; status: string; taskId: string | null }
  | { state: "expired"; proposalId: string };

/**
 * The only path that turns PROPOSED into a decision. Same-decision replays
 * return the stored state; opposite/concurrent decisions conflict. APPROVED
 * creates its AGENT_TOOL_WRITE task in the same transaction — approval can
 * never commit without its executor row.
 */
export async function decideOperationProposalInTx(
  tx: Prisma.TransactionClient,
  input: {
    userId: string;
    proposalId?: string;
    toolCallId?: string;
    decision: "approve" | "reject";
    reason?: string;
    mirrorPart?: boolean;
  },
): Promise<ProposalDecisionResult> {
  const now = new Date();
  const row = await tx.agentOperationProposal.findFirst({
    where: {
      userId: input.userId,
      ...(input.proposalId ? { id: input.proposalId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    },
  });
  if (!row) return fail("PROPOSAL_NOT_FOUND");

  if (
    row.status === AGENT_PROPOSAL_STATUS.PROPOSED &&
    row.expiresAt <= now
  ) {
    await tx.agentOperationProposal.updateMany({
      where: { id: row.id, status: AGENT_PROPOSAL_STATUS.PROPOSED },
      data: { status: AGENT_PROPOSAL_STATUS.EXPIRED, revision: { increment: 1 } },
    });
    return { state: "expired", proposalId: row.id };
  }
  if (row.status !== AGENT_PROPOSAL_STATUS.PROPOSED) {
    const same =
      (input.decision === "approve" &&
        row.status === AGENT_PROPOSAL_STATUS.APPROVED) ||
      (input.decision === "reject" &&
        row.status === AGENT_PROPOSAL_STATUS.REJECTED);
    if (same) {
      return {
        state: "already",
        proposalId: row.id,
        status: row.status,
        taskId: row.harnessTaskId,
      };
    }
    return fail("PROPOSAL_ALREADY_DECIDED");
  }

  if (input.decision === "approve") {
    if (!row.conversationId) return fail("PROPOSAL_SOURCE_DELETED");
    const conversation = await tx.chatConversation.findUnique({
      where: { id: row.conversationId },
      select: { archivedAt: true, agentRole: true },
    });
    if (!conversation) return fail("PROPOSAL_SOURCE_DELETED");
    if (conversation.archivedAt) return fail("PROPOSAL_SOURCE_ARCHIVED");
    // The decision binds the tool surface the source conversation actually
    // exposes — a NULL legacy role keeps the general registry, never widens.
    const provider = detachedProviderOf(row.toolName);
    const effective = effectiveAgentToolNames({
      agentRole: conversation.agentRole,
      ...(provider === "feishu"
        ? { feishuTools: [row.toolName] }
        : { notionTools: [row.toolName] }),
    });
    if (!effective.includes(row.toolName)) return fail("PROPOSAL_TOOL_FORBIDDEN");
    if (!(await isDetachedToolAllowed(input.userId, row.toolName, tx))) {
      return fail("PROPOSAL_CONNECTION_UNAVAILABLE");
    }
  }

  const next =
    input.decision === "approve"
      ? AGENT_PROPOSAL_STATUS.APPROVED
      : AGENT_PROPOSAL_STATUS.REJECTED;
  const decided = await tx.agentOperationProposal.updateMany({
    where: {
      id: row.id,
      status: AGENT_PROPOSAL_STATUS.PROPOSED,
      revision: row.revision,
    },
    data: {
      status: next,
      decidedAt: now,
      decisionReason: input.reason ?? null,
      revision: { increment: 1 },
    },
  });
  if (decided.count !== 1) {
    const current = await tx.agentOperationProposal.findUnique({
      where: { id: row.id },
    });
    if (current && current.status !== AGENT_PROPOSAL_STATUS.PROPOSED) {
      const same =
        (input.decision === "approve" &&
          current.status === AGENT_PROPOSAL_STATUS.APPROVED) ||
        (input.decision === "reject" &&
          current.status === AGENT_PROPOSAL_STATUS.REJECTED);
      if (same) {
        return {
          state: "already",
          proposalId: current.id,
          status: current.status,
          taskId: current.harnessTaskId,
        };
      }
    }
    return fail("PROPOSAL_ALREADY_DECIDED");
  }

  if (input.decision === "reject") {
    if (input.mirrorPart !== false) {
      await mirrorProposalDecision(tx, row, {
        approved: false,
        reason: input.reason,
      });
    }
    return { state: "rejected", proposalId: row.id };
  }

  const taskInputJson = JSON.stringify({
    v: AGENT_WRITE_TASK_INPUT_VERSION,
    proposalId: row.id,
    toolName: row.toolName,
    inputHash: row.inputHash,
  });
  const task = await tx.harnessTask.create({
    data: {
      userId: input.userId,
      kind: HARNESS_TASK_KIND.AGENT_TOOL_WRITE,
      status: HARNESS_TASK_STATUS.QUEUED,
      requestKey: row.id,
      inputHash: hashCanonical({
        kind: HARNESS_TASK_KIND.AGENT_TOOL_WRITE,
        input: taskInputJson,
      }),
      inputJson: taskInputJson,
      jobOpportunityId: null,
    },
  });
  await appendTaskEvent(tx, {
    taskId: task.id,
    epoch: 0,
    type: HARNESS_TASK_EVENT.TASK_CREATED,
    payload: {
      kind: HARNESS_TASK_KIND.AGENT_TOOL_WRITE,
      proposalId: row.id,
      toolName: row.toolName,
    },
  });
  await tx.agentOperationProposal.update({
    where: { id: row.id },
    data: { harnessTaskId: task.id },
  });
  if (input.mirrorPart !== false) {
    await mirrorProposalDecision(tx, row, { approved: true });
  }
  return { state: "approved", proposalId: row.id, taskId: task.id };
}

// ---------------------------------------------------------------------------
// Withdraw / cancel boundary
// ---------------------------------------------------------------------------

/**
 * PROPOSED discards the proposal; APPROVED only withdraws while the
 * dispatch boundary has not been crossed (dispatchedAt null) — after the
 * marker the remote call may already be out and only a real outcome can
 * settle it.
 */
export async function withdrawOperationProposal(
  db: PrismaClient,
  input: { userId: string; proposalId: string },
): Promise<{ state: string }> {
  return db.$transaction(async (tx) => {
    const row = await tx.agentOperationProposal.findFirst({
      where: { id: input.proposalId, userId: input.userId },
    });
    if (!row) return fail("PROPOSAL_NOT_FOUND");
    if (row.status === AGENT_PROPOSAL_STATUS.PROPOSED) {
      const done = await tx.agentOperationProposal.updateMany({
        where: { id: row.id, status: AGENT_PROPOSAL_STATUS.PROPOSED },
        data: {
          status: AGENT_PROPOSAL_STATUS.WITHDRAWN,
          decidedAt: new Date(),
          decisionReason: AGENT_PROPOSAL_REASON.WITHDRAWN,
          revision: { increment: 1 },
        },
      });
      if (done.count !== 1) return fail("PROPOSAL_ALREADY_DECIDED");
      await mirrorProposalDecision(tx, row, {
        approved: false,
        reason: AGENT_PROPOSAL_REASON.WITHDRAWN,
      });
      return { state: "withdrawn" };
    }
    if (row.status !== AGENT_PROPOSAL_STATUS.APPROVED) {
      return { state: row.status.toLowerCase() };
    }
    if (row.dispatchedAt !== null) return fail("PROPOSAL_ALREADY_DISPATCHED");
    if (row.outcomeStatus !== null) return { state: row.outcomeStatus.toLowerCase() };
    const done = await tx.agentOperationProposal.updateMany({
      where: {
        id: row.id,
        status: AGENT_PROPOSAL_STATUS.APPROVED,
        dispatchedAt: null,
        outcomeStatus: null,
      },
      data: {
        status: AGENT_PROPOSAL_STATUS.WITHDRAWN,
        outcomeStatus: AGENT_PROPOSAL_OUTCOME.CANCELLED,
        outcomeJson: JSON.stringify({
          status: "cancelled",
          code: AGENT_PROPOSAL_REASON.WITHDRAWN,
        }),
        revision: { increment: 1 },
      },
    });
    if (done.count !== 1) return fail("PROPOSAL_ALREADY_DISPATCHED");
    if (row.harnessTaskId) {
      const now = new Date();
      const queued = await tx.harnessTask.updateMany({
        where: { id: row.harnessTaskId, status: HARNESS_TASK_STATUS.QUEUED },
        data: {
          status: HARNESS_TASK_STATUS.CANCELLED,
          cancelRequestedAt: now,
          completedAt: now,
          leaseUntil: null,
        },
      });
      if (queued.count === 1) {
        await appendTaskEvent(tx, {
          taskId: row.harnessTaskId,
          epoch: 0,
          type: HARNESS_TASK_EVENT.TASK_CANCELLED,
          payload: { source: "withdraw" },
        });
      } else {
        const running = await tx.harnessTask.updateMany({
          where: { id: row.harnessTaskId, status: HARNESS_TASK_STATUS.RUNNING },
          data: {
            status: HARNESS_TASK_STATUS.CANCELLING,
            cancelRequestedAt: now,
          },
        });
        if (running.count === 1) {
          await appendTaskEvent(tx, {
            taskId: row.harnessTaskId,
            epoch: 0,
            type: HARNESS_TASK_EVENT.CANCEL_REQUESTED,
            payload: { source: "withdraw" },
          });
        }
      }
    }
    await mirrorProposalDecision(tx, row, {
      approved: false,
      reason: AGENT_PROPOSAL_REASON.WITHDRAWN,
    });
    return { state: "withdrawn" };
  });
}

// ---------------------------------------------------------------------------
// Hard-delete lifecycle (called inside the conversation delete tx)
// ---------------------------------------------------------------------------

/**
 * Source delete vs dispatch share one race boundary: PROPOSED rows die as
 * SUPERSEDED, APPROVED-but-undispatched rows are withdrawn with their task
 * cancelled, dispatched/UNCERTAIN/terminal rows keep their evidence —
 * SetNull on conversationId is the FK's part, nothing here re-arms them.
 */
export async function prepareConversationDelete(
  tx: Prisma.TransactionClient,
  input: { userId: string; conversationId: string },
): Promise<void> {
  const rows = await tx.agentOperationProposal.findMany({
    where: { conversationId: input.conversationId, userId: input.userId },
  });
  const now = new Date();
  for (const row of rows) {
    if (row.status === AGENT_PROPOSAL_STATUS.PROPOSED) {
      await tx.agentOperationProposal.updateMany({
        where: { id: row.id, status: AGENT_PROPOSAL_STATUS.PROPOSED },
        data: {
          status: AGENT_PROPOSAL_STATUS.SUPERSEDED,
          decisionReason: AGENT_PROPOSAL_REASON.SOURCE_DELETED,
          revision: { increment: 1 },
        },
      });
    } else if (
      row.status === AGENT_PROPOSAL_STATUS.APPROVED &&
      row.dispatchedAt === null &&
      row.outcomeStatus === null
    ) {
      const done = await tx.agentOperationProposal.updateMany({
        where: {
          id: row.id,
          status: AGENT_PROPOSAL_STATUS.APPROVED,
          dispatchedAt: null,
          outcomeStatus: null,
        },
        data: {
          status: AGENT_PROPOSAL_STATUS.WITHDRAWN,
          outcomeStatus: AGENT_PROPOSAL_OUTCOME.CANCELLED,
          outcomeJson: JSON.stringify({
            status: "cancelled",
            code: AGENT_PROPOSAL_REASON.SOURCE_DELETED,
          }),
          revision: { increment: 1 },
        },
      });
      if (done.count === 1 && row.harnessTaskId) {
        const queued = await tx.harnessTask.updateMany({
          where: { id: row.harnessTaskId, status: HARNESS_TASK_STATUS.QUEUED },
          data: {
            status: HARNESS_TASK_STATUS.CANCELLED,
            cancelRequestedAt: now,
            completedAt: now,
            leaseUntil: null,
          },
        });
        if (queued.count !== 1) {
          await tx.harnessTask.updateMany({
            where: { id: row.harnessTaskId, status: HARNESS_TASK_STATUS.RUNNING },
            data: {
              status: HARNESS_TASK_STATUS.CANCELLING,
              cancelRequestedAt: now,
            },
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Re-proposal / manual resolution
// ---------------------------------------------------------------------------

/**
 * A re-execution is always a new proposal bound to the old one's history.
 * "No dispatch marker" is never proof the write never went out — an
 * APPROVED row without a settled outcome (backup-restored, crashed
 * pre-settle, or UNCERTAIN) must carry the user's manual attestation
 * before it can seed a retry. Rows with a live task stay active.
 */
export async function reproposeOperation(
  db: PrismaClient,
  input: { userId: string; proposalId: string },
): Promise<{ proposalId: string }> {
  const source = await db.agentOperationProposal.findFirst({
    where: { id: input.proposalId, userId: input.userId },
  });
  if (!source) return fail("PROPOSAL_NOT_FOUND");
  const now = new Date();
  if (
    source.status === AGENT_PROPOSAL_STATUS.PROPOSED &&
    source.expiresAt > now
  ) {
    return fail("PROPOSAL_STILL_ACTIVE");
  }
  if (source.status === AGENT_PROPOSAL_STATUS.APPROVED) {
    const task = source.harnessTaskId
      ? await db.harnessTask.findUnique({
          where: { id: source.harnessTaskId },
          select: { status: true },
        })
      : null;
    const taskLive =
      task !== null &&
      (
        [
          HARNESS_TASK_STATUS.QUEUED,
          HARNESS_TASK_STATUS.RUNNING,
          HARNESS_TASK_STATUS.CANCELLING,
        ] as string[]
      ).includes(task.status);
    if (taskLive) return fail("PROPOSAL_STILL_ACTIVE");
    // Outcome is absent or unresolved: the user must attest what Notion
    // shows before a re-execution may be proposed.
    const unresolved =
      source.outcomeStatus === null ||
      source.outcomeStatus === AGENT_PROPOSAL_OUTCOME.UNCERTAIN;
    if (unresolved && source.manualResolution === null) {
      return fail("PROPOSAL_NEEDS_RECONCILE");
    }
  }
  const toolCallId = `repropose-${randomUUID()}`;
  const created = await db.agentOperationProposal.create({
    data: {
      userId: source.userId,
      conversationId: source.conversationId,
      messageId: null,
      toolCallId,
      approvalId: randomUUID(),
      turnKey: `reproposal:${toolCallId}`,
      toolName: source.toolName,
      inputJson: source.inputJson,
      inputHash: source.inputHash,
      materialJson: source.materialJson,
      status: AGENT_PROPOSAL_STATUS.PROPOSED,
      expiresAt: new Date(Date.now() + AGENT_PROPOSAL_DECISION_TTL_MS),
      supersedesId: source.id,
    },
  });
  return { proposalId: created.id };
}

/** The user attests what Notion shows — recorded as evidence, never as a
 *  fabricated remote receipt. Attestation is accepted for UNCERTAIN
 *  outcomes and for APPROVED rows with no outcome and no live task —
 *  the backup-restore "unverified" state: no dispatch marker is not
 *  proof nothing was sent, but it is not auto-replayed either. */
export async function resolveUncertainProposal(
  db: PrismaClient,
  input: {
    userId: string;
    proposalId: string;
    resolution: "HAPPENED" | "NOT_HAPPENED" | "STILL_UNCERTAIN";
  },
): Promise<void> {
  const row = await db.agentOperationProposal.findFirst({
    where: { id: input.proposalId, userId: input.userId },
  });
  if (!row || row.status !== AGENT_PROPOSAL_STATUS.APPROVED) {
    return fail("PROPOSAL_NOT_UNCERTAIN");
  }
  let attestable = row.outcomeStatus === AGENT_PROPOSAL_OUTCOME.UNCERTAIN;
  if (!attestable && row.outcomeStatus === null) {
    const task = row.harnessTaskId
      ? await db.harnessTask.findUnique({
          where: { id: row.harnessTaskId },
          select: { status: true },
        })
      : null;
    attestable =
      task === null ||
      !(
        [
          HARNESS_TASK_STATUS.QUEUED,
          HARNESS_TASK_STATUS.RUNNING,
          HARNESS_TASK_STATUS.CANCELLING,
        ] as string[]
      ).includes(task.status);
  }
  if (!attestable) return fail("PROPOSAL_NOT_UNCERTAIN");
  const resolved = await db.agentOperationProposal.updateMany({
    where: {
      id: row.id,
      status: AGENT_PROPOSAL_STATUS.APPROVED,
    },
    data: {
      manualResolution: input.resolution,
      resolvedAt: new Date(),
    },
  });
  if (resolved.count !== 1) return fail("PROPOSAL_NOT_UNCERTAIN");
}

// ---------------------------------------------------------------------------
// Reads + DTO
// ---------------------------------------------------------------------------

type ProposalRow = Prisma.AgentOperationProposalGetPayload<object>;

function derivedOf(row: ProposalRow, task: { status: string } | null): AgentProposalDerived {
  const now = new Date();
  switch (row.status) {
    case AGENT_PROPOSAL_STATUS.PROPOSED:
      return row.expiresAt <= now ? "expired" : "pending";
    case AGENT_PROPOSAL_STATUS.APPROVED: {
      if (row.outcomeStatus === AGENT_PROPOSAL_OUTCOME.SUCCEEDED) return "succeeded";
      if (row.outcomeStatus === AGENT_PROPOSAL_OUTCOME.FAILED) return "failed";
      if (row.outcomeStatus === AGENT_PROPOSAL_OUTCOME.UNCERTAIN) return "uncertain";
      if (row.outcomeStatus === AGENT_PROPOSAL_OUTCOME.CANCELLED) return "cancelled";
      if (row.expiresAt <= now && row.dispatchedAt === null) return "expired";
      if (!task) return "unverified";
      if (task.status === HARNESS_TASK_STATUS.QUEUED) return "queued";
      if (task.status === HARNESS_TASK_STATUS.RUNNING) return "running";
      if (task.status === HARNESS_TASK_STATUS.CANCELLING) return "cancelling";
      if (task.status === HARNESS_TASK_STATUS.SUCCEEDED) return "succeeded";
      if (task.status === HARNESS_TASK_STATUS.FAILED) return "failed";
      return "cancelled";
    }
    case AGENT_PROPOSAL_STATUS.REJECTED:
      return "rejected";
    case AGENT_PROPOSAL_STATUS.WITHDRAWN:
      return "withdrawn";
    case AGENT_PROPOSAL_STATUS.SUPERSEDED:
      return "superseded";
    default:
      return "expired";
  }
}

export async function toProposalDTO(
  db: Db,
  row: ProposalRow,
): Promise<AgentOperationProposalDTO> {
  const [task, conversation] = await Promise.all([
    row.harnessTaskId
      ? db.harnessTask.findUnique({
          where: { id: row.harnessTaskId },
          select: { status: true },
        })
      : Promise.resolve(null),
    row.conversationId
      ? db.chatConversation.findUnique({
          where: { id: row.conversationId },
          select: { archivedAt: true },
        })
      : Promise.resolve(null),
  ]);
  let parsedInput: Record<string, unknown> = {};
  try {
    parsedInput = JSON.parse(row.inputJson) as Record<string, unknown>;
  } catch {
    // Corrupt rows display as empty input rather than crashing the card.
  }
  let outcome: unknown = null;
  try {
    outcome = row.outcomeJson ? JSON.parse(row.outcomeJson) : null;
  } catch {
    outcome = null;
  }
  const summary = DETACHED_WRITE_SPECS[row.toolName]?.summaryOf(parsedInput) ?? {};
  return {
    id: row.id,
    toolName: row.toolName,
    status: row.status as AgentProposalStatus,
    derived: derivedOf(row, task),
    input: parsedInput,
    target: summary.target,
    contentSummary: summary.content,
    conversationId: row.conversationId,
    sourceArchived: conversation?.archivedAt != null,
    approvalId: row.approvalId,
    toolCallId: row.toolCallId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    dispatched: row.dispatchedAt !== null,
    taskId: row.harnessTaskId,
    taskStatus: task?.status ?? null,
    outcomeStatus: (row.outcomeStatus as AgentOperationProposalDTO["outcomeStatus"]) ?? null,
    outcome,
    manualResolution: row.manualResolution,
    supersedesId: row.supersedesId,
  };
}

async function expireStaleProposals(
  db: Db,
  userId: string,
): Promise<void> {
  await db.agentOperationProposal.updateMany({
    where: {
      userId,
      status: AGENT_PROPOSAL_STATUS.PROPOSED,
      expiresAt: { lte: new Date() },
    },
    data: { status: AGENT_PROPOSAL_STATUS.EXPIRED, revision: { increment: 1 } },
  });
}

export async function getOperationProposal(
  db: PrismaClient,
  input: { userId: string; proposalId?: string; approvalId?: string; toolCallId?: string },
): Promise<AgentOperationProposalDTO | null> {
  await expireStaleProposals(db, input.userId);
  const row = await db.agentOperationProposal.findFirst({
    where: {
      userId: input.userId,
      ...(input.proposalId ? { id: input.proposalId } : {}),
      ...(input.approvalId ? { approvalId: input.approvalId } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
    },
  });
  return row ? toProposalDTO(db, row) : null;
}

/** Pending-decision + needs-attention entries for the chat surface. */
export async function listAttentionProposals(
  db: PrismaClient,
  userId: string,
): Promise<AgentOperationProposalDTO[]> {
  await expireStaleProposals(db, userId);
  const rows = await db.agentOperationProposal.findMany({
    where: {
      userId,
      OR: [
        { status: AGENT_PROPOSAL_STATUS.PROPOSED },
        {
          status: AGENT_PROPOSAL_STATUS.APPROVED,
          OR: [{ outcomeStatus: null }, { outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN }],
        },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const dtos = await Promise.all(rows.map((row) => toProposalDTO(db, row)));
  return dtos.filter(
    (dto) =>
      dto.derived === "pending" ||
      dto.derived === "queued" ||
      dto.derived === "running" ||
      dto.derived === "cancelling" ||
      dto.derived === "uncertain" ||
      dto.derived === "unverified",
  );
}

/** Decide entrypoint used by the standalone actions (own transaction). */
export async function decideOperationProposal(
  db: PrismaClient,
  input: {
    userId: string;
    proposalId: string;
    decision: "approve" | "reject";
    reason?: string;
  },
): Promise<ProposalDecisionResult> {
  return db.$transaction(async (tx) => {
    const result = await decideOperationProposalInTx(tx, {
      userId: input.userId,
      proposalId: input.proposalId,
      decision: input.decision,
      reason: input.reason,
      mirrorPart: true,
    });
    // Expired reads still mirror the part so the pending card unblocks.
    if (result.state === "expired") {
      const row = await tx.agentOperationProposal.findUnique({
        where: { id: result.proposalId },
      });
      if (row) {
        await mirrorProposalDecision(tx, row, {
          approved: false,
          reason: AGENT_PROPOSAL_REASON.EXPIRED,
        });
      }
    }
    return result;
  });
}

export { isDetachedWriteTool, TERMINAL_TASK_STATUSES };

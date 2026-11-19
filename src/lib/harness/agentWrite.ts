import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import type {
  AgentNotionWriteResult,
  AgentNotionWriteVerify,
} from "@/models/agent.model";
import {
  NOTION_ERROR,
  NotionError,
  isNotionError,
} from "@/lib/extensions/notion/errors";
import {
  callNotionRemoteTool,
  classifyNotionToolError,
  mapNotionRemoteError,
  remoteToolText,
} from "@/lib/extensions/notion/mcpClient";
import { resolveNotionAccessToken } from "@/lib/extensions/notion/service";
import { pickRemoteArgs } from "@/lib/extensions/notion/remoteArgs";
import { resolveNotionRemoteMeta } from "@/lib/agent/tools/notion";
import {
  NOTION_WRITE_SPECS,
  notionWriteInputHash,
} from "@/lib/agent/notionWriteSpec";
import { effectiveAgentToolNames } from "@/lib/agent/toolPermissions";
import {
  AGENT_PROPOSAL_OUTCOME,
  AGENT_PROPOSAL_REASON,
  AGENT_PROPOSAL_STATUS,
} from "@/lib/agent/operationProposalContract";
import {
  AGENT_TOOL_EXECUTION_STATUS,
} from "@/lib/agent/toolExecution";
import { log } from "@/lib/telemetry";
import {
  appendTaskEvent,
  guardedTaskUpdate,
  writeStepCheckpoint,
  type HarnessClaim,
} from "./taskService";
import {
  AGENT_WRITE_TASK_STEP,
  HARNESS_TASK_EVENT,
  HARNESS_TASK_STATUS,
  HarnessOwnershipLost,
} from "./types";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * AGENT_TOOL_WRITE executor — VERIFY → DISPATCH → SETTLE against the
 * durable AgentOperationProposal authority. The dispatch marker (CAS on
 * dispatchedAt) is "the remote call may be out", never a success claim;
 * everything that cannot be proven settles UNCERTAIN and is never resent.
 */

type SettleInput = {
  outcomeStatus: string;
  outcome: AgentNotionWriteResult | { status: string; code: string };
  taskStatus: string;
  failureCode?: string | null;
  failureDetail?: string | null;
  eventType?: string;
};

async function settleWrite(
  db: PrismaClient,
  claim: HarnessClaim,
  proposalId: string,
  input: SettleInput,
): Promise<boolean> {
  const now = new Date();
  const run = async (tx: Prisma.TransactionClient) => {
    await appendTaskEvent(tx, {
      taskId: claim.taskId,
      epoch: claim.epoch,
      type:
        input.eventType ??
        (input.taskStatus === HARNESS_TASK_STATUS.SUCCEEDED
          ? HARNESS_TASK_EVENT.TASK_SUCCEEDED
          : input.taskStatus === HARNESS_TASK_STATUS.CANCELLED
            ? HARNESS_TASK_EVENT.TASK_CANCELLED
            : HARNESS_TASK_EVENT.TASK_FAILED),
      payload: {
        proposalId,
        outcomeStatus: input.outcomeStatus,
        code: input.failureCode ?? null,
      },
    });
    if (input.taskStatus === HARNESS_TASK_STATUS.CANCELLED) {
      const cancelled = await tx.harnessTask.updateMany({
        where: {
          id: claim.taskId,
          status: HARNESS_TASK_STATUS.CANCELLING,
        },
        data: {
          status: HARNESS_TASK_STATUS.CANCELLED,
          failureCode: input.failureCode ?? null,
          failureDetail: input.failureDetail ?? null,
          completedAt: now,
          leaseUntil: null,
        },
      });
      if (cancelled.count !== 1) {
        await guardedTaskUpdate(tx, claim, {
          status: HARNESS_TASK_STATUS.CANCELLED,
          failureCode: input.failureCode ?? null,
          failureDetail: input.failureDetail ?? null,
          completedAt: now,
          leaseUntil: null,
        });
      }
    } else {
      await guardedTaskUpdate(tx, claim, {
        status: input.taskStatus,
        failureCode: input.failureCode ?? null,
        failureDetail: input.failureDetail ?? null,
        completedAt: now,
        leaseUntil: null,
      });
    }
    // The outcome mirror lands in the same commit — a terminal task state
    // can never drift ahead of the proposal's evidence. Only APPROVED rows
    // carry execution outcomes; decided/rejected rows get no mirror.
    await tx.agentOperationProposal.updateMany({
      where: {
        id: proposalId,
        status: AGENT_PROPOSAL_STATUS.APPROVED,
        outcomeStatus: null,
      },
      data: {
        outcomeStatus: input.outcomeStatus,
        outcomeJson: JSON.stringify(input.outcome),
        revision: { increment: 1 },
      },
    });
  };
  try {
    await db.$transaction(run);
    return true;
  } catch (error) {
    if (error instanceof HarnessOwnershipLost) return false;
    throw error;
  }
}

/** Map a settled error to the stored write output — fixed codes only. */
function settleOutcome(
  toolName: string,
  error: unknown,
  verify: AgentNotionWriteVerify,
): { outcome: AgentNotionWriteResult; outcomeStatus: string; code: string } {
  const mapped = isNotionError(error) ? error : mapNotionRemoteError(error);
  if (mapped.code === NOTION_ERROR.REAUTH_REQUIRED) {
    return {
      outcome: {
        saved: false,
        tool: toolName,
        status: "reauth_required",
        code: mapped.code,
      },
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.FAILED,
      code: mapped.code,
    };
  }
  if (
    mapped.code === NOTION_ERROR.OUTCOME_UNKNOWN ||
    mapped.code === NOTION_ERROR.NETWORK
  ) {
    return {
      outcome: {
        saved: false,
        tool: toolName,
        status: "unknown",
        code: NOTION_ERROR.OUTCOME_UNKNOWN,
        verify,
        detail:
          "The request may or may not have reached Notion. Inspect with the named read tool and reconcile manually; automatic retry is blocked.",
      },
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN,
      code: NOTION_ERROR.OUTCOME_UNKNOWN,
    };
  }
  if (mapped.code === NOTION_ERROR.VERIFICATION_REQUIRED) {
    return {
      outcome: {
        saved: false,
        tool: toolName,
        status: "verification_required",
        code: mapped.code,
        verify,
        detail:
          "An earlier write of this input may already have reached Notion. Reconcile manually before re-proposing.",
      },
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN,
      code: mapped.code,
    };
  }
  return {
    outcome: {
      saved: false,
      tool: toolName,
      status: "failed",
      code: mapped.code,
    },
    outcomeStatus: AGENT_PROPOSAL_OUTCOME.FAILED,
    code: mapped.code,
  };
}

export async function executeAgentWriteTask(
  db: PrismaClient,
  claim: HarnessClaim,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  const task = await db.harnessTask.findUnique({ where: { id: claim.taskId } });
  if (!task || task.status !== HARNESS_TASK_STATUS.RUNNING) return;

  let parsedInput: { v?: string; proposalId?: string; toolName?: string };
  try {
    parsedInput = JSON.parse(task.inputJson) as typeof parsedInput;
  } catch {
    parsedInput = {};
  }
  const spec = parsedInput.toolName
    ? NOTION_WRITE_SPECS[parsedInput.toolName]
    : undefined;
  const proposal = parsedInput.proposalId
    ? await db.agentOperationProposal.findUnique({
        where: { id: parsedInput.proposalId },
      })
    : null;

  const verifyHint = spec?.verifyOf(
    (() => {
      try {
        return JSON.parse(proposal?.inputJson ?? "{}");
      } catch {
        return {};
      }
    })() as Record<string, unknown>,
  );

  const settle = (input: SettleInput) =>
    settleWrite(db, claim, proposal?.id ?? parsedInput.proposalId ?? "", input);

  if (!proposal || !spec || proposal.userId !== task.userId) {
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.FAILED,
      outcome: {
        saved: false,
        tool: parsedInput.toolName ?? "unknown",
        status: "failed",
        code: "PROPOSAL_MISSING",
      },
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: "PROPOSAL_MISSING",
    });
    return;
  }

  // ---------------------------------------------------------------- VERIFY
  if (proposal.status !== AGENT_PROPOSAL_STATUS.APPROVED) {
    // The decision boundary moved under the task (withdrawn / superseded /
    // deleted) — cancel rather than execute.
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.CANCELLED,
      outcome: {
        status: "cancelled",
        code: proposal.status,
      },
      taskStatus: HARNESS_TASK_STATUS.CANCELLED,
      failureCode: "PROPOSAL_NOT_EXECUTABLE",
    });
    return;
  }
  if (proposal.outcomeStatus !== null) {
    // Already settled — mirror the persisted outcome onto the task row.
    const mirror = (() => {
      try {
        return JSON.parse(proposal.outcomeJson!) as AgentNotionWriteResult;
      } catch {
        return {
          saved: false,
          tool: spec.toolName,
          status: "failed",
          code: "OUTCOME_CORRUPT",
        } as AgentNotionWriteResult;
      }
    })();
    await settle({
      outcomeStatus: proposal.outcomeStatus,
      outcome: mirror,
      taskStatus:
        proposal.outcomeStatus === AGENT_PROPOSAL_OUTCOME.SUCCEEDED
          ? HARNESS_TASK_STATUS.SUCCEEDED
          : proposal.outcomeStatus === AGENT_PROPOSAL_OUTCOME.CANCELLED
            ? HARNESS_TASK_STATUS.CANCELLED
            : HARNESS_TASK_STATUS.FAILED,
      failureCode:
        proposal.outcomeStatus === AGENT_PROPOSAL_OUTCOME.SUCCEEDED
          ? null
          : (mirror as { code?: string }).code ?? "OUTCOME_RECORDED",
    });
    return;
  }
  if (proposal.dispatchedAt !== null) {
    // A previous epoch crossed the dispatch boundary and died — the call
    // may already be out. Never resend; settle for manual reconcile.
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN,
      outcome: {
        saved: false,
        tool: spec.toolName,
        status: "unknown",
        code: "DISPATCH_OUTCOME_UNKNOWN",
        verify: verifyHint,
        detail:
          "The operation was dispatched before a restart; whether it reached Notion is unknown. Reconcile manually.",
      },
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: "DISPATCH_OUTCOME_UNKNOWN",
    });
    return;
  }
  const now = new Date();
  if (proposal.expiresAt <= now) {
    // Approved but never dispatched within the decision window — the
    // authorization expired; the approval stays as history.
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.CANCELLED,
      outcome: {
        status: "cancelled",
        code: AGENT_PROPOSAL_REASON.AUTHORIZATION_EXPIRED,
      },
      taskStatus: HARNESS_TASK_STATUS.CANCELLED,
      failureCode: AGENT_PROPOSAL_REASON.AUTHORIZATION_EXPIRED,
    });
    return;
  }

  let immutableInput: Record<string, unknown>;
  try {
    immutableInput = JSON.parse(proposal.inputJson) as Record<string, unknown>;
  } catch {
    immutableInput = {};
  }
  const validated = spec.schema.safeParse(immutableInput);
  if (
    !validated.success ||
    notionWriteInputHash(validated.data) !== proposal.inputHash
  ) {
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.FAILED,
      outcome: {
        saved: false,
        tool: spec.toolName,
        status: "failed",
        code: "PROPOSAL_INPUT_CONFLICT",
      },
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: "PROPOSAL_INPUT_CONFLICT",
    });
    return;
  }
  const input = validated.data;
  const verify = spec.verifyOf(input);

  // Role/tool surface re-check: the conversation is gone or archived, or
  // the role no longer exposes the tool, the write does not silently run.
  if (!proposal.conversationId) {
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.CANCELLED,
      outcome: { status: "cancelled", code: "PROPOSAL_SOURCE_DELETED" },
      taskStatus: HARNESS_TASK_STATUS.CANCELLED,
      failureCode: "PROPOSAL_SOURCE_DELETED",
    });
    return;
  }
  const conversation = await db.chatConversation.findUnique({
    where: { id: proposal.conversationId },
    select: { archivedAt: true, agentRole: true },
  });
  if (!conversation) {
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.CANCELLED,
      outcome: { status: "cancelled", code: "PROPOSAL_SOURCE_DELETED" },
      taskStatus: HARNESS_TASK_STATUS.CANCELLED,
      failureCode: "PROPOSAL_SOURCE_DELETED",
    });
    return;
  }
  if (conversation.archivedAt) {
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.FAILED,
      outcome: {
        saved: false,
        tool: spec.toolName,
        status: "failed",
        code: "PROPOSAL_SOURCE_ARCHIVED",
      },
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: "PROPOSAL_SOURCE_ARCHIVED",
    });
    return;
  }
  const effective = effectiveAgentToolNames({
    agentRole: conversation.agentRole,
    notionTools: [spec.toolName],
  });
  if (!effective.includes(spec.toolName)) {
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.FAILED,
      outcome: {
        saved: false,
        tool: spec.toolName,
        status: "failed",
        code: "PROPOSAL_TOOL_FORBIDDEN",
      },
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: "PROPOSAL_TOOL_FORBIDDEN",
    });
    return;
  }

  // Prior unresolved same-input operations — proposals and the legacy
  // in-turn execution ledger both count as "may already be out". Blocking
  // is judged PER OPERATION, never per input: a NOT_HAPPENED attestation
  // releases only the proposal it was recorded on (and the legacy ledger
  // row of that same turnKey); HAPPENED, STILL_UNCERTAIN and unattested
  // rows keep blocking any re-send of the same input.
  const attestedTurnKeys = (
    await db.agentOperationProposal.findMany({
      where: {
        userId: task.userId,
        toolName: spec.toolName,
        inputHash: proposal.inputHash,
        manualResolution: "NOT_HAPPENED",
      },
      select: { turnKey: true },
    })
  ).map((r) => r.turnKey);
  const [unresolvedProposal, unresolvedExecution] = await Promise.all([
    db.agentOperationProposal.findFirst({
      where: {
        userId: task.userId,
        toolName: spec.toolName,
        inputHash: proposal.inputHash,
        id: { not: proposal.id },
        status: AGENT_PROPOSAL_STATUS.APPROVED,
        OR: [
          { outcomeStatus: null },
          { outcomeStatus: AGENT_PROPOSAL_OUTCOME.UNCERTAIN },
        ],
        AND: [
          {
            OR: [
              { manualResolution: null },
              { manualResolution: { in: ["HAPPENED", "STILL_UNCERTAIN"] } },
            ],
          },
        ],
      },
    }),
    db.agentToolExecution.findFirst({
      where: {
        userId: task.userId,
        toolName: spec.toolName,
        inputHash: proposal.inputHash,
        turnKey: { notIn: attestedTurnKeys },
        OR: [
          {
            status: {
              in: [
                AGENT_TOOL_EXECUTION_STATUS.PENDING,
                AGENT_TOOL_EXECUTION_STATUS.ABORTED,
              ],
            },
          },
          {
            failureCode: {
              in: [
                NOTION_ERROR.OUTCOME_UNKNOWN,
                NOTION_ERROR.VERIFICATION_REQUIRED,
              ],
            },
          },
        ],
      },
    }),
  ]);
  if (unresolvedProposal || unresolvedExecution) {
    const settled = settleOutcome(
      spec.toolName,
      new NotionError(NOTION_ERROR.VERIFICATION_REQUIRED),
      verify,
    );
    await settle({
      outcomeStatus: settled.outcomeStatus,
      outcome: settled.outcome,
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: settled.code,
    });
    return;
  }

  const meta = await resolveNotionRemoteMeta(
    task.userId,
    spec.remoteRequirementsTool,
    db,
  ).catch((error) => ({ error }));
  if ("error" in meta) {
    const settled = settleOutcome(spec.toolName, meta.error, verify);
    await settle({
      outcomeStatus: settled.outcomeStatus,
      outcome: settled.outcome,
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: settled.code,
    });
    return;
  }
  const material = (() => {
    try {
      return JSON.parse(proposal.materialJson ?? "{}") as {
        workspaceId?: string | null;
      };
    } catch {
      return {};
    }
  })();
  if (
    material.workspaceId &&
    meta.workspaceId &&
    material.workspaceId !== meta.workspaceId
  ) {
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.FAILED,
      outcome: {
        saved: false,
        tool: spec.toolName,
        status: "failed",
        code: "WORKSPACE_CHANGED",
        detail:
          "The Notion connection now points at a different workspace; re-propose against the current connection.",
      },
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: "WORKSPACE_CHANGED",
    });
    return;
  }
  const args = pickRemoteArgs(meta.inputSchema, spec.candidates(input));
  if (!args) {
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.FAILED,
      outcome: {
        saved: false,
        tool: spec.toolName,
        status: "failed",
        code: NOTION_ERROR.TOOL_UNAVAILABLE,
      },
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: NOTION_ERROR.TOOL_UNAVAILABLE,
    });
    return;
  }
  try {
    await writeStepCheckpoint(db, claim, {
      step: AGENT_WRITE_TASK_STEP.DISPATCH,
      pinnedJson: JSON.stringify({
        remoteName: meta.remoteName,
        args,
        proposalId: proposal.id,
      }),
      payload: { remoteName: meta.remoteName },
    });
  } catch (error) {
    if (error instanceof HarnessOwnershipLost) return;
    throw error;
  }

  // --------------------------------------------------------------- DISPATCH
  // Claim boundary: the CAS writes "may already be out" before any remote
  // call; a concurrent withdraw/delete/expiry or a prior epoch's marker
  // makes the count miss and nothing is sent.
  const dispatchKey = `agent-write:${proposal.id}`;
  let dispatchClaimed = false;
  try {
    await db.$transaction(async (tx) => {
      await guardedTaskUpdate(tx, claim, {
        currentStep: AGENT_WRITE_TASK_STEP.SETTLE,
      });
      const claimed = await tx.agentOperationProposal.updateMany({
        where: {
          id: proposal.id,
          status: AGENT_PROPOSAL_STATUS.APPROVED,
          dispatchedAt: null,
          outcomeStatus: null,
          expiresAt: { gt: new Date() },
        },
        data: {
          dispatchKey,
          dispatchedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (claimed.count !== 1) throw new HarnessOwnershipLost();
      await appendTaskEvent(tx, {
        taskId: claim.taskId,
        epoch: claim.epoch,
        type: HARNESS_TASK_EVENT.STEP_CHECKPOINT,
        payload: {
          step: AGENT_WRITE_TASK_STEP.DISPATCH,
          proposalId: proposal.id,
          dispatchKey,
          remoteName: meta.remoteName,
        },
      });
      dispatchClaimed = true;
    });
  } catch (error) {
    if (error instanceof HarnessOwnershipLost) {
      // Lost to a newer claim, a cancel flip, or a decision change — the
      // reload below decides whether a settle is still ours to write.
      const fresh = await db.agentOperationProposal.findUnique({
        where: { id: proposal.id },
      });
      if (
        fresh &&
        fresh.status === AGENT_PROPOSAL_STATUS.APPROVED &&
        fresh.expiresAt <= new Date() &&
        fresh.dispatchedAt === null
      ) {
        await settle({
          outcomeStatus: AGENT_PROPOSAL_OUTCOME.CANCELLED,
          outcome: {
            status: "cancelled",
            code: AGENT_PROPOSAL_REASON.AUTHORIZATION_EXPIRED,
          },
          taskStatus: HARNESS_TASK_STATUS.CANCELLED,
          failureCode: AGENT_PROPOSAL_REASON.AUTHORIZATION_EXPIRED,
        });
      }
      return;
    }
    throw error;
  }
  if (!dispatchClaimed) return;

  // Cancel observation between the claim commit and the call: this epoch
  // still owns the boundary, so not calling is a determinate decision.
  const live = await db.harnessTask.findUnique({
    where: { id: claim.taskId },
    select: { status: true },
  });
  if (!live || live.status !== HARNESS_TASK_STATUS.RUNNING || opts.signal?.aborted) {
    await settle({
      outcomeStatus: AGENT_PROPOSAL_OUTCOME.CANCELLED,
      outcome: { status: "cancelled", code: "CANCELLED" },
      taskStatus: HARNESS_TASK_STATUS.CANCELLED,
    });
    return;
  }

  let accessToken: string;
  try {
    accessToken = await resolveNotionAccessToken(task.userId, { db });
  } catch (error) {
    const settled = settleOutcome(spec.toolName, error, verify);
    await settle({
      outcomeStatus: settled.outcomeStatus,
      outcome: settled.outcome,
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: settled.code,
    });
    return;
  }

  // ---------------------------------------------------------------- SETTLE
  let callResult;
  try {
    callResult = await callNotionRemoteTool(accessToken, meta.remoteName, args, {
      signal: opts.signal,
    });
  } catch (error) {
    const settled = settleOutcome(spec.toolName, error, verify);
    await settle({
      outcomeStatus: settled.outcomeStatus,
      outcome: settled.outcome,
      taskStatus: HARNESS_TASK_STATUS.FAILED,
      failureCode: settled.code,
    });
    return;
  }
  const result: AgentNotionWriteResult = callResult.isError
    ? {
        saved: false,
        tool: spec.toolName,
        status: "failed",
        code: classifyNotionToolError(callResult, NOTION_ERROR.VALIDATION_FAILED),
        detail: remoteToolText(callResult).slice(0, 500),
      }
    : spec.receipt(remoteToolText(callResult), input);
  if (!result.saved && result.status === "unknown") result.verify = verify;
  await settle({
    outcomeStatus: result.saved
      ? AGENT_PROPOSAL_OUTCOME.SUCCEEDED
      : result.status === "unknown"
        ? AGENT_PROPOSAL_OUTCOME.UNCERTAIN
        : AGENT_PROPOSAL_OUTCOME.FAILED,
    outcome: result,
    taskStatus: result.saved
      ? HARNESS_TASK_STATUS.SUCCEEDED
      : HARNESS_TASK_STATUS.FAILED,
    failureCode: result.saved ? null : result.code,
  });
}

export function agentWriteLog(event: string, fields: Record<string, unknown>) {
  log.info(`[harness:agent-write] ${event}`, fields);
}

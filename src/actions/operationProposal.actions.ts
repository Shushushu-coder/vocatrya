"use server";

import prisma from "@/lib/db";
import {
  decideOperationProposal,
  getOperationProposal,
  listAttentionProposals,
  OperationProposalError,
  reproposeOperation,
  resolveUncertainProposal,
  withdrawOperationProposal,
} from "@/lib/agent/operationProposal";
import { unarchiveOwnedChatConversation } from "@/lib/agent/chatConversationStore";
import { requireUser } from "./shared";

type Result<T> =
  | { success: true; data: T }
  | { success: false; message: string; code?: string };

function fail<T>(error: unknown, fallback: string): Result<T> {
  if (error instanceof OperationProposalError) {
    return { success: false, message: error.message, code: error.code };
  }
  return { success: false, message: fallback };
}

/** One durable proposal by id / approvalId / toolCallId. */
export async function getOperationProposalAction(input: {
  proposalId?: string;
  approvalId?: string;
  toolCallId?: string;
}): Promise<Result<unknown>> {
  try {
    const user = await requireUser();
    const dto = await getOperationProposal(prisma, {
      userId: user.id,
      proposalId: input.proposalId,
      approvalId: input.approvalId,
      toolCallId: input.toolCallId,
    });
    return { success: true, data: dto };
  } catch (error) {
    return fail(error, "Failed to load the operation proposal.");
  }
}

/** Pending + needs-attention proposals for the chat panel entry. */
export async function listOperationProposalsAction(): Promise<Result<unknown[]>> {
  try {
    const user = await requireUser();
    const rows = await listAttentionProposals(prisma, user.id);
    return { success: true, data: rows };
  } catch (error) {
    return fail(error, "Failed to list operation proposals.");
  }
}

/**
 * Decide a durable proposal outside the chat HTTP round — the approval
 * lifecycle no longer depends on a live chat request. APPROVED mints the
 * harness task in the same commit.
 */
export async function decideOperationProposalAction(input: {
  proposalId: string;
  decision: "approve" | "reject";
  reason?: string;
}): Promise<Result<unknown>> {
  try {
    const user = await requireUser();
    const result = await decideOperationProposal(prisma, {
      userId: user.id,
      proposalId: input.proposalId,
      decision: input.decision,
      reason: input.reason,
    });
    if (result.state === "approved") {
      void import("@/lib/harness/runner")
        .then((m) => m.kickHarnessRunner(prisma))
        .catch(() => undefined);
    }
    const dto = await getOperationProposal(prisma, {
      userId: user.id,
      proposalId: input.proposalId,
    });
    return { success: true, data: { state: result.state, proposal: dto } };
  } catch (error) {
    return fail(error, "Failed to decide the operation proposal.");
  }
}

/** Withdraw an undecided or approved-but-undispatched proposal. */
export async function withdrawOperationProposalAction(input: {
  proposalId: string;
}): Promise<Result<unknown>> {
  try {
    const user = await requireUser();
    const result = await withdrawOperationProposal(prisma, {
      userId: user.id,
      proposalId: input.proposalId,
    });
    const dto = await getOperationProposal(prisma, {
      userId: user.id,
      proposalId: input.proposalId,
    });
    return { success: true, data: { state: result.state, proposal: dto } };
  } catch (error) {
    return fail(error, "Failed to withdraw the operation proposal.");
  }
}

/** Re-execution is always a new proposal linked to the old one's history. */
export async function reproposeOperationAction(input: {
  proposalId: string;
}): Promise<Result<unknown>> {
  try {
    const user = await requireUser();
    const { proposalId } = await reproposeOperation(prisma, {
      userId: user.id,
      proposalId: input.proposalId,
    });
    const dto = await getOperationProposal(prisma, {
      userId: user.id,
      proposalId,
    });
    return { success: true, data: { proposalId, proposal: dto } };
  } catch (error) {
    return fail(error, "Failed to re-propose the operation.");
  }
}

/** The user's own attestation after checking Notion — evidence only. */
export async function resolveUncertainProposalAction(input: {
  proposalId: string;
  resolution: "HAPPENED" | "NOT_HAPPENED" | "STILL_UNCERTAIN";
}): Promise<Result<unknown>> {
  try {
    const user = await requireUser();
    await resolveUncertainProposal(prisma, {
      userId: user.id,
      proposalId: input.proposalId,
      resolution: input.resolution,
    });
    const dto = await getOperationProposal(prisma, {
      userId: user.id,
      proposalId: input.proposalId,
    });
    return { success: true, data: dto };
  } catch (error) {
    return fail(error, "Failed to record the manual reconciliation.");
  }
}

/** Restore an archived source conversation so its proposal can be approved. */
export async function restoreProposalSourceAction(input: {
  conversationId: string;
}): Promise<Result<{ conversationId: string }>> {
  try {
    const user = await requireUser();
    await unarchiveOwnedChatConversation(user.id, input.conversationId);
    return { success: true, data: { conversationId: input.conversationId } };
  } catch (error) {
    return fail(error, "Failed to restore the source conversation.");
  }
}

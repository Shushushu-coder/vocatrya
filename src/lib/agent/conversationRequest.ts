import { decodeHistory } from "./historyCodec";
import { permissionModeOfContext } from "./preferences";
import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { isTodayPlanSuggestApprovalPart } from "./paste";
import { hasWriteReceipt, regenerateTailHasWriteReceipt } from "./writeReceipt";
import {
  createProposalsForResponseMessage,
  decideOperationProposalInTx,
  isDetachedWriteTool,
  reconcileConversationProposals,
} from "./operationProposal";

// Server-side shape check for data-file parts (AWU-FILES): the composer
// builds them from endpoint-extracted text, but admission re-verifies count
// and bounds regardless — a client can put anything in newMessage.parts.
function validFileParts(parts: UIMessage["parts"]): boolean {
  const files = parts.filter(p => p.type === "data-file");
  if (files.length > APP_CONSTANTS.AGENT_FILE_MAX_PER_MESSAGE) return false;
  const slack = 1024;
  return files.every(p => {
    const d = (p as { data?: Record<string, unknown> }).data;
    return !!d &&
      typeof d.id === "string" && d.id.length > 0 &&
      typeof d.name === "string" && d.name.length > 0 && d.name.length <= 255 &&
      typeof d.mediaType === "string" &&
      typeof d.size === "number" && d.size >= 0 &&
      typeof d.chars === "number" &&
      typeof d.truncated === "boolean" &&
      typeof d.text === "string" && d.text.length > 0 &&
      d.text.length <= APP_CONSTANTS.AGENT_FILE_MAX_EXTRACTED_CHARS + slack;
  });
}

export type ConversationErrorCode = "CONVERSATION_NOT_FOUND" | "CONVERSATION_STALE_WRITE" | "CONVERSATION_TURN_CONFLICT" | "CONVERSATION_PERSISTENCE_FAILED" | "CONVERSATION_ARCHIVED" | "CONVERSATION_ARCHIVED_CONTENT";
export class ConversationRequestError extends Error {
  constructor(readonly code: ConversationErrorCode) {
    super(code);
    this.name = "ConversationRequestError";
  }
}
export type ConversationOperation = {
  operation: "send" | "regenerate" | "approval" | "retry_step" | "reanswer";
  newMessage?: UIMessage;
  targetMessageId?: string;
  approvalId?: string;
  decision?: boolean;
  reason?: string;
  turnId?: string;
  stepIndex?: number;
  role?: "pilot" | "insight" | "reflect";
};
export type ConversationRequest = {
  operation?: ConversationOperation["operation"];
  approvalToolCallId?: string;
  userId: string;
  conversationId: string;
  requestId: string;
  revision: number;
  messages: UIMessage[];
  responseMessageId: string;
  /** All assistant message ids minted during this request (1 or 2 for compound turns). */
  responseMessageIds?: string[];
  released: boolean;
  wrote: boolean;
  failure?: ConversationRequestError;
  abort?: () => void;
  onCheckpoint?: () => void;
};

const fail = (code: ConversationErrorCode): never => { throw new ConversationRequestError(code); };
const APPROVAL_BOUND_TOOL_RECEIPTS = new Set([
  "add_job",
  "match_job",
  // The adopt-plan approval must settle under its own admitted toolCall.
  "today_plan",
  // EXT-NOTION writes execute only inside their own admitted approval.
  "notion_create_page",
  "notion_append_content",
  "notion_update_record",
  "notion_delete_pages",
]);
export function pendingApprovals(messages: UIMessage[]) {
  return messages.flatMap(message => message.parts.filter(isToolUIPart)
    .filter(part => part.state === "approval-requested").map(part => ({ message, part })));
}
/** D04/D06: pending approvals that strictly block new turns (excludes non-blocking today_plan draft cards). */
export function blockingPendingApprovals(messages: UIMessage[]) {
  return pendingApprovals(messages).filter(
    ({ part }) => !isTodayPlanSuggestApprovalPart(part),
  );
}
export { hasWriteReceipt };

export async function admitConversationRequest(input: ConversationOperation & {
  userId: string; conversationId: string; requestId: string; expectedRevision: number;
}, db: PrismaClient = prisma): Promise<ConversationRequest> {
  try {
    const result = await db.$transaction(async tx => {
      const row = await tx.chatConversation.findFirst({ where: { id: input.conversationId, userId: input.userId } });
      if (!row) return { error: "CONVERSATION_NOT_FOUND" as const };
      // Archived conversations are read-only for AI: no send/regenerate/
      // approval admission, and no request may acquire the row.
      if (row.archivedAt) return { error: "CONVERSATION_ARCHIVED" as const };
      const now = new Date();
      if (row.activeRequestId && (!row.activeRequestExpiresAt || row.activeRequestExpiresAt <= now)) {
        const cleaned = await tx.chatConversation.updateMany({
          where: { id: row.id, userId: input.userId, revision: row.revision, activeRequestId: row.activeRequestId },
          data: { revision: { increment: 1 }, activeRequestId: null, activeRequestExpiresAt: null },
        });
        if (cleaned.count !== 1) return { error: "CONVERSATION_STALE_WRITE" as const };
        // Commit cleanup even though the caller must reload its new revision.
        return { error: "CONVERSATION_STALE_WRITE" as const };
      }
      if (row.activeRequestId) return { error: "CONVERSATION_TURN_CONFLICT" as const };
      if (row.revision !== input.expectedRevision) return { error: "CONVERSATION_STALE_WRITE" as const };
      const messages = JSON.parse(decodeHistory(row.messages)) as UIMessage[];
      // Durable proposals are the authority: externally decided proposals
      // mirror into the transcript, expired ones close out, and pre-H05
      // orphan parts are marked not-continuable instead of deadlocking.
      await reconcileConversationProposals(tx, { id: row.id, userId: row.userId }, messages);
      const pending = pendingApprovals(messages);
      const blockingTranscript = blockingPendingApprovals(messages);
      // D04/D08 (H04 D3): also enforce conversation-level blocking for active
      // native/detached PROPOSED rows (messageId may be null on native MCP Slice 2),
      // while keeping today_plan suggest draft cards non-blocking.
      const blockingProposal =
        input.operation !== "approval"
          ? await tx.agentOperationProposal.findFirst({
              where: {
                userId: input.userId,
                conversationId: row.id,
                status: "PROPOSED",
                expiresAt: { gt: now },
                toolName: { not: "today_plan" },
              },
              select: { id: true },
            })
          : null;
      const hasBlockingPending =
        blockingTranscript.length > 0 || Boolean(blockingProposal);
      let approvalToolCallId: string | undefined;
      let approvedWriteTask = false;
      if (input.operation === "send") {
        if (hasBlockingPending) return { error: "CONVERSATION_TURN_CONFLICT" as const };
        const message = input.newMessage;
        if (!message || message.role !== "user" || !message.id || !Array.isArray(message.parts) || messages.some(m => m.id === message.id) ||
          message.parts.some(p => p.type !== "text" && p.type !== "data-paste" && p.type !== "data-file") ||
          !validFileParts(message.parts)) return { error: "CONVERSATION_TURN_CONFLICT" as const };
        messages.push(message);
      } else if (input.operation === "retry_step") {
        if (hasBlockingPending || !input.turnId || input.stepIndex === undefined) {
          return { error: "CONVERSATION_TURN_CONFLICT" as const };
        }
        const step = await tx.chatTurnStep.findUnique({
          where: { turnId_stepIndex: { turnId: input.turnId, stepIndex: input.stepIndex } },
          select: { userId: true, conversationId: true, status: true },
        });
        if (!step || step.userId !== input.userId || step.conversationId !== row.id || !["FAILED", "CANCELLED"].includes(step.status)) {
          return { error: "CONVERSATION_TURN_CONFLICT" as const };
        }
      } else if (input.operation === "reanswer") {
        if (hasBlockingPending || !input.targetMessageId || !input.role) {
          return { error: "CONVERSATION_TURN_CONFLICT" as const };
        }
        const target = messages.find(m => m.id === input.targetMessageId);
        if (!target || target.role !== "assistant") {
          return { error: "CONVERSATION_TURN_CONFLICT" as const };
        }
        // D05/D06: reanswer appends a new role reply while preserving existing
        // messages, writes and approvals (never deletes or replays the target).
      } else if (input.operation === "regenerate") {
        const index = messages.findIndex(m => m.id === input.targetMessageId);
        const tail = messages.at(-1);
        const stoppedTurn = tail?.role === "user" && (index < 0 || index === messages.length - 1);
        if (stoppedTurn) {
          if (hasBlockingPending) return { error: "CONVERSATION_TURN_CONFLICT" as const };
        } else {
          if (hasBlockingPending || index < 0 || index !== messages.length - 1 || messages[index].role !== "assistant" || regenerateTailHasWriteReceipt(messages))
            return { error: "CONVERSATION_TURN_CONFLICT" as const };
          const tailToolCallIds = messages[index].parts
            .filter(part => isToolUIPart(part) && isDetachedWriteTool(getToolName(part)))
            .map(part => (isToolUIPart(part) ? part.toolCallId : ""))
            .filter(Boolean);
          if (tailToolCallIds.length) {
            const committed = await tx.agentOperationProposal.findFirst({
              where: {
                conversationId: row.id,
                toolCallId: { in: tailToolCallIds },
                status: "APPROVED",
              },
            });
            if (committed) return { error: "CONVERSATION_TURN_CONFLICT" as const };
          }
          messages.splice(index);
        }
      } else {
        const proposal = pending.find(p => p.part.approval?.id === input.approvalId);
        const isDraftAdopt = proposal ? isTodayPlanSuggestApprovalPart(proposal.part) : false;
        if (
          !proposal ||
          proposal.message.role !== "assistant" ||
          (!isDraftAdopt && proposal.message.id !== messages.at(-1)?.id) ||
          typeof input.decision !== "boolean" ||
          !proposal.part.toolCallId ||
          !proposal.part.type.startsWith("tool-") ||
          proposal.part.input === undefined
        )
          return { error: "CONVERSATION_TURN_CONFLICT" as const };
        approvalToolCallId = proposal.part.toolCallId;
        // Detached writes: the proposal row takes the decision in the same
        // transaction — an approve CAS mints the harness task here, so the
        // resumed turn's tool execute can only read real persisted state.
        if (isDetachedWriteTool(getToolName(proposal.part))) {
          const decision = await decideOperationProposalInTx(tx, {
            userId: input.userId,
            toolCallId: proposal.part.toolCallId,
            decision: input.decision ? "approve" : "reject",
            reason: input.reason,
            mirrorPart: false,
          }).catch(() => null);
          if (decision?.state === "approved") approvedWriteTask = true;
          else if (decision?.state !== "rejected")
            return { error: "CONVERSATION_TURN_CONFLICT" as const };
        }
        Object.assign(proposal.part, { state: "approval-responded", approval: { id: input.approvalId, approved: input.decision, ...(input.reason ? { reason: input.reason } : {}) } });
      }
      const updated = await tx.chatConversation.updateMany({
        where: { id: row.id, userId: input.userId, revision: input.expectedRevision, activeRequestId: null },
        data: { messages: JSON.stringify(messages), revision: { increment: 1 }, activeRequestId: input.requestId, activeRequestExpiresAt: new Date(now.getTime() + 300000) },
      });
      if (updated.count !== 1) return { error: "CONVERSATION_TURN_CONFLICT" as const };
      return { request: { operation: input.operation, approvalToolCallId, userId: input.userId, conversationId: row.id, requestId: input.requestId, revision: row.revision + 1, messages, responseMessageId: "", released: false, wrote: false }, kickWrite: approvedWriteTask };
    });
    if ("error" in result) return fail(result.error!);
    if (result.kickWrite) {
      void import("@/lib/harness/runner")
        .then((m) => m.kickHarnessRunner(db))
        .catch(() => undefined);
    }
    return result.request;
  } catch (error) {
    if (error instanceof ConversationRequestError) throw error;
    // SQLite may reject a concurrent transaction before its conditional write.
    if (["P1008", "P2028", "P2034"].includes((error as { code?: string }).code ?? "")) return fail("CONVERSATION_TURN_CONFLICT");
    return fail("CONVERSATION_PERSISTENCE_FAILED");
  }
}

function ownedWhere(request: ConversationRequest) {
  return { id: request.conversationId, userId: request.userId, revision: request.revision, activeRequestId: request.requestId, activeRequestExpiresAt: { gt: new Date() }, archivedAt: null };
}
// Preserve durable terminal receipts when SDK completion contains an older part.
export function mergeDurableMessages(durable: UIMessage[], incoming: UIMessage[]): UIMessage[] {
  const merged = structuredClone(durable);
  for (const message of incoming) {
    const index = merged.findIndex(m => m.id === message.id);
    if (index < 0) { merged.push(message); continue; }
    const parts = structuredClone(message.parts);
    for (const part of merged[index].parts) {
      if (!isToolUIPart(part)) continue;
      const at = parts.findIndex(p => isToolUIPart(p) && p.toolCallId === part.toolCallId);
      if (at < 0) parts.push(part);
      else if (["output-available", "output-denied", "output-error"].includes(part.state)) parts[at] = part;
    }
    merged[index] = { ...message, parts };
  }
  return merged;
}

export async function checkpointConversationTool<T>(request: ConversationRequest, receipt: { toolName: string; toolCallId: string; input: unknown }, mutate: (tx: Prisma.TransactionClient) => Promise<T>, db: PrismaClient = prisma): Promise<T> {
  const committed = await db.$transaction(async tx => {
    // A write CAS acquires SQLite's write lock before executing business writes.
    const acquired = await tx.chatConversation.updateMany({ where: ownedWhere(request), data: { revision: { increment: 1 } } });
    if (acquired.count !== 1) return fail("CONVERSATION_STALE_WRITE");
    const row = await tx.chatConversation.findFirst({ where: { id: request.conversationId, userId: request.userId } });
    if (!row) return fail("CONVERSATION_NOT_FOUND");
    const messages = JSON.parse(decodeHistory(row.messages)) as UIMessage[];
    const previousReceipt = messages.flatMap(m => m.parts).find(p => isToolUIPart(p) && p.toolCallId === receipt.toolCallId && p.state === "output-available");
    if (previousReceipt && isToolUIPart(previousReceipt)) {
      if (previousReceipt.type !== `tool-${receipt.toolName}` || JSON.stringify(previousReceipt.input) !== JSON.stringify(receipt.input)) return fail("CONVERSATION_TURN_CONFLICT");
      return { output: previousReceipt.output as T, messages };
    }
    // Approval-gated tools bind their execution to the admitted approval's
    // own toolCall: a stale or re-proposed call id on a different turn must
    // not inherit the earlier approval.
    if (request.operation === "approval" && APPROVAL_BOUND_TOOL_RECEIPTS.has(receipt.toolName) && receipt.toolCallId !== request.approvalToolCallId) return fail("CONVERSATION_TURN_CONFLICT");
    const output = await mutate(tx);
    let message = messages.find(m => m.id === request.responseMessageId);
    if (!message) { message = { id: request.responseMessageId, role: "assistant", parts: [] }; messages.push(message); }
    const at = message.parts.findIndex(p => isToolUIPart(p) && p.toolCallId === receipt.toolCallId);
    const previous = at < 0 ? undefined : message.parts[at];
    const part = { ...previous, type: `tool-${receipt.toolName}`, toolCallId: receipt.toolCallId, input: receipt.input, state: "output-available", output } as UIMessage["parts"][number];
    if (at < 0) message.parts.push(part); else message.parts[at] = part;
    const saved = await tx.chatConversation.updateMany({ where: { ...ownedWhere(request), revision: request.revision + 1 }, data: { messages: JSON.stringify(messages) } });
    if (saved.count !== 1) return fail("CONVERSATION_STALE_WRITE");
    return { output, messages };
  }).catch(error => {
    const failure = error instanceof ConversationRequestError ? error : (typeof error?.code === "string" && error.code.startsWith("P")) ? new ConversationRequestError("CONVERSATION_PERSISTENCE_FAILED") : error;
    if (failure instanceof ConversationRequestError) { request.failure = failure; request.abort?.(); }
    throw failure;
  });
  request.revision += 1;
  request.messages = committed.messages;
  request.wrote = true;
  request.onCheckpoint?.();
  return committed.output;
}

export async function finishConversationRequest(request: ConversationRequest, incoming: UIMessage[], db: PrismaClient = prisma) {
  if (request.failure) throw request.failure;
  if (request.released) return fail("CONVERSATION_STALE_WRITE");
  const messages = await db.$transaction(async tx => {
    const row = await tx.chatConversation.findFirst({ where: ownedWhere(request) });
    if (!row) return fail("CONVERSATION_STALE_WRITE");
    const finalMessages = mergeDurableMessages(JSON.parse(decodeHistory(row.messages)) as UIMessage[], incoming);
    // Persist a durable proposal for every detached-write approval part the
    // finished turn produced — the proposal outlives this HTTP round. Only
    // the response message mints rows; older proposal-less parts are
    // orphans for reconcile, never re-armed.
    const responseIds = new Set<string>([
      ...(request.responseMessageIds ?? []),
      ...(request.responseMessageId ? [request.responseMessageId] : []),
    ]);
    const turnKey = [...finalMessages].reverse().find(m => m.role === "user")?.id ?? "";
    for (const msgId of responseIds) {
      const responseMessage = finalMessages.find(m => m.id === msgId);
      if (!responseMessage) continue;
      await createProposalsForResponseMessage(tx, {
        userId: request.userId,
        conversationId: request.conversationId,
        turnKey,
        message: responseMessage,
      });
      // Full access is a persisted creation-time user choice, never a model
      // argument or a preference changed while this request was executing.
      if (permissionModeOfContext(row.context) === "full") {
        for (const part of responseMessage.parts) {
          if (!isToolUIPart(part) || part.state !== "approval-requested") continue;
          const proposal = await tx.agentOperationProposal.findFirst({ where: {
            userId: request.userId, conversationId: row.id,
            messageId: responseMessage.id, toolCallId: part.toolCallId, status: "PROPOSED",
          } });
          if (proposal) {
            const decision = await decideOperationProposalInTx(tx, {
              userId: request.userId, proposalId: proposal.id, decision: "approve",
              reason: "FULL_ACCESS_PREAUTHORIZED", mirrorPart: false,
            });
            if (decision.state === "approved") {
              Object.assign(part, { state: "output-available", output: {
                saved: false, tool: proposal.toolName, status: "queued", code: "QUEUED",
                proposalId: proposal.id, taskId: decision.taskId, taskStatus: "QUEUED",
              } });
            }
          }
        }
      }
    }
    await reconcileConversationProposals(tx, { id: row.id, userId: row.userId }, finalMessages);
    const saved = await tx.chatConversation.updateMany({ where: ownedWhere(request), data: { messages: JSON.stringify(finalMessages), revision: { increment: 1 }, activeRequestId: null, activeRequestExpiresAt: null,
      ...(row.executionPath === "NATIVE_CODEX_V1" ? { nativeInitializationState: "READY" } : {}),
    } });
    if (saved.count !== 1) return fail("CONVERSATION_STALE_WRITE");
    return finalMessages;
  });
  request.revision += 1;
  request.messages = messages;
  request.released = true;
  return request.revision;
}

export async function cancelConversationRequest(userId: string, conversationId: string, requestId: string, db: PrismaClient = prisma) {
  return db.$transaction(async tx => {
    const row = await tx.chatConversation.findFirst({
      where: { id: conversationId, userId, activeRequestId: requestId },
      select: { id: true, executionPath: true, nativeInitializationState: true },
    });
    if (!row) return false;
    // If a native conversation already has a persisted thread binding, a
    // failed/aborted subsequent turn must return the row to READY so the next
    // user message can resume that thread. An unbound first turn stays
    // IN_FLIGHT (fail-closed) so unknown thread/start outcomes never silently
    // create a duplicate thread.
    let resetNativeReady = false;
    if (row.executionPath === "NATIVE_CODEX_V1" && row.nativeInitializationState === "IN_FLIGHT") {
      const binding = await tx.nativeConversationBinding.findFirst({
        where: { conversationId, userId },
        select: { id: true },
      });
      resetNativeReady = Boolean(binding);
    }
    // D08: also recover any per-role native bindings whose turn was aborted
    // once a threadId was already persisted.
    await tx.nativeConversationBinding.updateMany({
      where: { conversationId, userId, initializationState: "IN_FLIGHT" },
      data: { initializationState: "READY" },
    });
    const saved = await tx.chatConversation.updateMany({
      where: { id: conversationId, userId, activeRequestId: requestId },
      data: {
        revision: { increment: 1 },
        activeRequestId: null,
        activeRequestExpiresAt: null,
        ...(resetNativeReady ? { nativeInitializationState: "READY" } : {}),
      },
    });
    return saved.count === 1;
  });
}

import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { isToolUIPart, type UIMessage } from "ai";
import prisma from "@/lib/db";
import { hasWriteReceipt, regenerateTailHasWriteReceipt } from "./writeReceipt";

export type ConversationErrorCode = "CONVERSATION_NOT_FOUND" | "CONVERSATION_STALE_WRITE" | "CONVERSATION_TURN_CONFLICT" | "CONVERSATION_PERSISTENCE_FAILED" | "CONVERSATION_ARCHIVED" | "CONVERSATION_ARCHIVED_CONTENT";
export class ConversationRequestError extends Error {
  constructor(readonly code: ConversationErrorCode) {
    super(code);
    this.name = "ConversationRequestError";
  }
}
export type ConversationOperation = {
  operation: "send" | "regenerate" | "approval";
  newMessage?: UIMessage;
  targetMessageId?: string;
  approvalId?: string;
  decision?: boolean;
  reason?: string;
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
  released: boolean;
  wrote: boolean;
  failure?: ConversationRequestError;
  abort?: () => void;
  onCheckpoint?: () => void;
};

const fail = (code: ConversationErrorCode): never => { throw new ConversationRequestError(code); };
const APPROVAL_BOUND_TOOL_RECEIPTS = new Set(["add_job", "match_job"]);
export function pendingApprovals(messages: UIMessage[]) {
  return messages.flatMap(message => message.parts.filter(isToolUIPart)
    .filter(part => part.state === "approval-requested").map(part => ({ message, part })));
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
      const messages = JSON.parse(row.messages) as UIMessage[];
      const pending = pendingApprovals(messages);
      let approvalToolCallId: string | undefined;
      if (input.operation === "send") {
        if (pending.length) return { error: "CONVERSATION_TURN_CONFLICT" as const };
        const message = input.newMessage;
        if (!message || message.role !== "user" || !message.id || !Array.isArray(message.parts) || messages.some(m => m.id === message.id) ||
          message.parts.some(p => p.type !== "text" && p.type !== "data-paste")) return { error: "CONVERSATION_TURN_CONFLICT" as const };
        messages.push(message);
      } else if (input.operation === "regenerate") {
        const index = messages.findIndex(m => m.id === input.targetMessageId);
        if (pending.length || index < 0 || index !== messages.length - 1 || messages[index].role !== "assistant" || regenerateTailHasWriteReceipt(messages))
          return { error: "CONVERSATION_TURN_CONFLICT" as const };
        messages.splice(index);
      } else {
        const proposal = pending.find(p => p.part.approval?.id === input.approvalId);
        if (!proposal || proposal.message.role !== "assistant" || proposal.message.id !== messages.at(-1)?.id || typeof input.decision !== "boolean" || !proposal.part.toolCallId || !proposal.part.type.startsWith("tool-") || proposal.part.input === undefined)
          return { error: "CONVERSATION_TURN_CONFLICT" as const };
        approvalToolCallId = proposal.part.toolCallId;
        Object.assign(proposal.part, { state: "approval-responded", approval: { id: input.approvalId, approved: input.decision, ...(input.reason ? { reason: input.reason } : {}) } });
      }
      const updated = await tx.chatConversation.updateMany({
        where: { id: row.id, userId: input.userId, revision: input.expectedRevision, activeRequestId: null },
        data: { messages: JSON.stringify(messages), revision: { increment: 1 }, activeRequestId: input.requestId, activeRequestExpiresAt: new Date(now.getTime() + 300000) },
      });
      if (updated.count !== 1) return { error: "CONVERSATION_TURN_CONFLICT" as const };
      return { request: { operation: input.operation, approvalToolCallId, userId: input.userId, conversationId: row.id, requestId: input.requestId, revision: row.revision + 1, messages, responseMessageId: "", released: false, wrote: false } };
    });
    if ("error" in result) return fail(result.error!);
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
    const messages = JSON.parse(row.messages) as UIMessage[];
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
    const finalMessages = mergeDurableMessages(JSON.parse(row.messages) as UIMessage[], incoming);
    const saved = await tx.chatConversation.updateMany({ where: ownedWhere(request), data: { messages: JSON.stringify(finalMessages), revision: { increment: 1 }, activeRequestId: null, activeRequestExpiresAt: null } });
    if (saved.count !== 1) return fail("CONVERSATION_STALE_WRITE");
    return finalMessages;
  });
  request.revision += 1;
  request.messages = messages;
  request.released = true;
  return request.revision;
}

export async function cancelConversationRequest(userId: string, conversationId: string, requestId: string, db: PrismaClient = prisma) {
  const saved = await db.chatConversation.updateMany({ where: { id: conversationId, userId, activeRequestId: requestId }, data: { revision: { increment: 1 }, activeRequestId: null, activeRequestExpiresAt: null } });
  return saved.count === 1;
}

import "server-only";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { AIBusinessError, classifyAIConnection } from "@/lib/ai/connections";
import { mintConnectionTicket } from "@/lib/ai/connection-tickets";
import { fetchAccountRuntimeState } from "@/lib/ai/streaming-execution";
import type { ConversationRequest } from "./conversationRequest";

export const NATIVE_PATH = "NATIVE_CODEX_V1";
export const APP_PATH = "APP_ORCHESTRATED";
const unavailable = () => new AIBusinessError("NATIVE_SESSION_UNAVAILABLE", "Native session is not available for this connection, model or runtime version");
const lost = () => new AIBusinessError("NATIVE_CONTEXT_LOST", "Native context was not restored. No message was resent. Explicitly restart native context to continue.");

export async function nativeReadiness(userId: string, connectionId: string, model: string, db = prisma) {
  const connection = await db.aIConnection.findFirst({ where: { id: connectionId, userId } });
  if (!connection || connection.archivedAt || connection.status !== "CONNECTED" || connection.backendKind !== "CODEX_RUNTIME" || connection.authType !== "ACCOUNT_LOGIN" || classifyAIConnection(connection) !== "ACCOUNT_LOGIN" || !connection.runtimeProfileRef) throw unavailable();
  const state = await fetchAccountRuntimeState({ backendKind: connection.backendKind, accountProvider: connection.provider });
  const capability = state.nativeSession;
  if (!state.runtimeReady || !capability?.ready || !capability.models.includes(model) || state.runtimeVersion !== capability.version) throw unavailable();
  return { connection, runtimeVersion: capability.version, configHash: capability.configHash };
}

// Ownership includes the active request lease. A late stream cannot recreate
// a deleted/archived conversation or write after another request takes over.
function lease(request: ConversationRequest) {
  return { id: request.conversationId, userId: request.userId, executionPath: NATIVE_PATH,
    archivedAt: null, activeRequestId: request.requestId, activeRequestExpiresAt: { gt: new Date() } };
}

export async function beginNativeTurn(request: ConversationRequest, db: PrismaClient = prisma) {
  return db.$transaction(async tx => {
    const row = await tx.chatConversation.findFirst({ where: lease(request) });
    if (!row) throw lost();
    if (row.nativeInitializationState === "IN_FLIGHT") throw lost();
    const binding = await tx.nativeConversationBinding.findUnique({ where: { conversationId: request.conversationId } });
    if (binding) {
      if (binding.userId !== request.userId || binding.connectionId !== row.resolvedConnectionId || binding.model !== row.resolvedModel) throw lost();
      await tx.chatConversation.updateMany({ where: lease(request), data: { nativeInitializationState: "IN_FLIGHT", updatedAt: row.updatedAt } });
      return binding;
    }
    if (row.nativeInitializationState !== "NEVER_ATTEMPTED") throw lost();
    const result = await tx.chatConversation.updateMany({ where: { ...lease(request), nativeInitializationState: "NEVER_ATTEMPTED" }, data: { nativeInitializationState: "IN_FLIGHT", updatedAt: row.updatedAt } });
    if (result.count !== 1) throw lost();
    return null;
  });
}

type SessionEvent = { type: "native-session"; threadId: string; resumed: boolean; runtimeVersion: string; runtimeProfileRef: string; configHash: string };
export async function saveNativeBinding(request: ConversationRequest, event: SessionEvent, input: { connectionId: string; model: string; promptHash: string }, db: PrismaClient = prisma) {
  await db.$transaction(async tx => {
    const row = await tx.chatConversation.findFirst({ where: lease(request) });
    if (!row || row.resolvedConnectionId !== input.connectionId || row.resolvedModel !== input.model) throw lost();
    const data = { userId: request.userId, connectionId: input.connectionId, model: input.model, threadId: event.threadId,
      runtimeVersion: event.runtimeVersion, runtimeProfileRef: event.runtimeProfileRef, configHash: event.configHash, promptHash: input.promptHash };
    const previous = await tx.nativeConversationBinding.findUnique({ where: { conversationId: request.conversationId } });
    if (previous && previous.threadId !== event.threadId) throw lost();
    await tx.nativeConversationBinding.upsert({ where: { conversationId: request.conversationId }, create: { conversationId: request.conversationId, ...data }, update: data });
  });
}

export async function restartNativeContext(userId: string, conversationId: string, db: PrismaClient = prisma) {
  await db.$transaction(async tx => {
    const row = await tx.chatConversation.findFirst({ where: { id: conversationId, userId, archivedAt: null, executionPath: NATIVE_PATH } });
    if (!row || (row.activeRequestId && (!row.activeRequestExpiresAt || row.activeRequestExpiresAt > new Date()))) throw lost();
    const changed = await tx.chatConversation.updateMany({ where: { id: conversationId, userId, archivedAt: null, executionPath: NATIVE_PATH, activeRequestId: row.activeRequestId, revision: row.revision },
      data: { activeRequestId: null, activeRequestExpiresAt: null, nativeInitializationState: "NEVER_ATTEMPTED", revision: { increment: 1 } } });
    if (changed.count !== 1) throw lost();
    await tx.nativeConversationBinding.deleteMany({ where: { conversationId, userId } });
  });
}

type NativeTextEvent = { type: "text-delta"; delta: string } | { type: "completed"; text: string } | SessionEvent;
export async function* executeNativeTurn(input: { request: ConversationRequest; connectionId: string; model: string; prompt: string; instructions: string; signal: AbortSignal }): AsyncGenerator<NativeTextEvent> {
  const { request, connectionId, model, prompt, instructions, signal } = input;
  const readiness = await nativeReadiness(request.userId, connectionId, model);
  const base = process.env.VOCATRYA_DESKTOP_EXEC_URL;
  const token = process.env.VOCATRYA_DESKTOP_INTERNAL_TOKEN;
  if (!base || !token) throw unavailable();
  const binding = await beginNativeTurn(request);
  if (binding && (binding.runtimeVersion !== readiness.runtimeVersion || binding.configHash !== readiness.configHash || binding.runtimeProfileRef !== readiness.connection.runtimeProfileRef)) throw lost();
  const promptHash = createHash("sha256").update(instructions).digest("hex");
  // 0.169.0 accepts a resume override but the real wire retains the old
  // developer instructions. Require explicit replacement instead of lying
  // about immediate preference updates or silently dropping native history.
  if (binding && binding.promptHash !== promptHash) throw lost();
  const ticket = mintConnectionTicket({ userId: request.userId, operation: "executeText", backendKind: "CODEX_RUNTIME", connectionId });
  const response = await fetch(`${base}/internal/ai-connections/native-session-stream`, { method: "POST", signal,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ ticket: ticket.ticket, connectionId, model, prompt, instructions, permissionScope: "NATIVE_SESSION_V1",
      nativeSession: { conversationId: request.conversationId, threadId: binding?.threadId ?? null,
        ...(binding ? { runtimeVersion: binding.runtimeVersion, runtimeProfileRef: binding.runtimeProfileRef, configHash: binding.configHash } : {}) } }),
  });
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let sawSession = false;
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      if (pending.length > 512 * 1024) throw lost();
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.type === "error") {
          if (event.code === "REAUTH_REQUIRED") throw new AIBusinessError("REAUTH_REQUIRED", "Sign in again");
          if (["NATIVE_RESUME_FAILED", "NATIVE_IDENTITY_MISMATCH"].includes(event.code)) throw lost();
          throw unavailable();
        }
        if (event.type === "native-session") {
          if (sawSession || typeof event.threadId !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(event.threadId) || event.runtimeVersion !== readiness.runtimeVersion ||
            event.runtimeProfileRef !== readiness.connection.runtimeProfileRef || event.configHash !== readiness.configHash || (binding && event.threadId !== binding.threadId)) throw lost();
          await saveNativeBinding(request, event, { connectionId, model, promptHash });
          sawSession = true;
          yield event;
        } else if (event.type === "text-delta" && sawSession && typeof event.delta === "string") yield event;
        else if (event.type === "completed" && sawSession && typeof event.text === "string") { yield event; return; }
        else throw lost();
      }
    }
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    throw lost();
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

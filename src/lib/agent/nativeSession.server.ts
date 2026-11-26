import "server-only";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { AIBusinessError, classifyAIConnection } from "@/lib/ai/connections";
import { mintConnectionTicket } from "@/lib/ai/connection-tickets";
import { fetchAccountRuntimeState, type AccountRuntimeState } from "@/lib/ai/streaming-execution";
import type { ConversationRequest } from "./conversationRequest";
import type {
  AgentNativeSearchActionType,
  AgentNativeSearchSource,
} from "@/models/agent.model";
import type {
  ExplicitModelSelection,
  NativeChatEntry,
  NativeUnavailableDetails,
} from "./chatTypes";
import {
  isNativeBusinessWriteTool,
  mintNativeBusinessTicket,
  revokeNativeBusinessTicket,
  NATIVE_BUSINESS_MCP_TOKEN_ENV,
  NATIVE_BUSINESS_TOOLS_MAX,
} from "./nativeBusinessMcp.server";
import type { PermissionMode } from "./preferences";

export const NATIVE_PATH = "NATIVE_CODEX_V1";
export const APP_PATH = "APP_ORCHESTRATED";

const unavailable = (details?: NativeUnavailableDetails) => new AIBusinessError("NATIVE_SESSION_UNAVAILABLE", "Native session is not available for this connection, model or runtime version", undefined, details);
const lost = () => new AIBusinessError("NATIVE_CONTEXT_LOST", "Native context was not restored. No message was resent. Explicitly restart native context to continue.");

// Native sessions accept any Codex CLI meeting the minimum baseline version
// (default 0.165.0) while relying on the runtime's startup `config/read`
// boundary check and fail-closed tool enforcement.
const DEFAULT_NATIVE_MIN_VERSION = "0.165.0";
const STRICT_SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isSemverAtLeast(version: string | null | undefined, minVersion: string): boolean {
  if (typeof version !== "string") return false;
  const a = STRICT_SEMVER_RE.exec(version);
  const b = STRICT_SEMVER_RE.exec(minVersion);
  if (!a || !b) return false;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(a[i]) - Number(b[i]);
    if (diff !== 0) return diff > 0;
  }
  return true;
}

function runtimeVerified(state: AccountRuntimeState, capability: NonNullable<AccountRuntimeState["nativeSession"]>) {
  return isSemverAtLeast(state.runtimeVersion, capability.minVersion ?? DEFAULT_NATIVE_MIN_VERSION);
}

// The native session may run a different binary than streaming/exec (each is
// selected per purpose): judge native readiness by the native binary's version.
function nativeView(state: AccountRuntimeState): AccountRuntimeState {
  const native = state.nativeSession;
  return native && native.runtimeVersion !== undefined ? { ...state, runtimeVersion: native.runtimeVersion } : state;
}

// Structured gate — every rejected caller learns WHICH condition failed,
// with the expected/actual values, so the UI can give actionable guidance
// instead of an opaque "unavailable".
export async function nativeReadinessReport(
  userId: string,
  connectionId: string,
  model: string,
  db = prisma,
): Promise<
  | { ok: true; connection: Awaited<ReturnType<typeof prisma.aIConnection.findFirst>>; runtimeVersion: string; configHash: string }
  | { ok: false; details: NativeUnavailableDetails }
> {
  const reject = (details: NativeUnavailableDetails) => ({ ok: false as const, details });
  const connection = await db.aIConnection.findFirst({ where: { id: connectionId, userId } });
  if (!connection || connection.archivedAt || connection.status !== "CONNECTED" || connection.backendKind !== "CODEX_RUNTIME" || connection.authType !== "ACCOUNT_LOGIN" || classifyAIConnection(connection) !== "ACCOUNT_LOGIN" || !connection.runtimeProfileRef) {
    return reject({ reason: "CONNECTION_INELIGIBLE", runtimeVersion: null, requiredVersion: null, model, models: null });
  }
  const state = nativeView(await fetchAccountRuntimeState({ backendKind: connection.backendKind, accountProvider: connection.provider }));
  const capability = state.nativeSession;
  if (!state.runtimeReady) {
    return reject({ reason: "RUNTIME_NOT_READY", runtimeVersion: state.runtimeVersion ?? null, requiredVersion: capability?.version ?? null, model, models: capability?.models ?? null });
  }
  if (!capability?.ready || !runtimeVerified(state, capability)) {
    return reject({ reason: "RUNTIME_VERSION_MISMATCH", runtimeVersion: state.runtimeVersion ?? null, requiredVersion: capability?.version ?? null, model, models: capability?.models ?? null, verifiedVersions: capability?.verifiedVersions ?? null });
  }
  if (!capability.models.includes(model)) {
    return reject({ reason: "MODEL_UNSUPPORTED", runtimeVersion: state.runtimeVersion ?? null, requiredVersion: capability.version, model, models: capability.models });
  }
  return { ok: true, connection, runtimeVersion: state.runtimeVersion!, configHash: capability.configHash };
}

export async function nativeReadiness(userId: string, connectionId: string, model: string, db = prisma) {
  const report = await nativeReadinessReport(userId, connectionId, model, db);
  if (!report.ok) throw unavailable(report.details);
  return { connection: report.connection!, runtimeVersion: report.runtimeVersion, configHash: report.configHash };
}

/**
 * Resolves the Codex pair a NEW native conversation would lock to. The native
 * entry must NOT reuse the generic chat lock — when the default assignment is
 * another provider that lock is never a Codex connection and creation can only
 * fail. Instead this picks the user's connected Codex account itself (the
 * draft's pick wins when it is a usable Codex connection), probes the same
 * gates nativeReadiness checks, and reports WHICH condition fails so the
 * picker can grey the entry with a reason instead of erroring on click.
 * Creation still re-validates through nativeReadiness inside
 * createChatConversationRecord.
 */
export async function resolveNativeChatEntry(
  userId: string,
  preferred?: ExplicitModelSelection | null,
  db = prisma,
): Promise<NativeChatEntry> {
  const connections = await db.aIConnection.findMany({
    where: {
      userId,
      backendKind: "CODEX_RUNTIME",
      authType: "ACCOUNT_LOGIN",
      archivedAt: null,
      status: "CONNECTED",
    },
    orderBy: { updatedAt: "desc" },
  });
  const usable = connections.filter(
    (c) => classifyAIConnection(c) === "ACCOUNT_LOGIN" && c.runtimeProfileRef,
  );
  const connection =
    (preferred?.connectionId
      ? usable.find((c) => c.id === preferred.connectionId)
      : undefined) ?? usable[0];
  const ineligible = { reason: "CONNECTION_INELIGIBLE", runtimeVersion: null, requiredVersion: null, model: null, models: null } as const;
  if (!connection) return { ok: false, details: ineligible };
  let state: AccountRuntimeState;
  try {
    state = nativeView(await fetchAccountRuntimeState({
      backendKind: connection.backendKind,
      accountProvider: connection.provider,
    }));
  } catch {
    // The runtime-state channel is unreachable (no desktop, backend down):
    // the honest verdict is NOT_READY, not a generic failure banner.
    return { ok: false, details: { ...ineligible, reason: "RUNTIME_NOT_READY" } };
  }
  const capability = state.nativeSession;
  if (!state.runtimeReady) {
    return { ok: false, details: { reason: "RUNTIME_NOT_READY", runtimeVersion: state.runtimeVersion ?? null, requiredVersion: capability?.version ?? null, model: null, models: capability?.models ?? null } };
  }
  if (!capability?.ready || !runtimeVerified(state, capability)) {
    return { ok: false, details: { reason: "RUNTIME_VERSION_MISMATCH", runtimeVersion: state.runtimeVersion ?? null, requiredVersion: capability?.version ?? null, model: null, models: capability?.models ?? null, verifiedVersions: capability?.verifiedVersions ?? null } };
  }
  const model =
    preferred?.model && capability.models.includes(preferred.model)
      ? preferred.model
      : capability.models[0];
  if (!model) {
    return { ok: false, details: { reason: "MODEL_UNSUPPORTED", runtimeVersion: state.runtimeVersion ?? null, requiredVersion: capability.version, model: preferred?.model ?? null, models: capability.models } };
  }
  return { ok: true, connectionId: connection.id, model, displayName: connection.displayName };
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
export type NativeSessionSearchPayload = {
  status: "started" | "completed";
  actionType: AgentNativeSearchActionType;
  query: string;
  queries: string[];
  pattern?: string;
  sources: AgentNativeSearchSource[];
};
export type NativeSessionToolPayload = {
  tool: string;
  status: "running" | "completed" | "failed" | "approval_required" | "queued";
  argumentsSummary?: string;
  resultSummary?: string;
  proposalId?: string;
  approvalId?: string;
  taskId?: string;
  expiresAt?: string;
};
export type NativeSessionNeutralEvent = {
  type: "native-event";
  version: 1;
  kind: "search" | "tool_call" | "tool_result";
  conversationId: string;
  nativeSessionId: string;
  nativeTurnId: string | null;
  itemId: string;
  occurredAt: string;
  payload: NativeSessionSearchPayload | NativeSessionToolPayload;
};

const VALID_SEARCH_ACTIONS = new Set<AgentNativeSearchActionType>(["search", "open_page", "find_in_page", "other"]);

function boundedString(value: unknown, maxChars: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > maxChars ? trimmed.slice(0, maxChars) : trimmed;
}

function sanitizeHttpSourceUrl(value: unknown): { url: string; host?: string } | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return { url: parsed.href, ...(parsed.hostname ? { host: parsed.hostname } : {}) };
  } catch {
    return null;
  }
}

export function normalizeNativeSearchEvent(
  raw: unknown,
  expected: { conversationId: string; nativeSessionId: string },
): NativeSessionNeutralEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  if (event.type !== "native-event" || event.version !== 1 || event.kind !== "search") return null;
  if (event.nativeSessionId !== expected.nativeSessionId) return null;
  const nativeTurnId =
    event.nativeTurnId === null || event.nativeTurnId === undefined
      ? null
      : typeof event.nativeTurnId === "string" && event.nativeTurnId.length <= 256
        ? event.nativeTurnId
        : undefined;
  if (nativeTurnId === undefined) return null;
  const itemId = boundedString(event.itemId, 256);
  if (!itemId) return null;
  const occurredAt = boundedString(event.occurredAt, 64) ?? new Date().toISOString();
  const rawPayload = event.payload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const p = rawPayload as Record<string, unknown>;
  if (p.status !== "started" && p.status !== "completed") return null;
  if (typeof p.actionType !== "string" || !VALID_SEARCH_ACTIONS.has(p.actionType as AgentNativeSearchActionType)) return null;
  const actionType = p.actionType as AgentNativeSearchActionType;
  const query = boundedString(p.query, 300) ?? "";
  const queries: string[] = [];
  const seenQueries = new Set<string>();
  if (Array.isArray(p.queries)) {
    for (const q of p.queries) {
      const clipped = boundedString(q, 300);
      if (!clipped || seenQueries.has(clipped) || queries.length >= 12) continue;
      seenQueries.add(clipped);
      queries.push(clipped);
    }
  }
  const pattern = boundedString(p.pattern, 200) ?? undefined;
  const sources: AgentNativeSearchSource[] = [];
  const seenUrls = new Set<string>();
  if (Array.isArray(p.sources)) {
    for (const entry of p.sources) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
      const item = entry as Record<string, unknown>;
      const safe = sanitizeHttpSourceUrl(item.url);
      if (!safe || seenUrls.has(safe.url) || sources.length >= 20) continue;
      seenUrls.add(safe.url);
      const title = boundedString(item.title, 200) ?? undefined;
      sources.push({
        url: safe.url,
        ...(safe.host ? { host: safe.host } : {}),
        ...(title ? { title } : {}),
      });
    }
  }
  return {
    type: "native-event",
    version: 1,
    kind: "search",
    conversationId: expected.conversationId,
    nativeSessionId: expected.nativeSessionId,
    nativeTurnId,
    itemId,
    occurredAt,
    payload: {
      status: p.status,
      actionType,
      query,
      queries,
      ...(pattern ? { pattern } : {}),
      sources,
    },
  };
}

export function normalizeNativeToolEvent(
  raw: unknown,
  expected: {
    conversationId: string;
    nativeSessionId: string;
    allowedTools: readonly string[];
    /** Proposal IDs genuinely minted during this turn — prevents untrusted tool text from spoofing approval cards. */
    mintedProposalIds?: ReadonlySet<string>;
  },
): NativeSessionNeutralEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = raw as Record<string, unknown>;
  if (event.type !== "native-event" || event.version !== 1 || (event.kind !== "tool_call" && event.kind !== "tool_result")) return null;
  if (event.nativeSessionId !== expected.nativeSessionId) return null;
  const nativeTurnId =
    event.nativeTurnId === null || event.nativeTurnId === undefined
      ? null
      : typeof event.nativeTurnId === "string" && event.nativeTurnId.length <= 256
        ? event.nativeTurnId
        : undefined;
  if (nativeTurnId === undefined) return null;
  const itemId = boundedString(event.itemId, 256);
  if (!itemId) return null;
  const occurredAt = boundedString(event.occurredAt, 64) ?? new Date().toISOString();
  const rawPayload = event.payload;
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) return null;
  const p = rawPayload as Record<string, unknown>;
  const tool = boundedString(p.tool, 64);
  if (!tool || !expected.allowedTools.includes(tool)) return null;
  if (p.status !== "running" && p.status !== "completed" && p.status !== "failed") return null;
  const argumentsSummary = boundedString(p.argumentsSummary, 2100) ?? undefined;
  const resultSummary = boundedString(p.resultSummary, 2100) ?? undefined;

  let status: NativeSessionToolPayload["status"] = p.status;
  let proposalId: string | undefined;
  let approvalId: string | undefined;
  let taskId: string | undefined;
  let expiresAt: string | undefined;

  if (
    event.kind === "tool_result" &&
    p.status === "completed" &&
    resultSummary &&
    isNativeBusinessWriteTool(tool)
  ) {
    try {
      const parsed = JSON.parse(resultSummary) as Record<string, unknown>;
      const candidateProposalId = boundedString(parsed?.proposalId, 128);
      const mintedOk =
        candidateProposalId !== null &&
        (expected.mintedProposalIds === undefined ||
          expected.mintedProposalIds.has(candidateProposalId));
      if (
        mintedOk &&
        parsed?.saved === false &&
        parsed?.tool === tool &&
        (parsed?.status === "approval_required" || parsed?.status === "queued")
      ) {
        status = parsed.status;
        proposalId = candidateProposalId;
        approvalId = boundedString(parsed.approvalId, 128) ?? undefined;
        taskId = boundedString(parsed.taskId, 128) ?? undefined;
        expiresAt = boundedString(parsed.expiresAt, 64) ?? undefined;
      }
    } catch {
      // Plain text or truncated output — stays as regular tool_result.
    }
  }

  return {
    type: "native-event",
    version: 1,
    kind: event.kind,
    conversationId: expected.conversationId,
    nativeSessionId: expected.nativeSessionId,
    nativeTurnId,
    itemId,
    occurredAt,
    payload: {
      tool,
      status,
      ...(argumentsSummary ? { argumentsSummary } : {}),
      ...(resultSummary ? { resultSummary } : {}),
      ...(proposalId ? { proposalId } : {}),
      ...(approvalId ? { approvalId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(expiresAt ? { expiresAt } : {}),
    },
  };
}

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

type NativeTextEvent =
  | { type: "text-delta"; delta: string }
  | { type: "completed"; text: string }
  | SessionEvent
  | NativeSessionNeutralEvent;
// Loopback check on the backend's own origin before a bearer ticket is ever
// attached to an MCP endpoint URL. Codex connects over streamable_http from
// the same host; anything else would carry the ticket off-box.
function loopbackOrigin(value: string | undefined): string | null {
  if (typeof value !== "string" || value.length > 256) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:") return null;
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export async function* executeNativeTurn(input: {
  request: ConversationRequest;
  connectionId: string;
  model: string;
  prompt: string;
  instructions: string;
  signal: AbortSignal;
  origin?: string;
  allowedBusinessTools?: readonly string[];
  permissionMode?: PermissionMode;
  agentRole?: string | null;
  turnKey?: string;
  freshNativeFull?: boolean;
  canonicalJobs?: boolean;
  pageJobId?: string | null;
  pageResumeId?: string | null;
  taskExtraTools?: readonly string[] | null;
}): AsyncGenerator<NativeTextEvent> {
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
  // Per-turn business bridge: the ticket binds this exact request and is
  // revoked in the finally below — end, error and cancel all invalidate it.
  const allowedTools = [...(input.allowedBusinessTools ?? [])].slice(0, NATIVE_BUSINESS_TOOLS_MAX);
  const origin = loopbackOrigin(input.origin);
  if (!origin || allowedTools.length === 0) throw unavailable();
  const businessTicket = mintNativeBusinessTicket({
    userId: request.userId,
    conversationId: request.conversationId,
    requestId: request.requestId,
    allowedTools,
    permissionMode: input.permissionMode,
    agentRole: input.agentRole,
    turnKey: input.turnKey,
    freshNativeFull: input.freshNativeFull,
    canonicalJobs: input.canonicalJobs,
    connectionId,
    model,
    provider: readiness.connection.provider,
    pageJobId: input.pageJobId,
    pageResumeId: input.pageResumeId,
    taskExtraTools: input.taskExtraTools,
  });
  const ticket = mintConnectionTicket({ userId: request.userId, operation: "executeText", backendKind: "CODEX_RUNTIME", connectionId });
  let response: Response;
  try {
    response = await fetch(`${base}/internal/ai-connections/native-session-stream`, { method: "POST", signal,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ ticket: ticket.ticket, connectionId, model, prompt, instructions, permissionScope: "NATIVE_SESSION_V1",
        nativeSession: { conversationId: request.conversationId, threadId: binding?.threadId ?? null,
          ...(binding ? { runtimeVersion: binding.runtimeVersion, runtimeProfileRef: binding.runtimeProfileRef, configHash: binding.configHash } : {}) },
        nativeBusinessMcp: {
          url: `${origin}/api/internal/native-business-mcp`,
          bearerTokenEnvVar: NATIVE_BUSINESS_MCP_TOKEN_ENV,
          token: businessTicket.token,
          allowedTools: businessTicket.allowedTools,
        } }),
    });
  } catch (error) {
    revokeNativeBusinessTicket(businessTicket.token);
    throw error;
  }
  if (!response.ok || !response.body) {
    revokeNativeBusinessTicket(businessTicket.token);
    throw unavailable();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let sawSession = false;
  let currentThreadId: string | null = binding?.threadId ?? null;
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
          currentThreadId = event.threadId;
          sawSession = true;
          yield event;
        } else if (event.type === "native-event" && sawSession && currentThreadId) {
          const normalized = event.kind === "search"
            ? normalizeNativeSearchEvent(event, {
                conversationId: request.conversationId,
                nativeSessionId: currentThreadId,
              })
            : normalizeNativeToolEvent(event, {
                conversationId: request.conversationId,
                nativeSessionId: currentThreadId,
                allowedTools: businessTicket.allowedTools,
                mintedProposalIds: businessTicket.mintedProposalIds,
              });
          if (!normalized) throw lost();
          yield normalized;
        } else if (event.type === "text-delta" && sawSession && typeof event.delta === "string") yield event;
        else if (event.type === "completed" && sawSession && typeof event.text === "string") { yield event; return; }
        else throw lost();
      }
    }
    if (signal.aborted) throw new DOMException("Stopped", "AbortError");
    throw lost();
  } finally {
    revokeNativeBusinessTicket(businessTicket.token);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

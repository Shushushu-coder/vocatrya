"use server";
import { nativeReadiness, resolveNativeChatEntry, restartNativeContext } from "@/lib/agent/nativeSession.server";

import { effectiveAgentToolNames, agentToolApproval } from "@/lib/agent/toolPermissions";
import { nativeBusinessAllowedTools } from "@/lib/agent/nativeBusinessMcp.server";
import { resolveTaskSessionTools } from "@/lib/agent/task/agentTaskTools";
import { resolveNotionAgentToolNames } from "@/lib/extensions/notion/service";
import { resolveFeishuAgentToolNames } from "@/lib/extensions/feishu/service";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import { assertManagedHistoricalExecution } from "@/lib/ai/managed-provenance";
import { isManagedResolution } from "@/lib/ai/business-execution-lock";

import { cancelConversationRequest, ConversationRequestError } from "@/lib/agent/conversationRequest";
import type { UIMessage } from "ai";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { handleError } from "@/lib/utils";
import { requireUser } from "./shared";
import {
  archiveOwnedChatConversation,
  ChatConversationArchivedError,
  ChatConversationNotFoundError,
  contextOfRow,
  createChatConversationRecord,
  deleteOwnedChatConversation,
  getNewestOwnedChatConversation,
  getOwnedChatConversation,
  listArchivedChatConversations as listArchivedChatConversationRows,
  listOwnedChatConversations,
  unarchiveOwnedChatConversation,
  updateChatConversationMessages,
  updateOwnedChatConversationContext,
  type ChatConversationRow,
} from "@/lib/agent/chatConversationStore";
import { chatLockFromRow } from "@/lib/agent/chatConversationLock";
import { CHAT_LOCK_PURPOSE } from "@/lib/agent/chatConversationLock";
import { resolveChatCreationLock } from "@/lib/agent/chatConversationLock";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import { AIBusinessError, agentRoleAssignmentPurpose, assertAccountExecutionIdentity, classifyAIConnection } from "@/lib/ai/connections";
import {
  checkStreamingExecutionReadiness,
  type AccountRuntimeCapabilities,
} from "@/lib/ai/runtime/capabilities";
import { fetchAccountRuntimeState } from "@/lib/ai/streaming-execution";
import { getUserSettings } from "@/actions/userSettings.actions";
import { isPermissionMode, permissionModeOfContext, type PermissionMode } from "@/lib/agent/preferences";
import { loadAgentPreferences } from "@/lib/agent/preferences.server";
import {
  parseConversationContext,
  titleFallbackFromUiMessages,
  type AgentConversationContextV1,
  type ContextItemRequest,
} from "@/lib/agent/conversationContext";
import {
  listOwnedContextOptions,
  resolveOwnedContext,
  resolvePageContextItems,
} from "@/lib/agent/conversationContext.server";
// Keep these types in chatTypes.ts. A type re-export from this "use server"
// module is erased at runtime, and Turbopack still tries to expose it as an
// action export, which fails the dashboard client bundle.
import type {
  AgentChatPreflight,
  AgentToolPermissionSnapshot,
  ChatConversationSnapshot,
  ChatConversationSummary,
  EligibleChatModel,
  ExplicitModelSelection,
  NativeChatEntry,
} from "@/lib/agent/chatTypes";
import {
  normalizeAgentRole,
  type AgentRole,
} from "@/lib/agent/agentRoles";

function fail(error: unknown, fallback: string): {
  success: false;
  message: string;
  code?: string;
  details?: unknown;
} {
  if (error instanceof ConversationRequestError) return { success: false, message: error.message, code: error.code };
  if (error instanceof AIBusinessError) {
    return { success: false, message: error.message, code: error.code, ...(error.details !== undefined ? { details: error.details } : {}) };
  }
  if (error instanceof ChatConversationArchivedError) {
    return {
      success: false,
      message: error.message,
      code: "CONVERSATION_ARCHIVED",
    };
  }
  if (error instanceof ChatConversationNotFoundError) {
    return {
      success: false,
      message: error.message,
      code: "CONVERSATION_NOT_FOUND",
    };
  }
  const result = handleError(error, fallback);
  return { success: false, message: result.message ?? fallback };
}

function snapshotOf(row: ChatConversationRow): ChatConversationSnapshot {
  let messages: UIMessage[] = [];
  try {
    const parsed = JSON.parse(row.messages) as unknown;
    messages = Array.isArray(parsed) ? (parsed as UIMessage[]) : [];
  } catch {
    console.error("Chat conversation JSON was unreadable; returning empty.");
    messages = [];
  }
  const context = contextOfRow(row);
  const lock = chatLockFromRow(row);
  return {
    id: row.id,
    revision: row.revision,
    executionPath: row.executionPath,
    title: row.title,
    titleFallback: row.title ? null : titleFallbackFromUiMessages(messages),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    messages,
    context,
    lockKind: lock.kind,
    resolvedConnectionId: row.resolvedConnectionId,
    resolvedModel: row.resolvedModel,
    agentRole: normalizeAgentRole(row.agentRole),
    chatMode: row.chatMode,
    activeRole: normalizeAgentRole(row.activeRole) ?? normalizeAgentRole(row.agentRole),
    archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
    ...(row.agentTaskId ? { agentTaskId: row.agentTaskId } : {}),
  };
}

export const getChatConversation = async (
  conversationId: string,
): Promise<{
  success: boolean;
  data?: ChatConversationSnapshot;
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    const row = await getOwnedChatConversation(user.id, conversationId);
    if (!row) {
      return {
        success: false,
        message: "Conversation not found",
        code: "CONVERSATION_NOT_FOUND",
      };
    }
    return { success: true, data: snapshotOf(row) };
  } catch (error) {
    return fail(error, "Failed to load the conversation.");
  }
};

export const loadActiveChatConversation = async (
  preferredId?: string | null,
): Promise<{
  success: boolean;
  data?: ChatConversationSnapshot | null;
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    if (preferredId === APP_CONSTANTS.AGENT_CHAT_DRAFT_CONVERSATION_ID) {
      return { success: true, data: null };
    }
    if (preferredId) {
      const preferred = await getOwnedChatConversation(user.id, preferredId);
      // An archived conversation never opens as the live draft — the
      // Archive Center is the only way back to it.
      if (preferred && !preferred.archivedAt) {
        return { success: true, data: snapshotOf(preferred) };
      }
    }
    const newest = await getNewestOwnedChatConversation(user.id);
    return { success: true, data: newest ? snapshotOf(newest) : null };
  } catch (error) {
    return fail(error, "Failed to load the conversation.");
  }
};

export const listChatConversations = async (): Promise<{
  success: boolean;
  data?: ChatConversationSummary[];
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    const rows = await listOwnedChatConversations(user.id);
    return {
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        title: row.title,
        titleFallback: row.titleFallback,
        agentRole: normalizeAgentRole(row.agentRole),
        chatMode: row.chatMode,
        activeRole: normalizeAgentRole(row.activeRole) ?? normalizeAgentRole(row.agentRole),
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  } catch (error) {
    return fail(error, "Failed to list conversations.");
  }
};

export const createChatConversation = async (input?: {
  executionPath?: "APP_ORCHESTRATED" | "NATIVE_CODEX_V1";
  chatMode?: "UNIFIED" | "LEGACY_ROLE_BOUND";
  permissionMode?: PermissionMode;
  messages?: UIMessage[];
  context?: ContextItemRequest[];
  explicit?: ExplicitModelSelection | null;
  firstUserText?: string | null;
  /**
   * The role this conversation is bound to, fixed at creation. The client
   * declares the slot it is creating in — this is the only client-carried
   * role; afterwards the persisted row is the sole authority (route reads
   * role from the row, never from the request).
   */
  agentRole?: AgentRole | null;
  activeRole?: AgentRole | null;
}): Promise<{
  success: boolean;
  data?: ChatConversationSnapshot;
  message?: string;
  code?: string;
  /** Structured failure context (e.g. native-readiness reason + versions). */
  details?: unknown;
}> => {
  try {
    const user = await requireUser();
    const context = await resolveOwnedContext(user.id, input?.context ?? []);
    if (input?.permissionMode !== undefined && !isPermissionMode(input.permissionMode)) {
      return { success: false, code: "INVALID_PERMISSION_MODE", message: "Invalid permission mode" };
    }
    context.permissionMode = input?.permissionMode ?? (await loadAgentPreferences(user.id)).defaultPermission;
    const row = await createChatConversationRecord({
      executionPath: input?.executionPath,
      chatMode: input?.chatMode,
      userId: user.id,
      messages: input?.messages ?? [],
      context,
      explicit: input?.explicit ?? null,
      firstUserText: input?.firstUserText ?? null,
      agentRole: normalizeAgentRole(input?.agentRole),
      activeRole: normalizeAgentRole(input?.activeRole),
    });
    return { success: true, data: snapshotOf(row) };
  } catch (error) {
    return fail(error, "Failed to create the conversation.");
  }
};

export const saveChatConversation = async (
  conversationId: string,
  messages: UIMessage[],
): Promise<{ success: boolean; message?: string; code?: string }> => {
  try {
    const user = await requireUser();
    await updateChatConversationMessages(user.id, conversationId, messages);
    return { success: true };
  } catch (error) {
    return fail(error, "Failed to save the conversation.");
  }
};

export const updateChatConversationContext = async (
  conversationId: string,
  context: ContextItemRequest[],
): Promise<{
  success: boolean;
  data?: AgentConversationContextV1;
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    const resolved = await resolveOwnedContext(user.id, context);
    const row = await updateOwnedChatConversationContext(
      user.id,
      conversationId,
      resolved,
    );
    return { success: true, data: parseConversationContext(row.context) };
  } catch (error) {
    return fail(error, "Failed to update conversation context.");
  }
};

export const deleteChatConversation = async (
  conversationId: string,
): Promise<{ success: boolean; message?: string; code?: string }> => {
  try {
    const user = await requireUser();
    const deleted = await deleteOwnedChatConversation(user.id, conversationId);
    if (!deleted) {
      return {
        success: false,
        message: "Conversation not found",
        code: "CONVERSATION_NOT_FOUND",
      };
    }
    return { success: true };
  } catch (error) {
    return fail(error, "Failed to delete the conversation.");
  }
};

/**
 * Reversible archive — the History entry point. Not delete: the transcript,
 * context and summary stay put, hidden from every AI read path, until the
 * user restores it from the Archive Center.
 */
export const archiveChatConversation = async (
  conversationId: string,
): Promise<{ success: boolean; message?: string; code?: string }> => {
  try {
    const user = await requireUser();
    await archiveOwnedChatConversation(user.id, conversationId);
    return { success: true };
  } catch (error) {
    return fail(error, "Failed to archive the conversation.");
  }
};

export const restoreChatConversation = async (
  conversationId: string,
): Promise<
  | { success: true }
  | { success: false; message: string; code?: string }
> => {
  try {
    const user = await requireUser();
    await unarchiveOwnedChatConversation(user.id, conversationId);
    return { success: true };
  } catch (error) {
    return fail(error, "Failed to restore the conversation.");
  }
};

export const listArchivedChatConversations = async (input?: {
  search?: string;
}): Promise<{
  success: boolean;
  data?: Array<ChatConversationSummary & { archivedAt: string | null }>;
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    const rows = await listArchivedChatConversationRows(
      user.id,
      input?.search,
    );
    return {
      success: true,
      data: rows.map((row) => ({
        id: row.id,
        title: row.title,
        titleFallback: row.titleFallback,
        agentRole: normalizeAgentRole(row.agentRole),
        archivedAt: row.archivedAt ? row.archivedAt.toISOString() : null,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      })),
    };
  } catch (error) {
    return fail(error, "Failed to list archived conversations.");
  }
};

export const resolveDraftPageContext = async (input: {
  jobId?: string | null;
  resumeId?: string | null;
}): Promise<{
  success: boolean;
  data?: AgentConversationContextV1;
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    const context = await resolvePageContextItems(user.id, input);
    return { success: true, data: context };
  } catch (error) {
    return fail(error, "Failed to resolve page context.");
  }
};

export const listAgentContextOptions = async (): Promise<{
  success: boolean;
  data?: Awaited<ReturnType<typeof listOwnedContextOptions>>;
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    return { success: true, data: await listOwnedContextOptions(user.id) };
  } catch (error) {
    return fail(error, "Failed to list context.");
  }
};

export const listEligibleChatModels = async (): Promise<{
  success: boolean;
  data?: EligibleChatModel[];
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    const rows = await prisma.aIBusinessAssignment.findMany({
      where: { userId: user.id },
      select: {
        connectionId: true,
        model: true,
        connection: { select: { displayName: true, provider: true } },
      },
    });
    const seen = new Set<string>();
    const data: EligibleChatModel[] = [];
    for (const row of rows) {
      const key = `${row.connectionId}\n${row.model}`;
      if (seen.has(key)) continue;
      try {
        await resolveChatCreationLock(user.id, {
          connectionId: row.connectionId,
          model: row.model,
        });
      } catch {
        continue;
      }
      seen.add(key);
      data.push({
        connectionId: row.connectionId,
        model: row.model,
        displayName: row.connection?.displayName ?? row.connectionId,
        provider: row.connection?.provider ?? "",
      });
    }
    return { success: true, data };
  } catch (error) {
    return fail(error, "Failed to list models.");
  }
};

/**
 * The Codex pair a NEW native conversation would lock to, probed before the
 * user clicks the native entry — unavailable renders grey with a reason in
 * the model menu instead of erroring afterwards. `preferred` is the draft's
 * explicit pick: a usable Codex connection and allowlisted model win over the
 * default resolution.
 */
export const getNativeChatEntry = async (input?: {
  preferred?: ExplicitModelSelection | null;
}): Promise<{
  success: boolean;
  data?: NativeChatEntry;
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();
    return {
      success: true,
      data: await resolveNativeChatEntry(user.id, input?.preferred ?? null),
    };
  } catch (error) {
    return fail(error, "Failed to check native session availability.");
  }
};

async function accountStreamingBlockCode(connection: {
  backendKind: string;
  provider: string;
  status: string;
}): Promise<string | null> {
  if (connection.backendKind === "LOCAL_BYOK") {
    // BYOK streams through the AI SDK in-process — no desktop runtime to probe.
    return null;
  }
  let state;
  try {
    state = await fetchAccountRuntimeState({
      backendKind: connection.backendKind,
      accountProvider: connection.provider,
    });
  } catch (error) {
    return error instanceof AIBusinessError
      ? error.code
      : "RUNTIME_NOT_AVAILABLE";
  }
  const capabilities = state.capabilities as AccountRuntimeCapabilities | null;
  if (
    !capabilities?.implemented ||
    capabilities.execution?.localOneShot !== true
  ) {
    return "PERMISSION_BOUNDARY_NOT_READY";
  }
  if (state.runtimeReady !== true) return "RUNTIME_NOT_AVAILABLE";
  const verdict = checkStreamingExecutionReadiness({
    capabilities,
    connectionStatus: connection.status,
    permissionScope: "TEXT_ONLY",
    runtimeVersion: state.runtimeVersion,
  });
  if (!verdict.ready) return verdict.code;
  // Structured output is an agent-turn requirement, checked after the
  // local router (prepareCareerDialogueTurn). A streaming-ready runtime
  // can still answer a direct chat when structured output is unverified.
  // Assignment selection is not relaxed here.
  return null;
}

async function accountPreflight(input: {
  userId: string;
  connectionId: string;
  model: string | null;
  locked: boolean;
}): Promise<AgentChatPreflight> {
  const connection = await prisma.aIConnection.findFirst({
    where: { id: input.connectionId, userId: input.userId },
    select: {
      id: true,
      provider: true,
      authType: true,
      credentialRef: true,
      runtimeProfileRef: true,
      accountIdentity: true,
      backendKind: true,
      displayName: true,
      status: true,
      archivedAt: true,
    },
  });
  const blocked = (code: string): AgentChatPreflight => ({
    kind: "blocked", code, connectionId: input.connectionId,
    model: input.model, displayName: connection?.displayName ?? null, locked: input.locked,
  });
  if (!connection || connection.archivedAt) {
    return blocked("ASSIGNED_CONNECTION_UNAVAILABLE");
  }
  const classification = classifyAIConnection(connection);
  if (classification === "INVALID") {
    return blocked("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
  }
  if (classification !== "BYOK") assertAccountExecutionIdentity(connection);
  if (connection.status !== "CONNECTED") {
    return blocked(
        connection.status === "REAUTH_REQUIRED"
          ? "REAUTH_REQUIRED"
          : connection.status === "DISCONNECTED"
            ? "CONNECTION_DISCONNECTED"
            : "CONNECTION_ERROR",
    );
  }
  if (!input.model) {
    return blocked("MODEL_UNAVAILABLE");
  }
  const streamBlock = await accountStreamingBlockCode(connection);
  if (streamBlock) {
    return blocked(streamBlock);
  }
  return {
    kind: "account",
    connectionId: connection.id,
    provider: connection.provider,
    backendKind: connection.backendKind,
    model: input.model,
    displayName: connection.displayName,
    locked: input.locked,
  };
}

async function currentLegacyModel(): Promise<string | null> {
  const settings = await getUserSettings();
  const model = settings?.data?.settings?.ai?.model;
  return typeof model === "string" && model.trim() ? model : null;
}

/**
 * Existing conversation: inspect that row's lock.
 * New draft: preview an explicit selection, else the current assignment.
 * Never looks up "the user's only conversation".
 */
export const getAgentChatPreflight = async (input?: {
  conversationId?: string | null;
  explicit?: ExplicitModelSelection | null;
}): Promise<{
  success: boolean;
  data?: AgentChatPreflight;
  message?: string;
  code?: string;
}> => {
  try {
    const user = await requireUser();

    if (input?.conversationId) {
      const row = await getOwnedChatConversation(user.id, input.conversationId);
      if (!row) {
        return {
          success: false,
          message: "Conversation not found",
          code: "CONVERSATION_NOT_FOUND",
        };
      }
      const lock = chatLockFromRow(row);
      if (row.executionPath === "NATIVE_CODEX_V1") {
        if (lock.kind !== "account" || !lock.model) throw new AIBusinessError("NATIVE_SESSION_UNAVAILABLE", "Native session lock unavailable");
        const state = await nativeReadiness(user.id, lock.connectionId, lock.model);
        return { success: true, data: { kind: "account", connectionId: lock.connectionId, model: lock.model, provider: state.connection.provider, backendKind: state.connection.backendKind, displayName: state.connection.displayName, locked: true } };
      }
      if (lock.kind === "managed") {
        const connection = lock.connectionId ? await prisma.aIConnection.findFirst({
          where: { id: lock.connectionId, userId: user.id },
        }) : null;
        try {
          assertManagedHistoricalExecution(lock, connection, user.id);
        } catch (error) {
          if (error instanceof AIBusinessError) {
            return {
              success: true,
              data: {
                kind: "blocked",
                code: error.code,
                connectionId: lock.connectionId ?? undefined,
              },
            };
          }
          throw error;
        }
        return {
          success: true,
          data: {
            kind: "managed",
            connectionId: lock.connectionId!,
            model: lock.model,
            displayName: connection?.displayName ?? "Vocatrya Managed AI",
            locked: true,
          },
        };
      }
      if (lock.kind === "account") {
        return {
          success: true,
          data: await accountPreflight({
            userId: user.id,
            connectionId: lock.connectionId,
            model: lock.model,
            locked: true,
          }),
        };
      }
      // Unified rows intentionally carry no creation-time lock (D07 per-step
      // resolution). A reopened unified chat must preflight like a fresh
      // draft for its active role — falling through to the null-lock legacy
      // answer would wrongly report "not configured" and block the composer.
      if (row.chatMode === "UNIFIED") {
        const resolution = await resolveBusinessAIConfig({
          userId: user.id,
          purpose: agentRoleAssignmentPurpose(
            row.activeRole === "insight" || row.activeRole === "reflect"
              ? row.activeRole
              : "pilot",
          ),
        });
        if (resolution.status === "RESOLVED") {
          const connection = await prisma.aIConnection.findFirst({
            where: { id: resolution.connectionId, userId: user.id },
            select: { displayName: true, status: true },
          });
          if (isManagedResolution(resolution)) {
            return {
              success: true,
              data: {
                kind: "managed",
                connectionId: resolution.connectionId,
                model: resolution.model,
                displayName:
                  connection?.displayName ?? "Vocatrya Managed AI",
                locked: false,
              },
            };
          }
          const streamBlock = await accountStreamingBlockCode({
            backendKind: resolution.backendKind,
            provider: resolution.provider,
            status: connection?.status ?? "CONNECTED",
          });
          if (streamBlock) {
            return {
              success: true,
              data: {
                kind: "blocked",
                code: streamBlock,
                connectionId: resolution.connectionId,
                model: resolution.model,
                displayName: connection?.displayName ?? resolution.provider,
                locked: false,
              },
            };
          }
          return {
            success: true,
            data: {
              kind: "account",
              connectionId: resolution.connectionId,
              provider: resolution.provider,
              backendKind: resolution.backendKind,
              model: resolution.model,
              displayName: connection?.displayName ?? resolution.provider,
              locked: false,
            },
          };
        }
        if (resolution.status === "INVALID_ASSIGNMENT") {
          return {
            success: true,
            data: {
              kind: "blocked",
              code: resolution.code,
              connectionId: resolution.connectionId,
              model: resolution.model ?? null,
              locked: false,
            },
          };
        }
      }
      return {
        success: true,
        data: {
          kind: "legacy",
          model: await currentLegacyModel(),
          persisted: true,
        },
      };
    }

    if (input?.explicit) {
      let lock;
      try {
        lock = await resolveChatCreationLock(user.id, input.explicit);
      } catch (error) {
        if (error instanceof AIBusinessError) {
          return {
            success: true,
            data: {
              kind: "blocked",
              code: error.code,
              connectionId: input.explicit.connectionId,
            },
          };
        }
        throw error;
      }
      if (!lock.resolvedConnectionId) {
        return {
          success: true,
          data: { kind: "blocked", code: "MODEL_UNAVAILABLE" },
        };
      }
      return {
        success: true,
        data: await accountPreflight({
          userId: user.id,
          connectionId: lock.resolvedConnectionId,
          model: lock.resolvedModel,
          locked: false,
        }),
      };
    }

    const resolution = await resolveBusinessAIConfig({
      userId: user.id,
      purpose: CHAT_LOCK_PURPOSE,
    });
    if (resolution.status === "RESOLVED") {
      const connection = await prisma.aIConnection.findFirst({
        where: { id: resolution.connectionId, userId: user.id },
        select: { displayName: true, status: true },
      });
      if (isManagedResolution(resolution)) {
        // Managed sources are served by the Hosted authority — the
        // desktop runtime/streaming gates do not apply.
        return {
          success: true,
          data: {
            kind: "managed",
            connectionId: resolution.connectionId,
            model: resolution.model,
            displayName: connection?.displayName ?? "Vocatrya Managed AI",
            locked: false,
          },
        };
      }
      const streamBlock = await accountStreamingBlockCode({
        backendKind: resolution.backendKind,
        provider: resolution.provider,
        status: connection?.status ?? "CONNECTED",
      });
      if (streamBlock) {
        return {
          success: true,
          data: {
            kind: "blocked",
            code: streamBlock,
            connectionId: resolution.connectionId,
            model: resolution.model,
            displayName: connection?.displayName ?? resolution.provider,
            locked: false,
          },
        };
      }
      return {
        success: true,
        data: {
          kind: "account",
          connectionId: resolution.connectionId,
          provider: resolution.provider,
          backendKind: resolution.backendKind,
          model: resolution.model,
          displayName: connection?.displayName ?? resolution.provider,
          locked: false,
        },
      };
    }
    if (resolution.status === "INVALID_ASSIGNMENT") {
      return {
        success: true,
        data: {
          kind: "blocked",
          code: resolution.code,
          connectionId: resolution.connectionId,
          model: resolution.model ?? null,
          locked: false,
        },
      };
    }
    return {
      success: true,
      data: {
        kind: "legacy",
        model: await currentLegacyModel(),
        persisted: false,
      },
    };
  } catch (error) {
    return fail(error, "Failed to check the assistant configuration.");
  }
};

export const cancelChatConversationRequest = async (conversationId: string, requestId: string) => {
  try {
    const user = await requireUser();
    await cancelConversationRequest(user.id, conversationId, requestId);
    const row = await getOwnedChatConversation(user.id, conversationId);
    if (!row) return { success: false as const, code: "CONVERSATION_NOT_FOUND" };
    return { success: true as const, data: snapshotOf(row) };
  } catch (error) { return fail(error, "Failed to cancel conversation request."); }
};

/** Read-only preview; execution still rechecks connection state and approvals. */
export async function getAgentToolPermissions(input: { conversationId?: string | null; agentRole?: string | null; permissionMode?: PermissionMode }): Promise<{
  success: boolean;
  data?: AgentToolPermissionSnapshot;
  message?: string;
  code?: string;
}> {
  try {
    const user = await requireUser();
    const row = input.conversationId ? await getOwnedChatConversation(user.id, input.conversationId) : null;
    if (input.conversationId && !row) throw new ChatConversationNotFoundError();
    const role = normalizeAgentRole(row ? row.agentRole : input.agentRole);
    const runtime = await resolveCareerRuntimeMode(prisma);
    const freshNativeFull = isFreshNativeFullSurface(runtime);
    const notionTools = await resolveNotionAgentToolNames(user.id).catch(() => []);
    const feishuTools = await resolveFeishuAgentToolNames(user.id).catch(() => []);
    // Same resolution the route uses for the live tool registry (task sessions only).
    const taskExtraTools = row?.agentTaskId
      ? await resolveTaskSessionTools(prisma, { userId: user.id, agentTaskId: row.agentTaskId, agentRole: row.agentRole }).catch(() => null)
      : null;
    const permissionMode = input.conversationId
      ? permissionModeOfContext((await getOwnedChatConversation(user.id, input.conversationId))?.context)
      : isPermissionMode(input.permissionMode) ? input.permissionMode : (await loadAgentPreferences(user.id)).defaultPermission;
    return { success: true as const, data: {
      role,
      permissionMode,
      tools: (row?.executionPath === "NATIVE_CODEX_V1"
        ? nativeBusinessAllowedTools({ agentRole: role, freshNativeFull, notionTools, feishuTools, taskExtraTools })
        : effectiveAgentToolNames({ agentRole: role, freshNativeFull, notionTools, feishuTools, taskExtraTools })
      ).map(name => ({ name, approval: agentToolApproval(name, freshNativeFull, permissionMode) })),
    } };
  } catch (error) {
    return fail(error, "Could not load tool permissions");
  }
}

export async function restartNativeChat(conversationId: string) {
  try {
    const user = await requireUser();
    await restartNativeContext(user.id, conversationId);
    const row = await getOwnedChatConversation(user.id, conversationId);
    if (!row) throw new ChatConversationNotFoundError();
    return { success: true as const, data: snapshotOf(row) };
  } catch (error) { return fail(error, "Could not restart native context"); }
}

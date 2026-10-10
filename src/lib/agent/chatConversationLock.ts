import { managedLockFromRow, type ManagedHistoricalLock } from "@/lib/ai/managed-provenance";
import {
  bindManagedBusinessLock,
  isManagedResolution,
} from "@/lib/ai/business-execution-lock";
import "server-only";

import prisma from "@/lib/db";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import {
  AIBusinessError,
  isAIBackendKind,
  assertAccountExecutionIdentity,
  isSupportedAccountProviderForBackend,
} from "@/lib/ai/connections";
import { isRuntimeProfileRef } from "@/lib/ai/runtime/contract";
import type { ExplicitModelSelection } from "./chatTypes";

/**
 * ChatConversation AI lock — Career Dialogue's creation-time binding.
 *
 * The lock is resolved once, when the ChatConversation row is created, and
 * persisted into resolvedConnectionId/resolvedModel. It is never rewritten
 * afterwards: reloads, retries, regenerations and later assignment changes
 * all keep the pinned pair. There is no mid-conversation failover — a locked
 * connection that degrades fails the turn explicitly (the per-turn check in
 * the route re-validates the row's state).
 *
 *   - resolvedConnectionId set   → ACCOUNT lock: the conversation executes
 *     through that AIConnection + model on the managed runtime.
 *   - both columns null          → LEGACY: the conversation keeps the
 *     pre-migration semantics (live settings.ai provider/model). Historical
 *     rows stay null/null — NO_GUESS_BACKFILL — and conversations created
 *     while nothing is configured resolve to this too.
 *
 * A broken explicit assignment is still persisted as the lock. That is the
 * fail-closed contract: the conversation stays pinned to the broken
 * connection and every turn reports the connection's real error, rather
 * than falling back to GLOBAL_DEFAULT or legacy settings.
 */
export const CHAT_LOCK_PURPOSE = "CAREER_DIALOGUE" as const;

export type ChatConversationLock =
  | ManagedHistoricalLock
  | { kind: "account"; connectionId: string; model: string | null }
  | { kind: "legacy" };

export function chatLockFromRow(row: {
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  managedAiProvenance?: string | null;
}): ChatConversationLock {
  const managed = managedLockFromRow(row);
  if (managed) return managed;
  if (row.resolvedConnectionId) {
    return {
      kind: "account",
      connectionId: row.resolvedConnectionId,
      model: row.resolvedModel,
    };
  }
  return { kind: "legacy" };
}

export type ChatCreationLock = {
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  /** Encoded Managed provenance — set only when the lock is Managed. */
  managedAiProvenance?: string | null;
};

/**
 * Resolves the pair a NEW ChatConversation locks to. Only call this on the
 * create path — existing rows read their persisted lock instead.
 *
 * INVALID_ASSIGNMENT resolves to the broken assignment's own pair: the lock
 * records what the user actually picked, and the per-turn check surfaces
 * the stable error (CONNECTION_DISCONNECTED, REAUTH_REQUIRED, ...) instead
 * of silently degrading to another path.
 */
const MODEL_MAX = 200;

function explicitModelIsEligible(model: string): boolean {
  if (!model || model.length > MODEL_MAX) return false;
  if (/[\u0000-\u001f\u007f]/.test(model)) return false;
  if (model.includes("\\") || model.includes("..")) return false;
  if (/^[a-zA-Z]:/.test(model) || model.startsWith("/")) return false;
  if (/\.(exe|dll|bat|cmd|sh)$/i.test(model)) return false;
  return true;
}

/**
 * Explicit new-conversation selection. Invalid pairs throw. Callers must
 * not catch this and substitute GLOBAL_DEFAULT or the legacy provider.
 */
export async function resolveExplicitChatSelection(
  userId: string,
  selection: ExplicitModelSelection,
): Promise<ChatCreationLock> {
  const connectionId = selection.connectionId?.trim() ?? "";
  const model = selection.model?.trim() ?? "";
  if (!connectionId || !explicitModelIsEligible(model)) {
    throw new AIBusinessError(
      "MODEL_UNAVAILABLE",
      "The selected model is not eligible",
    );
  }
  const connection = await prisma.aIConnection.findFirst({
    where: { id: connectionId, userId },
    select: {
      id: true,
      provider: true,
      authType: true,
      credentialRef: true,
      accountIdentity: true,
      backendKind: true,
      status: true,
      runtimeProfileRef: true,
      archivedAt: true,
    },
  });
  if (!connection || connection.archivedAt) {
    throw new AIBusinessError(
      "ASSIGNED_CONNECTION_UNAVAILABLE",
      "The selected AI connection is not available",
    );
  }
  assertAccountExecutionIdentity(connection);
  switch (connection.status) {
    case "CONNECTED":
      break;
    case "REAUTH_REQUIRED":
      throw new AIBusinessError(
        "REAUTH_REQUIRED",
        "The selected AI connection needs you to sign in again",
      );
    case "DISCONNECTED":
      throw new AIBusinessError(
        "CONNECTION_DISCONNECTED",
        "The selected AI connection is disconnected",
      );
    default:
      throw new AIBusinessError(
        "CONNECTION_ERROR",
        "The selected AI connection is not usable",
      );
  }
  if (
    !isAIBackendKind(connection.backendKind) ||
    !isRuntimeProfileRef(connection.runtimeProfileRef)
  ) {
    throw new AIBusinessError(
      "RUNTIME_NOT_AVAILABLE",
      "The selected AI connection has no usable runtime",
    );
  }
  if (
    !isSupportedAccountProviderForBackend(
      connection.backendKind,
      connection.provider,
    )
  ) {
    throw new AIBusinessError(
      "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
      "The selected AI connection cannot run that provider",
    );
  }
  return {
    resolvedConnectionId: connection.id,
    resolvedModel: model,
  };
}

export async function resolveChatCreationLock(
  userId: string,
  explicit?: ExplicitModelSelection | null,
  options?: {
    /** `conversation:<id>` — the binding identity this row will carry. */
    resourceKey?: string;
    managedClient?: import("@/lib/ai/managed-client").HostedManagedClient;
  },
): Promise<ChatCreationLock> {
  if (explicit) {
    return resolveExplicitChatSelection(userId, explicit);
  }
  const resolution = await resolveBusinessAIConfig({
    userId,
    purpose: CHAT_LOCK_PURPOSE,
  });
  if (resolution.status === "RESOLVED" && isManagedResolution(resolution)) {
    // First-bind the conversation now so the row's lock and the Hosted
    // binding are created together; a bind failure aborts creation.
    const lock = await bindManagedBusinessLock({
      userId,
      connectionId: resolution.connectionId,
      model: resolution.model,
      business: "CAREER_DIALOGUE",
      resourceKey: options?.resourceKey ?? "",
      client: options?.managedClient,
    });
    return {
      resolvedConnectionId: lock.connectionId,
      resolvedModel: lock.model,
      managedAiProvenance: lock.managedAiProvenance,
    };
  }
  if (
    resolution.status === "RESOLVED" ||
    resolution.status === "INVALID_ASSIGNMENT"
  ) {
    return {
      resolvedConnectionId: resolution.connectionId,
      resolvedModel: resolution.model ?? null,
    };
  }
  // NOT_CONFIGURED — no assignment and no GLOBAL_DEFAULT. The row is
  // created without a lock and the turn runs the legacy provider path.
  return { resolvedConnectionId: null, resolvedModel: null };
}

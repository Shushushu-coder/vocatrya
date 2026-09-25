import "server-only";

import { resolveBusinessAIConfig } from "@/lib/ai/assignments";

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
  | { kind: "account"; connectionId: string; model: string | null }
  | { kind: "legacy" };

export function chatLockFromRow(row: {
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
}): ChatConversationLock {
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
export async function resolveChatCreationLock(
  userId: string,
): Promise<ChatCreationLock> {
  const resolution = await resolveBusinessAIConfig({
    userId,
    purpose: CHAT_LOCK_PURPOSE,
  });
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

import { managedLockFromRow, type ManagedHistoricalLock } from "@/lib/ai/managed-provenance";
/**
 * InterviewSession AI lock — how a session's model identity is persisted.
 *
 * InterviewSession carries two nullable lock columns captured once at
 * creation time and never rewritten afterwards:
 *
 * - ACCOUNT lock: `resolvedConnectionId` + `resolvedModel` hold the
 *   AIConnection id and model the session is bound to. Every later turn
 *   executes through that exact pair — assignment changes, retries and
 *   reloads never re-resolve.
 * - LEGACY lock: a session created while `settings.ai.interview` was the
 *   effective config keeps `resolvedConnectionId = null` (no AIConnection
 *   is fabricated) and stores the provider/model pair in `resolvedModel`
 *   as a tagged JSON envelope, so later legacy-settings edits cannot
 *   silently retarget the session.
 * - UNLOCKED: both columns null. Historical sessions (NO_GUESS_BACKFILL)
 *   and sessions created while nothing was configured keep the original
 *   live `settings.ai.interview` semantics.
 */
export const LEGACY_INTERVIEW_LOCK_KIND = "LEGACY_INTERVIEW_CONFIG";

export type InterviewSessionAiLock =
  | ManagedHistoricalLock
  | { kind: "account"; connectionId: string; model: string }
  | { kind: "legacy"; provider: string; model: string }
  | { kind: "unlocked" };

/** Serialize a legacy provider/model pair for storage in `resolvedModel`. */
export function encodeLegacyInterviewLock(
  provider: string,
  model: string,
): string {
  return JSON.stringify({
    kind: LEGACY_INTERVIEW_LOCK_KIND,
    provider,
    model,
  });
}

/**
 * Decode the persisted lock columns into the execution plan for the
 * session. A bare (non-envelope) `resolvedModel` without a connection id
 * is treated as unlocked — it carries no usable provider identity.
 */
export function sessionAiLockFromRow(row: {
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  managedAiProvenance?: string | null;
}): InterviewSessionAiLock {
  const managed = managedLockFromRow(row);
  if (managed) return managed;
  if (row.resolvedConnectionId) {
    return {
      kind: "account",
      connectionId: row.resolvedConnectionId,
      model: row.resolvedModel ?? "",
    };
  }
  const raw = row.resolvedModel;
  if (typeof raw === "string" && raw.startsWith("{")) {
    try {
      const parsed = JSON.parse(raw) as {
        kind?: unknown;
        provider?: unknown;
        model?: unknown;
      };
      if (
        parsed &&
        parsed.kind === LEGACY_INTERVIEW_LOCK_KIND &&
        typeof parsed.provider === "string" &&
        parsed.provider.trim().length > 0 &&
        typeof parsed.model === "string" &&
        parsed.model.trim().length > 0
      ) {
        return {
          kind: "legacy",
          provider: parsed.provider,
          model: parsed.model,
        };
      }
    } catch {
      // Malformed lock payload — fall through to unlocked.
    }
  }
  return { kind: "unlocked" };
}

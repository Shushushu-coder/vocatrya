import {
  INTERVIEW_ADAPTER_ERROR_CODES,
  InterviewAdapterError,
} from "./errors";

/**
 * User ownership adapter (Phase 2).
 *
 * Authority is always the Vocatrya `User.id`. Cross-user binds are rejected
 * with SESSION_FORBIDDEN so future HTTP layers can map the code directly.
 * There is no fallback identity (no tester_code, no username matching).
 */

export function assertUserIdPresent(userId: unknown): asserts userId is string {
  if (typeof userId !== "string" || userId.trim().length === 0) {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.SESSION_FORBIDDEN,
      "userId is required",
    );
  }
}

/** Owner and actor must be the same user id (exact string equality). */
export function assertSameUser(ownerUserId: string, actorUserId: string): void {
  assertUserIdPresent(ownerUserId);
  assertUserIdPresent(actorUserId);
  if (ownerUserId !== actorUserId) {
    throw new InterviewAdapterError(
      INTERVIEW_ADAPTER_ERROR_CODES.SESSION_FORBIDDEN,
      "Cross-user relation rejected",
    );
  }
}

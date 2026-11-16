import "server-only";

/**
 * Harness durable-task types — server-side constants for the task ledger.
 * Client-facing DTOs live in `@/lib/career/deepMatchContract`; this module
 * stays free of them so the boundary stays explicit.
 */

export const HARNESS_TASK_KIND = {
  DEEP_MATCH: "DEEP_MATCH",
  AGENT_TOOL_WRITE: "AGENT_TOOL_WRITE",
} as const;

export type HarnessTaskKind =
  (typeof HARNESS_TASK_KIND)[keyof typeof HARNESS_TASK_KIND];

export const HARNESS_TASK_STATUS = {
  QUEUED: "QUEUED",
  RUNNING: "RUNNING",
  CANCELLING: "CANCELLING",
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export type HarnessTaskStatus =
  (typeof HARNESS_TASK_STATUS)[keyof typeof HARNESS_TASK_STATUS];

export const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  HARNESS_TASK_STATUS.SUCCEEDED,
  HARNESS_TASK_STATUS.FAILED,
  HARNESS_TASK_STATUS.CANCELLED,
]);

export const ACTIVE_TASK_STATUSES: readonly string[] = [
  HARNESS_TASK_STATUS.QUEUED,
  HARNESS_TASK_STATUS.RUNNING,
  HARNESS_TASK_STATUS.CANCELLING,
];

export const HARNESS_TASK_STEP = {
  PIN_INPUTS: "PIN_INPUTS",
  RUN_ANALYSIS: "RUN_ANALYSIS",
  COMMIT_RESULT: "COMMIT_RESULT",
} as const;

/** AGENT_TOOL_WRITE step names — VERIFY → DISPATCH → SETTLE. */
export const AGENT_WRITE_TASK_STEP = {
  VERIFY: "VERIFY",
  DISPATCH: "DISPATCH",
  SETTLE: "SETTLE",
} as const;

export type HarnessTaskStep =
  (typeof HARNESS_TASK_STEP)[keyof typeof HARNESS_TASK_STEP];

export const HARNESS_TASK_EVENT = {
  TASK_CREATED: "TASK_CREATED",
  TASK_CLAIMED: "TASK_CLAIMED",
  LEASE_RECLAIMED: "LEASE_RECLAIMED",
  STEP_STARTED: "STEP_STARTED",
  STEP_CHECKPOINT: "STEP_CHECKPOINT",
  MODEL_CALL_STARTED: "MODEL_CALL_STARTED",
  MODEL_CALL_FINISHED: "MODEL_CALL_FINISHED",
  LEASE_LOST: "LEASE_LOST",
  CANCEL_REQUESTED: "CANCEL_REQUESTED",
  TASK_RETRIED: "TASK_RETRIED",
  TASK_SUCCEEDED: "TASK_SUCCEEDED",
  TASK_FAILED: "TASK_FAILED",
  TASK_CANCELLED: "TASK_CANCELLED",
} as const;

export type HarnessTaskEventType =
  (typeof HARNESS_TASK_EVENT)[keyof typeof HARNESS_TASK_EVENT];

/** Schema version of the frozen `inputJson` payload. */
export const DEEP_MATCH_TASK_INPUT_VERSION = "1";
/** Schema version of the `pinnedJson` checkpoint payload. */
export const DEEP_MATCH_TASK_PINNED_VERSION = "1";

/**
 * Task failure codes that describe pinned inputs which are gone or
 * unusable — retry re-fails deterministically, so the UI offers "start a
 * new analysis" instead of "retry". Every other code is retryable.
 */
export const DEEP_MATCH_INPUT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "TASK_INPUT_VERSION_UNSUPPORTED",
  "OPPORTUNITY_NOT_FOUND",
  "OPPORTUNITY_ARCHIVED",
  "DEEP_JD_VERSION_MISSING",
  "MATCH_JD_MISSING",
  "DEEP_RESUME_VERSION_MISSING",
  "RESUME_VERSION_NOT_SUBMITTABLE",
  "MATCH_INSUFFICIENT_MATERIAL",
  // Commit-boundary names for the same losses — deterministic, retrying
  // can never fix a deleted business object.
  "VERSION_NOT_FOUND",
  "PARSE_NOT_FOUND",
  // A malformed or step-inconsistent checkpoint re-fails on every retry —
  // it is reused verbatim, so only a fresh analysis can move forward.
  "DEEP_MATCH_STATE_CONFLICT",
]);

/** A lost-ownership / superseded-epoch signal, never a user-facing code. */
export class HarnessOwnershipLost extends Error {
  constructor(message = "Task ownership was lost to a newer claim") {
    super(message);
    this.name = "HarnessOwnershipLost";
  }
}

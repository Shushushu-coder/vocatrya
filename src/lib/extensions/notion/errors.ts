// Stable machine-facing error codes for the Notion extension. Anything the
// renderer or the model sees is one of these codes plus fixed copy — raw
// provider, fetch or SDK messages never cross the boundary because they can
// carry request context or remote text.
export const NOTION_ERROR = {
  NOT_CONNECTED: "NOTION_NOT_CONNECTED",
  CONNECT_PENDING: "NOTION_CONNECT_PENDING",
  REAUTH_REQUIRED: "NOTION_REAUTH_REQUIRED",
  OAUTH_DENIED: "NOTION_OAUTH_DENIED",
  OAUTH_STATE_MISMATCH: "NOTION_OAUTH_STATE_MISMATCH",
  OAUTH_FLOW_EXPIRED: "NOTION_OAUTH_FLOW_EXPIRED",
  OAUTH_FAILED: "NOTION_OAUTH_FAILED",
  CREDENTIAL_UNAVAILABLE: "NOTION_CREDENTIAL_UNAVAILABLE",
  TOOL_UNAVAILABLE: "NOTION_TOOL_UNAVAILABLE",
  PERMISSION_DENIED: "NOTION_PERMISSION_DENIED",
  RATE_LIMITED: "NOTION_RATE_LIMITED",
  // Object missing OR not shared with the integration (Notion reports both
  // as object_not_found / restricted_resource) — a definite, non-retryable
  // failure, never an unknown outcome.
  OBJECT_NOT_FOUND: "NOTION_OBJECT_NOT_FOUND",
  NETWORK: "NOTION_NETWORK",
  OUTCOME_UNKNOWN: "NOTION_OUTCOME_UNKNOWN",
  VERIFICATION_REQUIRED: "NOTION_VERIFICATION_REQUIRED",
  VALIDATION_FAILED: "NOTION_VALIDATION_FAILED",
  REMOTE_FAILED: "NOTION_REMOTE_FAILED",
} as const;

export type NotionErrorCode =
  (typeof NOTION_ERROR)[keyof typeof NOTION_ERROR];

export class NotionError extends Error {
  readonly code: NotionErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: NotionErrorCode,
    options?: { retryable?: boolean; retryAfterMs?: number; message?: string },
  ) {
    super(options?.message ?? code);
    this.name = "NotionError";
    this.code = code;
    this.retryable = options?.retryable === true;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

export function isNotionError(error: unknown): error is NotionError {
  return error instanceof NotionError;
}

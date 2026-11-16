/**
 * Client-safe contract for durable operation proposals. The proposal row
 * is the business authority; the transcript approval part is only its
 * display, and the harness task is only the runtime executor.
 */

export const AGENT_PROPOSAL_STATUS = {
  PROPOSED: "PROPOSED",
  APPROVED: "APPROVED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
  SUPERSEDED: "SUPERSEDED",
  EXPIRED: "EXPIRED",
} as const;
export type AgentProposalStatus =
  (typeof AGENT_PROPOSAL_STATUS)[keyof typeof AGENT_PROPOSAL_STATUS];

export const AGENT_PROPOSAL_OUTCOME = {
  SUCCEEDED: "SUCCEEDED",
  FAILED: "FAILED",
  UNCERTAIN: "UNCERTAIN",
  CANCELLED: "CANCELLED",
} as const;
export type AgentProposalOutcome =
  (typeof AGENT_PROPOSAL_OUTCOME)[keyof typeof AGENT_PROPOSAL_OUTCOME];

/**
 * Derived display state — never stored. `unverified` is APPROVED with no
 * task and no outcome (backup-restore ambiguity: "no dispatch marker" is
 * not proof the write never went out).
 */
export type AgentProposalDerived =
  | "pending"
  | "expired"
  | "queued"
  | "running"
  | "cancelling"
  | "succeeded"
  | "failed"
  | "uncertain"
  | "cancelled"
  | "rejected"
  | "withdrawn"
  | "superseded"
  | "unverified";

export const AGENT_PROPOSAL_REASON = {
  /** Orphan transcript part: decided before proposals existed. */
  LEGACY_NOT_CONTINUABLE: "LEGACY_APPROVAL_NOT_CONTINUABLE",
  EXPIRED: "PROPOSAL_EXPIRED",
  WITHDRAWN: "PROPOSAL_WITHDRAWN",
  SOURCE_DELETED: "SOURCE_DELETED",
  AUTHORIZATION_EXPIRED: "AUTHORIZATION_EXPIRED",
} as const;

export const AGENT_PROPOSAL_DECISION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AgentOperationProposalDTO = {
  id: string;
  toolName: string;
  status: AgentProposalStatus;
  derived: AgentProposalDerived;
  /** Validated immutable input — the decision binds exactly this. */
  input: Record<string, unknown>;
  target?: string;
  contentSummary?: string;
  conversationId: string | null;
  sourceArchived: boolean;
  approvalId: string;
  toolCallId: string;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decisionReason: string | null;
  dispatched: boolean;
  taskId: string | null;
  taskStatus: string | null;
  outcomeStatus: AgentProposalOutcome | null;
  outcome: unknown | null;
  manualResolution: string | null;
  supersedesId: string | null;
};

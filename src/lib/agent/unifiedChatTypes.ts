import { isAgentRole, type AgentRole } from "./agentRoles";

export const AGENT_UNIFIED_STATUS_PART_TYPE = "data-unified-status" as const;

export type UnifiedStepStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED"
  | "BLOCKED_APPROVAL";

export type UnifiedMessageMetadata = {
  agentRole?: AgentRole;
  turnId?: string;
  stepIndex?: number;
  stepCount?: number;
  model?: string | null;
  connectionId?: string | null;
  executionPath?: string;
  configSource?: string;
  stepStatus?: UnifiedStepStatus;
  errorCode?: string | null;
  skippedNextRole?: AgentRole | null;
  skippedNextObjective?: string | null;
  reanswerOfMessageId?: string | null;
};

export type AgentUnifiedStatusData = {
  phase:
    | "routing"
    | "step_running"
    | "step_handoff"
    | "step_blocked"
    | "step_failed"
    | "done";
  turnId?: string;
  stepIndex?: number;
  stepCount?: number;
  role?: AgentRole;
  nextRole?: AgentRole;
  message?: string;
  errorCode?: string;
};

export type StepHandoffPayload = {
  step1Role: AgentRole;
  step1Objective: string;
  step2Objective: string;
  verifiedEntities: {
    jobIds: string[];
    matchAnalysisIds: string[];
    resumeVersionIds: string[];
    outcomes: Array<{ tool: string; status: string }>;
  };
};

export function readMessageMetadata(
  message: { metadata?: unknown } | null | undefined,
): UnifiedMessageMetadata | null {
  const raw = message?.metadata;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return raw as UnifiedMessageMetadata;
}

export function readMessageAgentRole(
  message: { metadata?: unknown } | null | undefined,
  fallback?: AgentRole | null,
): AgentRole | null {
  const meta = readMessageMetadata(message);
  if (meta && isAgentRole(meta.agentRole)) return meta.agentRole;
  return fallback && isAgentRole(fallback) ? fallback : null;
}

export function roleAttributionTag(role: AgentRole | null | undefined): string {
  switch (role) {
    case "pilot":
      return "[执行助手 Pilot]";
    case "insight":
      return "[职业顾问 Insight]";
    case "reflect":
      return "[复盘教练 Reflect]";
    default:
      return "";
  }
}

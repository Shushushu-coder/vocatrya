/**
 * Agent long-task templates (code constants).
 *
 * First template: INTERVIEW_SPRINT (面试冲刺), anchored on a JobOpportunity
 * and reusing the INTERVIEW-PREP-CONTINUITY entities (InterviewPrepGoal,
 * pinned JD version, InterviewSession progress) as evidence pointers.
 *
 * This file only DEFINES the template data and the derivation contract
 * types. Milestone derivation / acceptance evaluation logic (reading the
 * domain entities) belongs to card C; nothing here touches the database or a
 * model. `passes` is default-FAIL and may only ever be flipped by code.
 */

export const AGENT_TASK_TEMPLATE_KEY = {
  INTERVIEW_SPRINT: "INTERVIEW_SPRINT",
} as const;
export type AgentTaskTemplateKey =
  (typeof AGENT_TASK_TEMPLATE_KEY)[keyof typeof AGENT_TASK_TEMPLATE_KEY];

export function isAgentTaskTemplateKey(
  value: unknown,
): value is AgentTaskTemplateKey {
  return (
    typeof value === "string" &&
    (Object.values(AGENT_TASK_TEMPLATE_KEY) as string[]).includes(value)
  );
}

/** Which kind of domain entity an acceptance item's evidenceRef must name. */
export const ACCEPTANCE_EVIDENCE_KIND = {
  INTERVIEW_PREP_GOAL: "INTERVIEW_PREP_GOAL",
  MATCH_ANALYSIS: "MATCH_ANALYSIS",
  INTERVIEW_SESSION: "INTERVIEW_SESSION",
} as const;
export type AcceptanceEvidenceKind =
  (typeof ACCEPTANCE_EVIDENCE_KIND)[keyof typeof ACCEPTANCE_EVIDENCE_KIND];

export interface AcceptanceItemDefinition {
  key: string;
  label: string;
  /** Entity kind card C's evaluator must verify before flipping `passes`. */
  evidenceKind: AcceptanceEvidenceKind;
}

/** Persisted shape of one acceptance item (AgentTask.acceptanceItems JSON). */
export interface AgentTaskAcceptanceItem {
  key: string;
  label: string;
  passes: boolean;
  /** Entity id (or operationKey); absent while the item is unproven. */
  evidenceRef?: string;
}

export interface AgentTaskTemplate {
  key: AgentTaskTemplateKey;
  titlePrefix: string;
  /** Ordered milestone keys; the first one is the initial milestone. */
  milestones: readonly string[];
  /** Terminal milestone; reaching it is card C's call, never a model's. */
  doneMilestone: string;
  acceptanceItems: readonly AcceptanceItemDefinition[];
}

export const INTERVIEW_SPRINT_MILESTONE = {
  PREPARING: "PREPARING",
  PRACTICING: "PRACTICING",
  REVIEWING: "REVIEWING",
  DONE: "DONE",
} as const;

export const INTERVIEW_SPRINT_TEMPLATE: AgentTaskTemplate = {
  key: AGENT_TASK_TEMPLATE_KEY.INTERVIEW_SPRINT,
  titlePrefix: "面试冲刺",
  milestones: [
    INTERVIEW_SPRINT_MILESTONE.PREPARING,
    INTERVIEW_SPRINT_MILESTONE.PRACTICING,
    INTERVIEW_SPRINT_MILESTONE.REVIEWING,
    INTERVIEW_SPRINT_MILESTONE.DONE,
  ],
  doneMilestone: INTERVIEW_SPRINT_MILESTONE.DONE,
  acceptanceItems: [
    {
      key: "prep-goal-active",
      label: "已建立面试准备目标并固定 JD 版本",
      evidenceKind: ACCEPTANCE_EVIDENCE_KIND.INTERVIEW_PREP_GOAL,
    },
    {
      key: "jd-fit-reviewed",
      label: "已完成岗位匹配分析且未失效",
      evidenceKind: ACCEPTANCE_EVIDENCE_KIND.MATCH_ANALYSIS,
    },
    {
      key: "mock-session-1",
      label: "已完成至少一轮模拟面试作答",
      evidenceKind: ACCEPTANCE_EVIDENCE_KIND.INTERVIEW_SESSION,
    },
    {
      key: "session-summary-reviewed",
      label: "已复盘模拟面试总结与薄弱点",
      evidenceKind: ACCEPTANCE_EVIDENCE_KIND.INTERVIEW_SESSION,
    },
  ],
};

const TEMPLATES: Record<AgentTaskTemplateKey, AgentTaskTemplate> = {
  INTERVIEW_SPRINT: INTERVIEW_SPRINT_TEMPLATE,
};

export function getAgentTaskTemplate(key: AgentTaskTemplateKey): AgentTaskTemplate {
  return TEMPLATES[key];
}

export function initialMilestoneFor(key: AgentTaskTemplateKey): string {
  return TEMPLATES[key].milestones[0];
}

/** Default-FAIL checklist: every item unproven, no evidence. */
export function buildInitialAcceptanceItems(
  key: AgentTaskTemplateKey,
): AgentTaskAcceptanceItem[] {
  return TEMPLATES[key].acceptanceItems.map((item) => ({
    key: item.key,
    label: item.label,
    passes: false,
  }));
}

/**
 * Tolerant parse of the persisted checklist. Malformed JSON or malformed
 * entries read as "no items" / are skipped — never as passing.
 */
export function parseAcceptanceItems(
  serialized: string | null | undefined,
): AgentTaskAcceptanceItem[] {
  if (!serialized) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  const items: AgentTaskAcceptanceItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { key, label, passes, evidenceRef } = entry as Record<string, unknown>;
    if (typeof key !== "string" || typeof label !== "string") continue;
    items.push({
      key,
      label,
      // Default-FAIL: only a literal true counts, and never without evidence.
      passes: passes === true && typeof evidenceRef === "string" && evidenceRef !== "",
      ...(typeof evidenceRef === "string" && evidenceRef !== "" ? { evidenceRef } : {}),
    });
  }
  return items;
}

/* ---- Card C contract stubs (types only; no derivation logic here) ---- */

/** Domain facts card C will load (ownership-scoped) to derive a milestone. */
export interface TaskMilestoneDerivationInput {
  templateKey: AgentTaskTemplateKey;
  currentMilestone: string;
  jobOpportunityId: string | null;
  interviewPrepGoalId: string | null;
  acceptanceItems: readonly AgentTaskAcceptanceItem[];
}

export interface TaskMilestoneDerivation {
  /** Same as input.currentMilestone when no transition is warranted. */
  milestone: string;
  acceptanceItems: AgentTaskAcceptanceItem[];
}

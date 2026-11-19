import {
  FACT_SLOTS,
  RESUME_EVIDENCE_SKILL_ID,
  parseResumeEvidenceDraftText,
  type ResumeEvidenceDraft,
} from "./contract";
import {
  createResumeEvidenceFlowState,
  evaluateSufficiency,
  selectFocus,
  type ResumeEvidenceFlowState,
  type SlotStatus,
} from "./flow";
import { slotRoleFor } from "../../agentRoles";
import { buildResumeEvidenceInstructions } from "./prompt";

// Multi-turn skill mode (contract §10.2) with NO new persistence: the run is
// derived from the conversation's own message history. Start = the user
// message carrying the authorization pack; state = the latest valid draft the
// assistant emitted after it. The conversation row already persists both.

/** First line of the authorization message (see buildResumeEvidenceAuthorizationMessage). */
export const RESUME_EVIDENCE_PACK_MARKER = "【本次授权包：仅限这一段经历】";

type MessageLike = {
  role?: string;
  parts?: Array<{ type?: string; text?: string }>;
};

function textOf(message: MessageLike): string {
  return (message.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text ?? "")
    .join("\n");
}

export interface ResumeEvidenceSession {
  active: boolean;
  /** Index of the user message that carries the authorization pack, or -1. */
  packIndex: number;
  /** Latest draft that passed validation after the pack, if any. */
  lastDraft: ResumeEvidenceDraft | null;
  /** roundIndex of the latest summarizing draft (0 when none). */
  lastSummaryRound: number;
}

export function deriveResumeEvidenceSession(
  messages: readonly MessageLike[],
): ResumeEvidenceSession {
  let packIndex = -1;
  messages.forEach((m, i) => {
    if (
      m.role === "user" &&
      textOf(m).trimStart().startsWith(RESUME_EVIDENCE_PACK_MARKER)
    ) {
      packIndex = i;
    }
  });
  if (packIndex < 0) {
    return { active: false, packIndex, lastDraft: null, lastSummaryRound: 0 };
  }
  let lastDraft: ResumeEvidenceDraft | null = null;
  let lastSummaryRound = 0;
  for (let i = packIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const text = textOf(m);
    if (!text.includes(RESUME_EVIDENCE_SKILL_ID)) continue;
    const parsed = parseResumeEvidenceDraftText(text);
    if (!parsed.ok) continue;
    lastDraft = parsed.draft;
    if (parsed.draft.session.stage === "summarizing") {
      lastSummaryRound = parsed.draft.session.roundIndex;
    }
  }
  // A stopped run hands the conversation back to normal Pilot.
  const active = lastDraft?.session.stage !== "stopped";
  return { active, packIndex, lastDraft, lastSummaryRound };
}

/** Slot statuses implied by a draft: confirmed facts / skips / pending-open. */
export function flowStateFromDraft(
  draft: ResumeEvidenceDraft,
  lastSummaryRound = 0,
): ResumeEvidenceFlowState {
  const state = createResumeEvidenceFlowState();
  const statusOf = (slot: (typeof FACT_SLOTS)[number]): SlotStatus => {
    if (draft.confirmedFacts.some((f) => f.slot === slot)) return "confirmed";
    if (draft.skipped.some((s) => s.slot === slot)) return "skipped";
    return "open";
  };
  const withDerived = (
    slot: "personal_contribution" | "action" | "result",
  ): SlotStatus => {
    const base = statusOf(slot);
    if (base !== "open") return base;
    if (slot === "personal_contribution" && draft.contributions.length > 0)
      return "confirmed";
    if (slot === "action" && draft.actions.length > 0) return "confirmed";
    if (slot === "result" && draft.outcomes.length > 0) return "confirmed";
    return "open";
  };
  const optional: ResumeEvidenceFlowState["optional"] = {};
  for (const slot of ["difficulty", "evidence_pointer", "jd_relevance"] as const) {
    const s = statusOf(slot);
    if (s !== "open") optional[slot] = s;
    else if (draft.pending.some((p) => p.slot === slot)) optional[slot] = "open";
  }
  return {
    ...state,
    stage: draft.session.stage,
    roundIndex: draft.session.roundIndex,
    roundsSinceSummary: Math.max(0, draft.session.roundIndex - lastSummaryRound),
    openConflicts: draft.conflicts.filter((c) => c.resolution === "open").length,
    personalContribution: withDerived("personal_contribution"),
    action: withDerived("action"),
    result: withDerived("result"),
    timeRange: statusOf("time_range"),
    optional,
  };
}

function stateBlock(session: ResumeEvidenceSession): string {
  const draft = session.lastDraft;
  if (!draft) {
    return "【技能运行状态】尚无已校验的草稿：这是第一轮。按 stage=intake 处理，不要假设任何点已确认或已跳过。";
  }
  const state = flowStateFromDraft(draft, session.lastSummaryRound);
  const sufficiency = evaluateSufficiency(state);
  const focus = selectFocus(state);
  return [
    "【技能运行状态】由上一份已校验草稿推导，仅供对照；上一份草稿是权威状态。",
    `stage=${state.stage}；roundIndex=${state.roundIndex}；自上次总结起已问 ${state.roundsSinceSummary} 轮；未解决冲突 ${state.openConflicts} 处。`,
    `个人贡献=${state.personalContribution}；行动=${state.action}；结果=${state.result}；时间=${state.timeRange}。`,
    `停止条件${sufficiency.met ? "已满足" : `未满足，缺：${sufficiency.missingSlots.join("、")}`}；按顺序下一个重点：${focus ?? "无"}。`,
    "沿用上一份草稿里已确认、已跳过和冲突的内容，每次输出完整的最新草稿；不要重问已确认或已跳过的点。",
  ].join("\n");
}

/**
 * System-prompt addendum for the Pilot role while a Resume Evidence run is
 * active. Returns "" in every other case, so normal turns are byte-for-byte
 * unchanged. Hosted by Pilot only (contract D1).
 */
export function buildResumeEvidencePromptAddendum(input: {
  messages: readonly MessageLike[];
  agentRole: string | null | undefined;
}): string {
  // Match the UI: legacy NULL-role conversations live in the Pilot slot and
  // show the entry, so they host the skill too (prompt-only, no tool change).
  if (slotRoleFor(input.agentRole) !== "pilot") return "";
  const session = deriveResumeEvidenceSession(input.messages);
  if (!session.active) return "";
  return [
    "",
    "",
    "【已启用技能：简历证据深挖】本会话正处于该技能的运行中。在这个会话里，这一技能的规则优先于你日常的工作台职责；你仍然没有任何写入能力，也不调用任何工具来保存。",
    buildResumeEvidenceInstructions(),
    stateBlock(session),
  ].join("\n");
}

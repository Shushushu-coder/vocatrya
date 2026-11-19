import {
  RESUME_EVIDENCE_CONTRACT_VERSION,
  RESUME_EVIDENCE_MAX_CLARIFY_ROUNDS,
  RESUME_EVIDENCE_SKILL_ID,
  RESUME_EVIDENCE_SKILL_VERSION,
  USER_CONTROLS,
  authorizationPackSchema,
  type FOCUS_SLOTS,
  type ResumeEvidenceAuthorizationPack,
  type ResumeEvidenceDraft,
  type STAGES,
  type STOP_REASONS,
} from "./contract";

// Deterministic flow rules of the Resume Evidence skill (contract §4):
// focus ordering, stop sufficiency, stage transitions, question budget.
// The model fills slot statuses from the conversation; these helpers decide
// what is asked next and when stopping is allowed. Nothing here persists.

export type FocusSlot = (typeof FOCUS_SLOTS)[number];
export type ResumeEvidenceStage = (typeof STAGES)[number];
export type ResumeEvidenceStopReason = (typeof STOP_REASONS)[number];
export type SlotStatus = "open" | "confirmed" | "skipped";

type OptionalSlot = "difficulty" | "evidence_pointer" | "jd_relevance";

export interface ResumeEvidenceFlowState {
  stage: ResumeEvidenceStage;
  /** Clarifying questions issued so far (session.roundIndex). */
  roundIndex: number;
  /** Rounds issued since the last stage summary (drives the 6-round cap). */
  roundsSinceSummary: number;
  openConflicts: number;
  personalContribution: SlotStatus;
  action: SlotStatus;
  result: SlotStatus;
  timeRange: SlotStatus;
  /** Optional slots are asked only when flagged relevant and still open. */
  optional: Partial<Record<OptionalSlot, SlotStatus>>;
  /** True while ownership of a result is still unclear (allows a 2nd question). */
  contributionUnclear: boolean;
}

export type ResumeEvidenceIntent =
  | { type: "answer" }
  | { type: "skip" }
  | { type: "correct" }
  | { type: "change_focus"; focus: FocusSlot }
  | { type: "summary" }
  | { type: "continue"; focus?: FocusSlot }
  | { type: "stop" };

export interface ResumeEvidencePlan {
  stage: ResumeEvidenceStage;
  stopReason: ResumeEvidenceStopReason | null;
  roundIndex: number;
  roundsSinceSummary: number;
  focus: FocusSlot | null;
  sufficiency: { met: boolean; missingSlots: string[] };
  recommendation: "ask" | "summarize" | "offer_stop" | "hand_to_user";
  questionBudget: 0 | 1 | 2;
}

export function createResumeEvidenceFlowState(): ResumeEvidenceFlowState {
  return {
    stage: "intake",
    roundIndex: 0,
    roundsSinceSummary: 0,
    openConflicts: 0,
    personalContribution: "open",
    action: "open",
    result: "open",
    timeRange: "open",
    optional: {},
    contributionUnclear: false,
  };
}

const resolved = (s: SlotStatus | undefined) =>
  s === "confirmed" || s === "skipped";

/** Slots still blocking a sufficient stop (evidence pointer never blocks). */
export function missingStopSlots(state: ResumeEvidenceFlowState): string[] {
  const missing: string[] = [];
  if (!resolved(state.personalContribution)) missing.push("personal_contribution");
  if (!resolved(state.action)) missing.push("action");
  if (!resolved(state.result)) missing.push("result");
  if (!resolved(state.timeRange)) missing.push("time_range");
  return missing;
}

export function evaluateSufficiency(state: ResumeEvidenceFlowState): {
  met: boolean;
  missingSlots: string[];
} {
  const missingSlots = missingStopSlots(state);
  if (state.openConflicts > 0) {
    // An open conflict blocks sufficiency even if every slot is resolved.
    return { met: false, missingSlots: ["conflict", ...missingSlots] };
  }
  return { met: missingSlots.length === 0, missingSlots };
}

/** First unresolved slot in contract §4.1 order, or null when none remain. */
export function selectFocus(state: ResumeEvidenceFlowState): FocusSlot | null {
  if (state.openConflicts > 0) return "conflict";
  if (!resolved(state.personalContribution)) return "personal_contribution";
  if (!resolved(state.action)) return "action";
  if (!resolved(state.result)) return "result";
  if (state.optional.difficulty === "open") return "difficulty";
  if (!resolved(state.timeRange)) return "time_range";
  if (state.optional.evidence_pointer === "open") return "evidence_pointer";
  if (state.optional.jd_relevance === "open") return "jd_relevance";
  return null;
}

function budgetFor(
  focus: FocusSlot | null,
  state: ResumeEvidenceFlowState,
): 0 | 1 | 2 {
  if (focus === null) return 0;
  return focus === "personal_contribution" && state.contributionUnclear ? 2 : 1;
}

function stopped(state: ResumeEvidenceFlowState): ResumeEvidencePlan {
  const sufficiency = evaluateSufficiency(state);
  return {
    stage: "stopped",
    stopReason: sufficiency.met ? "sufficient" : "insufficient_user_stop",
    roundIndex: state.roundIndex,
    roundsSinceSummary: state.roundsSinceSummary,
    focus: null,
    sufficiency,
    recommendation: "hand_to_user",
    questionBudget: 0,
  };
}

/**
 * Plan the next skill turn after a user event. The caller has already applied
 * the user's answer to `state` (slot statuses, conflicts). Pure: returns the
 * next plan and never mutates `state`.
 */
export function planResumeEvidenceTurn(
  state: ResumeEvidenceFlowState,
  intent: ResumeEvidenceIntent,
): ResumeEvidencePlan {
  if (state.stage === "stopped" && intent.type !== "correct") {
    return stopped(state);
  }
  if (intent.type === "stop") return stopped(state);

  const sufficiency = evaluateSufficiency(state);

  const summarizing = (): ResumeEvidencePlan => ({
    stage: "summarizing",
    stopReason: null,
    roundIndex: state.roundIndex,
    roundsSinceSummary: 0,
    focus: null,
    sufficiency,
    recommendation: "summarize",
    questionBudget: 0,
  });
  if (intent.type === "summary") return summarizing();

  const ask = (focus: FocusSlot): ResumeEvidencePlan => ({
    stage: "clarifying",
    stopReason: null,
    roundIndex: state.roundIndex + 1,
    roundsSinceSummary: state.roundsSinceSummary + 1,
    focus,
    sufficiency,
    recommendation: "ask",
    questionBudget: budgetFor(focus, state),
  });

  // Explicit redirect from the user: honour it, rounds still count.
  if (intent.type === "change_focus") return ask(intent.focus);
  if (intent.type === "continue" && intent.focus) return ask(intent.focus);

  // Answer/skip/correction: a new conflict always wins over stopping.
  const focus = selectFocus(state);

  if (focus === null && sufficiency.met) {
    return {
      stage: "ready_to_stop",
      stopReason: null,
      roundIndex: state.roundIndex,
      roundsSinceSummary: state.roundsSinceSummary,
      focus: null,
      sufficiency,
      recommendation: "offer_stop",
      questionBudget: 0,
    };
  }

  if (state.roundsSinceSummary >= RESUME_EVIDENCE_MAX_CLARIFY_ROUNDS) {
    return summarizing();
  }

  // focus === null with unmet sufficiency cannot happen (every unresolved stop
  // slot yields a focus), but never emit an ask without a focus.
  if (focus === null) return stopped(state);
  return ask(focus);
}

export function isIntakeEmpty(pack: ResumeEvidenceAuthorizationPack): boolean {
  return pack.experienceText.trim() === "" && pack.existingMaterial === null;
}

/** First plan of a run, from the authorization pack. */
export function startResumeEvidenceRun(
  pack: ResumeEvidenceAuthorizationPack,
): ResumeEvidencePlan {
  const sufficiency = evaluateSufficiency(createResumeEvidenceFlowState());
  const empty = isIntakeEmpty(pack);
  // Empty: ask only for the single experience, then wait. Otherwise intake
  // restates scope; the first clarifying question comes on the next turn.
  return {
    stage: "intake",
    stopReason: null,
    roundIndex: 0,
    roundsSinceSummary: 0,
    focus: null,
    sufficiency,
    recommendation: empty ? "ask" : "hand_to_user",
    questionBudget: empty ? 1 : 0,
  };
}

export type AuthorizationPackResult =
  | { ok: true; pack: ResumeEvidenceAuthorizationPack }
  | { ok: false; errors: string[] };

/** Validate the single-experience pack handed over by the runtime. */
export function parseAuthorizationPack(value: unknown): AuthorizationPackResult {
  const parsed = authorizationPackSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
      ),
    };
  }
  const pack = parsed.data;
  return {
    ok: true,
    pack: {
      ...pack,
      targetJdText: pack.targetJdText?.trim() ? pack.targetJdText : null,
    },
  };
}

/**
 * Skeleton draft for a fresh run: authorization restated, source refs from the
 * pack, nothing confirmed, draft-only mapping. The model refreshes it per turn.
 */
export function createInitialResumeEvidenceDraft(
  pack: ResumeEvidenceAuthorizationPack,
): ResumeEvidenceDraft {
  const sourceRefs: ResumeEvidenceDraft["sourceRefs"] = [];
  if (pack.experienceText.trim()) {
    sourceRefs.push({
      ref: "src-paste",
      kind: "pasted_text",
      label: "用户提供的经历",
      stableId: null,
      excerpt: pack.experienceText.trim(),
    });
  }
  const material = pack.existingMaterial;
  if (material) {
    sourceRefs.push({
      ref: "src-material",
      kind: "existing_material",
      label: "用户点名的已有素材",
      stableId: material.id,
      excerpt: material.title ?? "",
    });
    (material.evidence ?? []).forEach((e, i) => {
      sourceRefs.push({
        ref: `src-evidence-${i + 1}`,
        kind: "existing_evidence",
        label: "已有证据",
        stableId: e.id,
        excerpt: e.content,
      });
    });
  }
  const jd = pack.targetJdText?.trim() ? pack.targetJdText.trim() : null;
  if (jd) {
    sourceRefs.push({
      ref: "src-jd",
      kind: "optional_jd",
      label: "目标岗位说明",
      stableId: null,
      excerpt: jd,
    });
  }

  const start = startResumeEvidenceRun(pack);
  return {
    contractVersion: RESUME_EVIDENCE_CONTRACT_VERSION,
    skillId: RESUME_EVIDENCE_SKILL_ID,
    skillVersion: RESUME_EVIDENCE_SKILL_VERSION,
    artifactKind: "skill_result_draft",
    exampleKind: "model_output",
    session: {
      stage: start.stage,
      stopReason: null,
      roundIndex: 0,
      focus: null,
      sufficiency: {
        met: false,
        missingSlots: start.sufficiency
          .missingSlots as ResumeEvidenceDraft["session"]["sufficiency"]["missingSlots"],
      },
    },
    authorization: {
      scope: "single_experience",
      fullLibraryScanned: false,
      purpose: pack.purpose,
      targetJdRef: jd ? "src-jd" : null,
    },
    sourceRefs,
    confirmedFacts: [],
    pending: [],
    conflicts: [],
    contributions: [],
    actions: [],
    outcomes: [],
    suggestedExpressions: [],
    assumptions: [],
    skipped: [],
    materialMapping: {
      operation: "draft_only",
      careerMaterialItemId: material?.id ?? null,
      type: material?.type ?? null,
      parent: {
        title: null,
        startDate: null,
        endDate: null,
        isCurrent: null,
        notes: null,
      },
      detail: {},
      evidenceToAdd: [],
      blockedWrites: [
        { code: "DRAFT_ONLY_V1", message: "首版只产出草稿，不执行保存。" },
      ],
      verificationStatusOnWrite: "USER_AUTHORED",
      originOnWrite: "USER",
      callsExistingEntrypoints: [],
      futureOperation: "draft_only",
      futureEntrypoints: [],
    },
    saveGate: {
      wordingAccepted: false,
      saveAuthorized: false,
      persisted: false,
      mustConfirmBeforeSave: ["首版不保存；将来保存需应用单独确认。"],
    },
    next: {
      recommendation: start.recommendation === "ask" ? "ask" : "hand_to_user",
      questionBudget: start.questionBudget,
      userControls: [...USER_CONTROLS],
    },
  };
}

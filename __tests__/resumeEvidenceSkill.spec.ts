import {
  RESUME_EVIDENCE_SKILL_ID,
  RESUME_EVIDENCE_SKILL_VERSION,
  buildResumeEvidenceAuthorizationMessage,
  buildResumeEvidenceInstructions,
  buildResumeEvidenceSkillContent,
  createInitialResumeEvidenceDraft,
  createResumeEvidenceFlowState,
  evaluateSufficiency,
  parseAuthorizationPack,
  parseResumeEvidenceDraftText,
  planResumeEvidenceTurn,
  selectFocus,
  startResumeEvidenceRun,
  validateResumeEvidenceDraft,
  RESUME_EVIDENCE_PROMPT_SECTIONS,
  RESUME_EVIDENCE_TEMPLATES,
  type ResumeEvidenceAuthorizationPack,
  type ResumeEvidenceFlowState,
} from "@/lib/agent/skills/resumeEvidence";

function pack(
  over: Partial<ResumeEvidenceAuthorizationPack> = {},
): ResumeEvidenceAuthorizationPack {
  return {
    skillId: RESUME_EVIDENCE_SKILL_ID,
    skillVersion: RESUME_EVIDENCE_SKILL_VERSION,
    experienceText: "2024 年暑期我在北海市集科技做青禾超市履约小程序。",
    existingMaterial: null,
    purpose: "resume_bullet",
    targetJdText: null,
    ...over,
  };
}

function state(over: Partial<ResumeEvidenceFlowState> = {}): ResumeEvidenceFlowState {
  return { ...createResumeEvidenceFlowState(), stage: "clarifying", ...over };
}

// Design-example 12.1 shape (synthetic data from the contract).
function sufficientDraft(): Record<string, unknown> {
  return {
    contractVersion: "resume-evidence-result/v0.1",
    skillId: RESUME_EVIDENCE_SKILL_ID,
    skillVersion: RESUME_EVIDENCE_SKILL_VERSION,
    artifactKind: "skill_result_draft",
    exampleKind: "design_example",
    session: {
      stage: "stopped",
      stopReason: "sufficient",
      roundIndex: 1,
      focus: null,
      sufficiency: { met: true, missingSlots: [] },
    },
    authorization: {
      scope: "single_experience",
      fullLibraryScanned: false,
      purpose: "resume_bullet",
      targetJdRef: null,
    },
    sourceRefs: [
      { ref: "src-paste", kind: "pasted_text", label: "粘贴", stableId: null, excerpt: "做青禾超市履约小程序。" },
      { ref: "src-turn-1", kind: "user_turn", label: "补充", stableId: null, excerpt: "复核规则和值班表是我写的。" },
    ],
    confirmedFacts: [
      { id: "fact-action", text: "用户本人编写了复核规则和值班表。", slot: "action", epistemic: "user_stated", sourceRefs: ["src-turn-1"], attribution: "personal" },
      { id: "fact-metric", text: "超时订单从每天大约 40 单降到 10 单以内。", slot: "metric", epistemic: "user_stated", sourceRefs: ["src-turn-1"], attribution: "mixed" },
    ],
    pending: [],
    conflicts: [],
    contributions: [],
    actions: [
      { id: "action-1", statement: "编写复核规则和值班表。", actor: "personal", sourceRefs: ["src-turn-1"], epistemic: "user_stated" },
    ],
    outcomes: [
      { id: "outcome-1", statement: "超时订单降到 10 单以内。", quantified: true, metricText: "每天大约 40 单降到 10 单以内", attribution: "mixed", sourceRefs: ["src-turn-1"], epistemic: "user_stated" },
    ],
    suggestedExpressions: [
      { id: "expr-1", text: "编写复核规则和值班表，超时订单降到 10 单以内。", basisFactIds: ["fact-action", "fact-metric"], epistemic: "suggested_wording", userAcceptedWording: false, saveAuthorized: false },
    ],
    assumptions: [],
    skipped: [],
    materialMapping: {
      operation: "draft_only",
      careerMaterialItemId: null,
      type: "INTERNSHIP",
      parent: { title: "北海市集科技", startDate: null, endDate: null, isCurrent: false, notes: null },
      detail: { organizationName: "北海市集科技" },
      evidenceToAdd: [
        { content: "用户本人编写了复核规则和值班表。", metricText: null, kindOnWrite: "FACT", semanticRole: "action", basisFactIds: ["fact-action"], userAcceptedAsEvidence: false },
      ],
      blockedWrites: [],
      verificationStatusOnWrite: "USER_AUTHORED",
      originOnWrite: "USER",
      callsExistingEntrypoints: [],
      futureOperation: "create_new",
      futureEntrypoints: ["createApplicationMaterial", "addApplicationMaterialEvidence"],
    },
    saveGate: { wordingAccepted: false, saveAuthorized: false, persisted: false, mustConfirmBeforeSave: [] },
    next: { recommendation: "hand_to_user", questionBudget: 0, userControls: ["纠正"] },
  };
}

function mutate(fn: (d: any) => void) {
  const d = sufficientDraft() as any;
  fn(d);
  return validateResumeEvidenceDraft(d);
}

describe("resume evidence flow", () => {
  it("orders focus per contract 4.1 and skips resolved slots", () => {
    expect(selectFocus(state())).toBe("personal_contribution");
    expect(selectFocus(state({ personalContribution: "confirmed" }))).toBe("action");
    expect(
      selectFocus(state({ personalContribution: "skipped", action: "confirmed" })),
    ).toBe("result");
    expect(selectFocus(state({ openConflicts: 1 }))).toBe("conflict");
    const base = {
      personalContribution: "confirmed",
      action: "confirmed",
      result: "confirmed",
    } as const;
    expect(selectFocus(state({ ...base, optional: { difficulty: "open" } }))).toBe(
      "difficulty",
    );
    expect(selectFocus(state({ ...base }))).toBe("time_range");
    expect(
      selectFocus(
        state({ ...base, timeRange: "confirmed", optional: { jd_relevance: "open" } }),
      ),
    ).toBe("jd_relevance");
  });

  it("does not require an evidence pointer or a metric to stop", () => {
    const s = state({
      personalContribution: "confirmed",
      action: "confirmed",
      result: "confirmed",
      timeRange: "skipped",
      optional: { evidence_pointer: "open" },
    });
    expect(evaluateSufficiency(s)).toEqual({ met: true, missingSlots: [] });
  });

  it("open conflicts block sufficiency", () => {
    const s = state({
      personalContribution: "confirmed",
      action: "confirmed",
      result: "confirmed",
      timeRange: "confirmed",
      openConflicts: 1,
    });
    expect(evaluateSufficiency(s).met).toBe(false);
    const plan = planResumeEvidenceTurn(s, { type: "answer" });
    expect(plan.stage).toBe("clarifying");
    expect(plan.focus).toBe("conflict");
    expect(planResumeEvidenceTurn(s, { type: "stop" }).stopReason).toBe(
      "insufficient_user_stop",
    );
  });

  it("asks one question by default and two only to split personal vs team", () => {
    const plain = planResumeEvidenceTurn(state(), { type: "answer" });
    expect(plain.questionBudget).toBe(1);
    const split = planResumeEvidenceTurn(state({ contributionUnclear: true }), {
      type: "answer",
    });
    expect(split.focus).toBe("personal_contribution");
    expect(split.questionBudget).toBe(2);
    const other = planResumeEvidenceTurn(
      state({ personalContribution: "confirmed", contributionUnclear: true }),
      { type: "answer" },
    );
    expect(other.focus).toBe("action");
    expect(other.questionBudget).toBe(1);
  });

  it("offers a stop when conditions are met, and stops as sufficient", () => {
    const s = state({
      personalContribution: "confirmed",
      action: "confirmed",
      result: "skipped",
      timeRange: "confirmed",
    });
    const plan = planResumeEvidenceTurn(s, { type: "answer" });
    expect(plan).toMatchObject({
      stage: "ready_to_stop",
      stopReason: null,
      recommendation: "offer_stop",
      questionBudget: 0,
    });
    expect(planResumeEvidenceTurn(s, { type: "stop" })).toMatchObject({
      stage: "stopped",
      stopReason: "sufficient",
      focus: null,
    });
  });

  it("user stop with missing slots is insufficient and lists them", () => {
    const plan = planResumeEvidenceTurn(
      state({ personalContribution: "confirmed", action: "confirmed" }),
      { type: "stop" },
    );
    expect(plan.stopReason).toBe("insufficient_user_stop");
    expect(plan.sufficiency).toEqual({
      met: false,
      missingSlots: ["result", "time_range"],
    });
  });

  it("skipping the metric does not skip the result", () => {
    // result stays open: skip of metric is a separate slot not tracked here.
    expect(selectFocus(state({ personalContribution: "skipped", action: "skipped" }))).toBe(
      "result",
    );
  });

  it("forces a summary after 6 clarifying rounds, then lets the user continue", () => {
    const capped = state({ roundIndex: 6, roundsSinceSummary: 6 });
    const plan = planResumeEvidenceTurn(capped, { type: "answer" });
    expect(plan).toMatchObject({
      stage: "summarizing",
      questionBudget: 0,
      recommendation: "summarize",
      roundsSinceSummary: 0,
    });
    const next = planResumeEvidenceTurn(
      { ...capped, stage: "summarizing", roundsSinceSummary: 0 },
      { type: "continue", focus: "result" },
    );
    expect(next).toMatchObject({ stage: "clarifying", focus: "result", roundIndex: 7 });
  });

  it("5 rounds still ask; round count increments per question", () => {
    const plan = planResumeEvidenceTurn(
      state({ roundIndex: 5, roundsSinceSummary: 5 }),
      { type: "answer" },
    );
    expect(plan.stage).toBe("clarifying");
    expect(plan.roundIndex).toBe(6);
  });

  it("summary request never adds a question; change_focus keeps other slots", () => {
    const s = state({ personalContribution: "confirmed" });
    expect(planResumeEvidenceTurn(s, { type: "summary" })).toMatchObject({
      stage: "summarizing",
      questionBudget: 0,
      focus: null,
    });
    const moved = planResumeEvidenceTurn(s, { type: "change_focus", focus: "time_range" });
    expect(moved.focus).toBe("time_range");
    expect(s.personalContribution).toBe("confirmed");
  });

  it("a correction after stop reopens clarifying via conflict focus", () => {
    const plan = planResumeEvidenceTurn(
      state({ stage: "stopped", openConflicts: 1 }),
      { type: "correct" },
    );
    expect(plan).toMatchObject({ stage: "clarifying", focus: "conflict" });
  });

  it("intake: empty input asks only for the experience; otherwise restates scope", () => {
    expect(startResumeEvidenceRun(pack({ experienceText: "  " }))).toMatchObject({
      stage: "intake",
      recommendation: "ask",
      questionBudget: 1,
    });
    expect(startResumeEvidenceRun(pack())).toMatchObject({
      stage: "intake",
      focus: null,
      questionBudget: 0,
    });
  });
});

describe("authorization pack and initial draft", () => {
  it("validates the pack and normalizes a blank JD to null", () => {
    const ok = parseAuthorizationPack(pack({ targetJdText: "   " }));
    expect(ok.ok && ok.pack.targetJdText).toBeNull();
    expect(parseAuthorizationPack({ ...pack(), purpose: "nope" }).ok).toBe(false);
    expect(parseAuthorizationPack({ ...pack(), skillVersion: "9" }).ok).toBe(false);
  });

  it("builds a valid draft-only skeleton with source refs and no confirmed facts", () => {
    const draft = createInitialResumeEvidenceDraft(
      pack({
        targetJdText: "负责履约系统",
        existingMaterial: {
          id: "m1",
          type: "INTERNSHIP",
          title: "青禾",
          evidence: [{ id: "e1", kind: "FACT", content: "做了小程序" }],
        },
      }),
    );
    expect(validateResumeEvidenceDraft(draft)).toEqual({ ok: true, draft });
    expect(draft.confirmedFacts).toEqual([]);
    expect(draft.authorization).toMatchObject({
      fullLibraryScanned: false,
      targetJdRef: "src-jd",
    });
    expect(draft.sourceRefs.map((r) => r.kind)).toEqual([
      "pasted_text",
      "existing_material",
      "existing_evidence",
      "optional_jd",
    ]);
    expect(draft.saveGate).toMatchObject({ saveAuthorized: false, persisted: false });
    expect(draft.materialMapping.callsExistingEntrypoints).toEqual([]);
  });
});

describe("resume evidence prompt assembly", () => {
  it("assembles main, stage and result-format sections in order", () => {
    const text = buildResumeEvidenceInstructions();
    const s = RESUME_EVIDENCE_PROMPT_SECTIONS;
    expect(text.indexOf(s.main)).toBe(0);
    expect(text.indexOf(s.stages)).toBeGreaterThan(text.indexOf(s.main));
    expect(text.indexOf(s.resultFormat)).toBeGreaterThan(text.indexOf(s.stages));
  });

  it("carries the contract rules the draft-only first version depends on", () => {
    const text = buildResumeEvidenceInstructions();
    for (const needle of [
      RESUME_EVIDENCE_SKILL_ID,
      "user_stated",
      "suggested_wording",
      "assumption",
      "默认只问一个问题",
      "6 轮",
      "saveAuthorized 和 persisted 必须始终为 false",
      "skill_result_draft",
      "不要索取证件",
      "intake → clarifying → summarizing → ready_to_stop → stopped",
    ]) {
      expect(text).toContain(needle);
    }
  });

  it("does not instruct any write, confirm, archive or tool call", () => {
    const text = buildResumeEvidenceInstructions();
    for (const banned of [
      "confirm()",
      "USER_CONFIRMED",
      "createApplicationMaterial",
      "addApplicationMaterialEvidence",
      "archiveApplicationMaterial",
    ]) {
      expect(text).not.toContain(banned);
    }
  });

  it("builds skill content requiring only multi_turn_user_input", () => {
    const content = buildResumeEvidenceSkillContent();
    expect(content).toMatchObject({
      id: RESUME_EVIDENCE_SKILL_ID,
      version: RESUME_EVIDENCE_SKILL_VERSION,
      requiredCapabilities: ["multi_turn_user_input"],
    });
    expect(content.instructions).toBe(buildResumeEvidenceInstructions());
  });

  it("authorization message includes only the pack, flags a missing JD", () => {
    const msg = buildResumeEvidenceAuthorizationMessage(pack());
    expect(msg).toContain("青禾超市履约小程序");
    expect(msg).toContain("未提供，不要索取");
    expect(msg).not.toContain("existingMaterial");
    const withJd = buildResumeEvidenceAuthorizationMessage(
      pack({ targetJdText: "履约产品实习生" }),
    );
    expect(withJd).toContain("履约产品实习生");
  });

  it("templates render opening, stop line and summary", () => {
    expect(RESUME_EVIDENCE_TEMPLATES.opening(false)).not.toContain("目标岗位说明");
    expect(RESUME_EVIDENCE_TEMPLATES.opening(true)).toContain("目标岗位说明");
    expect(RESUME_EVIDENCE_TEMPLATES.stopLine([])).toContain("可以停在这里");
    expect(RESUME_EVIDENCE_TEMPLATES.stopLine(["result"])).toContain("还缺：result");
    expect(
      RESUME_EVIDENCE_TEMPLATES.summary({
        confirmed: "a",
        pendingOrConflict: "b",
        skipped: "c",
        expression: "d",
        stopLine: "e",
      }),
    ).toContain("这次总结不会自动保存");
  });
});

describe("resume evidence draft validation", () => {
  it("accepts a contract-shaped sufficient draft", () => {
    expect(validateResumeEvidenceDraft(sufficientDraft()).ok).toBe(true);
  });

  it("parses a fenced json block and rejects non-JSON", () => {
    const text = "草稿如下\n```json\n" + JSON.stringify(sufficientDraft()) + "\n```";
    expect(parseResumeEvidenceDraftText(text).ok).toBe(true);
    expect(parseResumeEvidenceDraftText("没有 JSON").ok).toBe(false);
  });

  it.each([
    ["persisted true", (d: any) => (d.saveGate.persisted = true)],
    ["saveAuthorized true", (d: any) => (d.saveGate.saveAuthorized = true)],
    ["expression saveAuthorized true", (d: any) => (d.suggestedExpressions[0].saveAuthorized = true)],
    ["full library scanned", (d: any) => (d.authorization.fullLibraryScanned = true)],
    ["non draft_only operation", (d: any) => (d.materialMapping.operation = "create_new")],
    ["calls an entrypoint", (d: any) => (d.materialMapping.callsExistingEntrypoints = ["createApplicationMaterial"])],
    ["USER_CONFIRMED on write", (d: any) => (d.materialMapping.verificationStatusOnWrite = "USER_CONFIRMED")],
    ["evidence kind not FACT", (d: any) => (d.materialMapping.evidenceToAdd[0].kindOnWrite = "METRIC")],
    ["wrong artifactKind", (d: any) => (d.artifactKind = "career_material")],
    ["assumption as confirmed fact", (d: any) => (d.confirmedFacts[0].epistemic = "assumption")],
    ["fact without source", (d: any) => (d.confirmedFacts[0].sourceRefs = [])],
    ["unknown source ref", (d: any) => (d.confirmedFacts[0].sourceRefs = ["src-ghost"])],
    ["expression basis not a fact", (d: any) => (d.suggestedExpressions[0].basisFactIds = ["fact-ghost"])],
    ["suggestion leaked into evidence", (d: any) => (d.materialMapping.evidenceToAdd[0].content = d.suggestedExpressions[0].text)],
    ["unquantified outcome with metric", (d: any) => ((d.outcomes[0].quantified = false), null)],
    ["sufficient with open conflict", (d: any) => (d.conflicts = [{ id: "c", topic: "t", left: { text: "a", sourceRefs: ["src-paste"] }, right: { text: "b", sourceRefs: ["src-turn-1"] }, resolution: "open" }])],
    ["sufficient but not met", (d: any) => ((d.session.sufficiency = { met: false, missingSlots: ["result"] }), null)],
    ["stopped without reason", (d: any) => (d.session.stopReason = null)],
    ["questions after stop", (d: any) => (d.next.questionBudget = 1)],
    ["EMPLOYMENT not draft_only", (d: any) => ((d.materialMapping.type = "EMPLOYMENT"), null)],
    ["non-ISO date", (d: any) => (d.materialMapping.parent.startDate = "2024-07")],
  ])("rejects: %s", (_name, fn) => {
    expect(mutate(fn).ok).toBe(false);
  });

  it("allows budget 2 only on personal_contribution clarifying", () => {
    const ok = mutate((d) => {
      d.session = {
        stage: "clarifying",
        stopReason: null,
        roundIndex: 1,
        focus: "personal_contribution",
        sufficiency: { met: false, missingSlots: ["personal_contribution"] },
      };
      d.next.questionBudget = 2;
    });
    expect(ok.ok).toBe(true);
    const bad = mutate((d) => {
      d.session = {
        stage: "clarifying",
        stopReason: null,
        roundIndex: 1,
        focus: "result",
        sufficiency: { met: false, missingSlots: ["result"] },
      };
      d.next.questionBudget = 2;
    });
    expect(bad.ok).toBe(false);
  });

  it("keeps an unresolved-contribution draft with empty evidence valid", () => {
    const r = mutate((d) => {
      d.session = {
        stage: "clarifying",
        stopReason: null,
        roundIndex: 1,
        focus: "personal_contribution",
        sufficiency: { met: false, missingSlots: ["personal_contribution", "action"] },
      };
      d.confirmedFacts = [];
      d.suggestedExpressions = [];
      d.materialMapping.evidenceToAdd = [];
      d.actions = [];
      d.outcomes = [];
      d.next = { recommendation: "ask", questionBudget: 2, userControls: [] };
    });
    expect(r.ok).toBe(true);
  });
});

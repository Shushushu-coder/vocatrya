import { AGENT_ROLE_TOOL_ALLOWLIST } from "@/lib/agent/agentRoles";
import {
  RESUME_EVIDENCE_PACK_MARKER,
  RESUME_EVIDENCE_SKILL_ID,
  buildResumeEvidenceAuthorizationMessage,
  buildResumeEvidenceInstructions,
  buildResumeEvidencePromptAddendum,
  buildResumeEvidenceStart,
  createInitialResumeEvidenceDraft,
  deriveResumeEvidenceSession,
  flowStateFromDraft,
  hasResumeEvidenceDraftBlock,
  splitResumeEvidenceDraftText,
  type ResumeEvidenceDraft,
} from "@/lib/agent/skills/resumeEvidence";

const material = {
  id: "mat-1",
  type: "PROJECT",
  title: "Payments rewrite",
  startDate: new Date("2024-01-02T00:00:00.000Z"),
  endDate: null,
  isCurrent: true,
  notes: null,
  evidence: [{ id: "ev-1", kind: "FACT", content: "Led the cutover", metricText: null }],
};

const u = (text: string) => ({ role: "user", parts: [{ type: "text", text }] });
const a = (text: string) => ({ role: "assistant", parts: [{ type: "text", text }] });
const fenced = (d: unknown) => "```json\n" + JSON.stringify(d) + "\n```";

function baseDraft(): ResumeEvidenceDraft {
  const start = buildResumeEvidenceStart({ material, targetJdText: "  " });
  if (!start.ok) throw new Error("setup");
  return createInitialResumeEvidenceDraft(start.pack);
}

describe("Resume Evidence entry (pack building)", () => {
  it("builds the section-3 pack for exactly one material and no JD", () => {
    const r = buildResumeEvidenceStart({ material, targetJdText: "   " });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.existingMaterial?.id).toBe("mat-1");
    expect(r.pack.existingMaterial?.startDate).toBe("2024-01-02");
    expect(r.pack.existingMaterial?.evidence).toHaveLength(1);
    expect(r.pack.targetJdText).toBeNull();
    expect(r.emptyIntake).toBe(false);
    expect(r.message.startsWith(RESUME_EVIDENCE_PACK_MARKER)).toBe(true);
    expect(r.message).toBe(buildResumeEvidenceAuthorizationMessage(r.pack));
  });

  it("carries the optional JD and pasted experience", () => {
    const r = buildResumeEvidenceStart({
      experienceText: " I ran the migration ",
      targetJdText: "Backend engineer",
    });
    expect(r.ok && r.pack.targetJdText).toBe("Backend engineer");
    expect(r.ok && r.message).toContain("I ran the migration");
  });

  it("empty intake takes the module's single-question path", () => {
    const r = buildResumeEvidenceStart({});
    expect(r.ok && r.emptyIntake).toBe(true);
  });

  it("rejects a material type outside the contract", () => {
    const r = buildResumeEvidenceStart({ material: { ...material, type: "BOGUS" } });
    expect(r.ok).toBe(false);
  });
});

describe("Resume Evidence session derivation and prompt injection", () => {
  const start = buildResumeEvidenceStart({ material });
  const pack = start.ok ? start.message : "";

  it("adds nothing for normal Pilot turns (byte-for-byte unchanged)", () => {
    const messages = [u("list my jobs"), a("You have 2 jobs.")];
    expect(buildResumeEvidencePromptAddendum({ messages, agentRole: "pilot" })).toBe("");
    expect(buildResumeEvidencePromptAddendum({ messages: [], agentRole: "pilot" })).toBe("");
  });

  it("adds nothing outside the Pilot slot even with a pack message", () => {
    for (const role of ["insight", "reflect"]) {
      expect(
        buildResumeEvidencePromptAddendum({ messages: [u(pack)], agentRole: role }),
      ).toBe("");
    }
  });

  it("hosts legacy NULL-role conversations, which live in the Pilot slot", () => {
    for (const role of [null, undefined]) {
      expect(
        buildResumeEvidencePromptAddendum({ messages: [u(pack)], agentRole: role }),
      ).not.toBe("");
    }
  });

  it("injects instructions and first-turn state on the pack turn", () => {
    const text = buildResumeEvidencePromptAddendum({
      messages: [u(pack)],
      agentRole: "pilot",
    });
    expect(text).toContain(buildResumeEvidenceInstructions());
    expect(text).toContain("第一轮");
  });

  it("keeps confirmed / skipped / conflict state from the latest valid draft", () => {
    const draft = baseDraft();
    draft.session.stage = "clarifying";
    draft.session.roundIndex = 2;
    draft.confirmedFacts = [
      {
        id: "f1",
        text: "I led the cutover",
        slot: "personal_contribution",
        epistemic: "user_stated",
        sourceRefs: ["src-material"],
        attribution: "personal",
      },
    ];
    draft.skipped = [{ id: "s1", slot: "time_range", reason: "user_skip", note: "skip" }];
    draft.conflicts = [
      {
        id: "c1",
        topic: "role",
        left: { text: "lead", sourceRefs: ["src-material"] },
        right: { text: "member", sourceRefs: ["src-material"] },
        resolution: "open",
      },
    ];
    draft.session.sufficiency = { met: false, missingSlots: ["action", "result"] };
    const messages = [u(pack), a("ok\n" + fenced(draft)), u("continue")];
    const session = deriveResumeEvidenceSession(messages);
    expect(session.active).toBe(true);
    expect(session.lastDraft?.session.roundIndex).toBe(2);
    const state = flowStateFromDraft(draft);
    expect(state.personalContribution).toBe("confirmed");
    expect(state.timeRange).toBe("skipped");
    expect(state.openConflicts).toBe(1);
    const text = buildResumeEvidencePromptAddendum({ messages, agentRole: "pilot" });
    expect(text).toContain("未解决冲突 1 处");
    expect(text).toContain("个人贡献=confirmed");
    expect(text).toContain("时间=skipped");
    expect(text).toContain("下一个重点：conflict");
  });

  it("feeds the last failed draft's validation errors back to the model", () => {
    const bad = { skillId: RESUME_EVIDENCE_SKILL_ID, artifactKind: "skill_result_draft" };
    const messages = [u(pack), a(fenced(bad))];
    const session = deriveResumeEvidenceSession(messages);
    expect(session.lastDraft).toBeNull();
    expect(session.lastAttemptErrors!.length).toBeGreaterThan(0);
    const text = buildResumeEvidencePromptAddendum({ messages, agentRole: "pilot" });
    expect(text).toContain("未通过合同校验");
    expect(text).toContain(session.lastAttemptErrors![0]);
  });

  it("keeps the last valid draft as state while reporting a newer invalid attempt", () => {
    const draft = baseDraft();
    draft.session.stage = "clarifying";
    const bad = { skillId: RESUME_EVIDENCE_SKILL_ID, artifactKind: "skill_result_draft" };
    const messages = [u(pack), a(fenced(draft)), u("修改一下"), a(fenced(bad))];
    const session = deriveResumeEvidenceSession(messages);
    expect(session.lastDraft?.session.stage).toBe("clarifying");
    expect(session.lastAttemptErrors!.length).toBeGreaterThan(0);
    const text = buildResumeEvidencePromptAddendum({ messages, agentRole: "pilot" });
    expect(text).toContain("stage=clarifying");
    expect(text).toContain("未通过合同校验");
  });

  it("clears the failure feedback once a newer draft validates", () => {
    const bad = { skillId: RESUME_EVIDENCE_SKILL_ID };
    const draft = baseDraft();
    draft.session.stage = "clarifying";
    const messages = [u(pack), a(fenced(bad)), a(fenced(draft))];
    const session = deriveResumeEvidenceSession(messages);
    expect(session.lastDraft).not.toBeNull();
    expect(session.lastAttemptErrors).toBeNull();
    expect(
      buildResumeEvidencePromptAddendum({ messages, agentRole: "pilot" }),
    ).not.toContain("未通过合同校验");
  });

  it("ignores an invalid draft and a stopped run ends the mode", () => {
    const bad = { skillId: "x" };
    const invalid = deriveResumeEvidenceSession([u(pack), a(fenced(bad))]);
    expect(invalid.lastDraft).toBeNull();
    expect(invalid.active).toBe(true);

    const draft = baseDraft();
    draft.session = {
      stage: "stopped",
      stopReason: "insufficient_user_stop",
      roundIndex: 1,
      focus: null,
      sufficiency: { met: false, missingSlots: ["action"] },
    };
    draft.next.questionBudget = 0;
    const messages = [u(pack), a(fenced(draft)), u("what jobs do I have?")];
    expect(deriveResumeEvidenceSession(messages).active).toBe(false);
    expect(buildResumeEvidencePromptAddendum({ messages, agentRole: "pilot" })).toBe("");
  });
});

describe("Resume Evidence host boundaries", () => {
  it("does not widen Pilot's tool allowlist or add write tools", () => {
    const pilot = AGENT_ROLE_TOOL_ALLOWLIST.pilot;
    expect([...pilot].sort()).toEqual(
      expect.not.arrayContaining(["confirm_career_material", "add_evidence"]),
    );
    expect([...pilot].join(",")).not.toMatch(/evidence|material/i);
  });

  it("splits draft text into prose and draft segments", () => {
    const draft = baseDraft();
    const text = "Here:\n" + fenced(draft) + "\nDone";
    expect(hasResumeEvidenceDraftBlock(text)).toBe(true);
    const kinds = splitResumeEvidenceDraftText(text).map((s) => s.kind);
    expect(kinds).toEqual(["text", "draft", "text"]);
    expect(hasResumeEvidenceDraftBlock('```json\n{"a":1}\n```')).toBe(false);
  });
});

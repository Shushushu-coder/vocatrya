import { z } from "zod";

// Resume Evidence deep-dive skill: result contract (resume-evidence-result/v0.1).
// Spec: wiki/RESUME_EVIDENCE_SKILL_CONTRACT_PROPOSAL.md (approved 2026-11-17).
// First version is draft-only: nothing here saves or loads career material,
// and no model-produced boolean can authorize or prove a write.

export const RESUME_EVIDENCE_SKILL_ID =
  "vocatrya.skill.resume-evidence-deep-dive" as const;
export const RESUME_EVIDENCE_SKILL_VERSION = "0.1.0-proposal" as const;
export const RESUME_EVIDENCE_CONTRACT_VERSION =
  "resume-evidence-result/v0.1" as const;
/** Clarifying rounds before a forced stage summary (skill rule, not a setting). */
export const RESUME_EVIDENCE_MAX_CLARIFY_ROUNDS = 6;

export const STAGES = [
  "intake",
  "clarifying",
  "summarizing",
  "ready_to_stop",
  "stopped",
] as const;
export const STOP_REASONS = ["sufficient", "insufficient_user_stop"] as const;
export const PURPOSES = [
  "resume_bullet",
  "interview_story",
  "career_record",
  "unspecified",
] as const;

/** Slots that can be asked about, in contract §4.1 priority order. */
export const FOCUS_SLOTS = [
  "conflict",
  "personal_contribution",
  "action",
  "result",
  "difficulty",
  "time_range",
  "evidence_pointer",
  "jd_relevance",
] as const;
/** Title-only slots: asked only when missing from the source and needed. */
export const TITLE_SLOTS = ["organization", "role", "context"] as const;
export const FACT_SLOTS = [...FOCUS_SLOTS, ...TITLE_SLOTS, "metric"] as const;

export const ATTRIBUTIONS = ["personal", "team", "mixed", "unknown"] as const;
export const SEMANTIC_ROLES = [
  "responsibility",
  "action",
  "outcome",
  "metric",
  "skill_usage",
  "output",
  "context",
  "other",
] as const;
export const MATERIAL_TYPES = [
  "EMPLOYMENT",
  "INTERNSHIP",
  "PROJECT",
  "RESEARCH",
  "PUBLICATION",
  "COMPETITION",
  "CAMPUS_ACTIVITY",
  "EDUCATION",
  "AWARD",
  "SKILL",
  "CERTIFICATION",
  "LANGUAGE",
  "CUSTOM",
] as const;
export const FUTURE_OPERATIONS = [
  "create_new",
  "update_existing",
  "draft_only",
] as const;
export const FUTURE_ENTRYPOINTS = [
  "createApplicationMaterial",
  "updateApplicationMaterial",
  "addApplicationMaterialEvidence",
] as const;
export const USER_CONTROLS = [
  "纠正",
  "换方向",
  "跳过",
  "结束",
  "查看阶段总结",
] as const;

const slotEnum = z.enum(FACT_SLOTS);
const focusEnum = z.enum(FOCUS_SLOTS);
const attributionEnum = z.enum(ATTRIBUTIONS);
const refList = z.array(z.string().min(1));
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable();

export const authorizationPackSchema = z.object({
  skillId: z.literal(RESUME_EVIDENCE_SKILL_ID),
  skillVersion: z.literal(RESUME_EVIDENCE_SKILL_VERSION),
  experienceText: z.string(),
  existingMaterial: z
    .object({
      id: z.string().min(1),
      type: z.enum(MATERIAL_TYPES),
      title: z.string().nullable().optional(),
      startDate: z.string().nullable().optional(),
      endDate: z.string().nullable().optional(),
      isCurrent: z.boolean().nullable().optional(),
      notes: z.string().nullable().optional(),
      detail: z.record(z.string(), z.unknown()).optional(),
      evidence: z
        .array(
          z.object({
            id: z.string().min(1),
            kind: z.string(),
            content: z.string(),
            metricText: z.string().nullable().optional(),
          }),
        )
        .optional(),
    })
    .nullable(),
  purpose: z.enum(PURPOSES),
  targetJdText: z.string().nullable(),
});
export type ResumeEvidenceAuthorizationPack = z.infer<
  typeof authorizationPackSchema
>;

const sourceRefSchema = z.object({
  ref: z.string().min(1),
  kind: z.enum([
    "pasted_text",
    "existing_material",
    "existing_evidence",
    "user_turn",
    "optional_jd",
  ]),
  label: z.string(),
  stableId: z.string().nullable(),
  excerpt: z.string(),
});

const confirmedFactSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  slot: slotEnum,
  epistemic: z.enum(["user_stated", "source_material"]),
  sourceRefs: refList.min(1),
  attribution: attributionEnum,
});

const pendingSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  slot: slotEnum,
  reason: z.enum([
    "unknown",
    "not_disclosed",
    "unquantified",
    "conflict",
    "not_yet_asked",
  ]),
  sourceRefs: refList,
});

const conflictSide = z.object({
  text: z.string().min(1),
  sourceRefs: refList.min(1),
});
const conflictSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  left: conflictSide,
  right: conflictSide,
  resolution: z.enum(["open", "user_resolved"]),
});

const contributionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  attribution: attributionEnum,
  actionIds: refList,
  outcomeIds: refList,
  sourceRefs: refList.min(1),
  epistemic: z.enum(["user_stated", "source_material"]),
});
const actionSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  actor: attributionEnum,
  sourceRefs: refList.min(1),
  epistemic: z.enum(["user_stated", "source_material"]),
});
const outcomeSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  quantified: z.boolean(),
  metricText: z.string().nullable(),
  attribution: attributionEnum,
  sourceRefs: refList.min(1),
  epistemic: z.enum(["user_stated", "source_material"]),
});

const suggestedExpressionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  basisFactIds: refList.min(1),
  epistemic: z.literal("suggested_wording"),
  userAcceptedWording: z.boolean(),
  saveAuthorized: z.literal(false),
});

const assumptionSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  epistemic: z.literal("assumption").optional(),
  promoted: z.boolean(),
  sourceRefs: refList.optional(),
});

const skippedSchema = z.object({
  id: z.string().min(1),
  slot: slotEnum,
  reason: z.enum(["user_skip", "user_unknown", "user_private", "no_metric"]),
  note: z.string(),
});

const evidenceToAddSchema = z.object({
  content: z.string().min(1),
  metricText: z.string().nullable(),
  kindOnWrite: z.literal("FACT"),
  semanticRole: z.enum(SEMANTIC_ROLES),
  basisFactIds: refList.min(1),
  userAcceptedAsEvidence: z.boolean(),
});

const materialMappingSchema = z.object({
  operation: z.literal("draft_only"),
  careerMaterialItemId: z.string().nullable(),
  type: z.enum(MATERIAL_TYPES).nullable(),
  parent: z.object({
    title: z.string().nullable(),
    startDate: dateOnly,
    endDate: dateOnly,
    isCurrent: z.boolean().nullable(),
    notes: z.string().nullable(),
  }),
  detail: z.record(z.string(), z.string()),
  evidenceToAdd: z.array(evidenceToAddSchema),
  blockedWrites: z.array(
    z.object({ code: z.string().min(1), message: z.string().min(1) }),
  ),
  verificationStatusOnWrite: z.literal("USER_AUTHORED"),
  originOnWrite: z.literal("USER"),
  // First version never executes anything: always empty.
  callsExistingEntrypoints: z.array(z.string()).length(0),
  futureOperation: z.enum(FUTURE_OPERATIONS),
  futureEntrypoints: z.array(z.enum(FUTURE_ENTRYPOINTS)),
});

const saveGateSchema = z.object({
  wordingAccepted: z.boolean(),
  saveAuthorized: z.literal(false),
  persisted: z.literal(false),
  mustConfirmBeforeSave: z.array(z.string()),
});

export const resumeEvidenceDraftSchema = z
  .object({
    contractVersion: z.literal(RESUME_EVIDENCE_CONTRACT_VERSION),
    skillId: z.literal(RESUME_EVIDENCE_SKILL_ID),
    skillVersion: z.literal(RESUME_EVIDENCE_SKILL_VERSION),
    artifactKind: z.literal("skill_result_draft"),
    exampleKind: z.enum(["design_example", "model_output"]),
    session: z.object({
      stage: z.enum(STAGES),
      stopReason: z.enum(STOP_REASONS).nullable(),
      roundIndex: z.number().int().min(0),
      focus: focusEnum.nullable(),
      sufficiency: z.object({
        met: z.boolean(),
        missingSlots: z.array(slotEnum),
      }),
    }),
    authorization: z.object({
      scope: z.literal("single_experience"),
      fullLibraryScanned: z.literal(false),
      purpose: z.enum(PURPOSES),
      targetJdRef: z.string().nullable(),
    }),
    sourceRefs: z.array(sourceRefSchema),
    confirmedFacts: z.array(confirmedFactSchema),
    pending: z.array(pendingSchema),
    conflicts: z.array(conflictSchema),
    contributions: z.array(contributionSchema),
    actions: z.array(actionSchema),
    outcomes: z.array(outcomeSchema),
    suggestedExpressions: z.array(suggestedExpressionSchema),
    assumptions: z.array(assumptionSchema),
    skipped: z.array(skippedSchema),
    materialMapping: materialMappingSchema,
    saveGate: saveGateSchema,
    next: z.object({
      recommendation: z.enum([
        "ask",
        "summarize",
        "offer_stop",
        "wait_for_save_confirmation",
        "hand_to_user",
      ]),
      questionBudget: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      userControls: z.array(z.string()),
    }),
  })
  .superRefine((d, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    const refs = new Set(d.sourceRefs.map((s) => s.ref));
    if (refs.size !== d.sourceRefs.length) {
      fail(["sourceRefs"], "sourceRefs ref values must be unique");
    }
    const checkRefs = (path: (string | number)[], list: string[]) => {
      list.forEach((r, i) => {
        if (!refs.has(r)) fail([...path, i], `unknown source ref: ${r}`);
      });
    };
    d.confirmedFacts.forEach((f, i) =>
      checkRefs(["confirmedFacts", i, "sourceRefs"], f.sourceRefs),
    );
    d.pending.forEach((p, i) =>
      checkRefs(["pending", i, "sourceRefs"], p.sourceRefs),
    );
    d.contributions.forEach((c, i) =>
      checkRefs(["contributions", i, "sourceRefs"], c.sourceRefs),
    );
    d.actions.forEach((a, i) =>
      checkRefs(["actions", i, "sourceRefs"], a.sourceRefs),
    );
    d.outcomes.forEach((o, i) =>
      checkRefs(["outcomes", i, "sourceRefs"], o.sourceRefs),
    );
    d.conflicts.forEach((c, i) => {
      checkRefs(["conflicts", i, "left", "sourceRefs"], c.left.sourceRefs);
      checkRefs(["conflicts", i, "right", "sourceRefs"], c.right.sourceRefs);
    });
    if (d.authorization.targetJdRef && !refs.has(d.authorization.targetJdRef)) {
      fail(["authorization", "targetJdRef"], "targetJdRef must be a source ref");
    }

    const factIds = new Set(d.confirmedFacts.map((f) => f.id));
    d.suggestedExpressions.forEach((e, i) =>
      e.basisFactIds.forEach((id, j) => {
        if (!factIds.has(id)) {
          fail(
            ["suggestedExpressions", i, "basisFactIds", j],
            `basis must be a confirmed fact: ${id}`,
          );
        }
      }),
    );
    const suggestedTexts = new Set(d.suggestedExpressions.map((e) => e.text));
    d.materialMapping.evidenceToAdd.forEach((e, i) => {
      e.basisFactIds.forEach((id, j) => {
        if (!factIds.has(id)) {
          fail(
            ["materialMapping", "evidenceToAdd", i, "basisFactIds", j],
            `basis must be a confirmed fact: ${id}`,
          );
        }
      });
      if (suggestedTexts.has(e.content)) {
        fail(
          ["materialMapping", "evidenceToAdd", i, "content"],
          "suggested wording must not appear as an evidence fact",
        );
      }
    });

    d.outcomes.forEach((o, i) => {
      if (!o.quantified && o.metricText !== null) {
        fail(["outcomes", i, "metricText"], "unquantified outcome needs null metricText");
      }
    });

    // Slot-state consistency (§4.4).
    const { session } = d;
    const openConflict = d.conflicts.some((c) => c.resolution === "open");
    const { met, missingSlots } = session.sufficiency;
    if (met && missingSlots.length > 0) {
      fail(["session", "sufficiency"], "met=true requires empty missingSlots");
    }
    if (!met && missingSlots.length === 0) {
      fail(["session", "sufficiency"], "met=false requires missingSlots");
    }
    if (met && openConflict) {
      fail(["session", "sufficiency", "met"], "open conflict blocks sufficiency");
    }
    if (session.stage === "stopped") {
      if (session.stopReason === null) {
        fail(["session", "stopReason"], "stopped requires a stopReason");
      }
      if (session.focus !== null) {
        fail(["session", "focus"], "stopped requires null focus");
      }
    } else if (session.stopReason !== null) {
      fail(["session", "stopReason"], "stopReason only valid when stopped");
    }
    if (session.stopReason === "sufficient" && !met) {
      fail(["session", "stopReason"], "sufficient requires sufficiency.met");
    }
    if (session.stage === "ready_to_stop" && !met) {
      fail(["session", "stage"], "ready_to_stop requires sufficiency.met");
    }
    if (
      (session.stage === "summarizing" ||
        session.stage === "ready_to_stop" ||
        session.stage === "stopped") &&
      d.next.questionBudget !== 0
    ) {
      fail(["next", "questionBudget"], "no questions after clarifying ends");
    }
    if (
      d.next.questionBudget === 2 &&
      session.focus !== "personal_contribution"
    ) {
      fail(
        ["next", "questionBudget"],
        "two questions only to split personal vs team contribution",
      );
    }

    const mm = d.materialMapping;
    if (
      (mm.type === "EMPLOYMENT" || mm.type === "CUSTOM") &&
      mm.futureOperation !== "draft_only"
    ) {
      fail(
        ["materialMapping", "futureOperation"],
        "EMPLOYMENT/CUSTOM are read-only in the profile page: draft_only",
      );
    }
    if (d.confirmedFacts.length === 0 && mm.evidenceToAdd.length > 0) {
      fail(["materialMapping", "evidenceToAdd"], "no confirmed facts, no evidence");
    }
  });

export type ResumeEvidenceDraft = z.infer<typeof resumeEvidenceDraftSchema>;

export type ResumeEvidenceDraftParseResult =
  | { ok: true; draft: ResumeEvidenceDraft }
  | { ok: false; errors: string[] };

export function validateResumeEvidenceDraft(
  value: unknown,
): ResumeEvidenceDraftParseResult {
  const parsed = resumeEvidenceDraftSchema.safeParse(value);
  if (parsed.success) return { ok: true, draft: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (i) => `${i.path.join(".") || "(root)"}: ${i.message}`,
    ),
  };
}

/** Extract the JSON draft from model text (fenced ```json block or bare JSON). */
export function parseResumeEvidenceDraftText(
  text: string,
): ResumeEvidenceDraftParseResult {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return { ok: false, errors: ["(root): not valid JSON"] };
  }
  return validateResumeEvidenceDraft(value);
}

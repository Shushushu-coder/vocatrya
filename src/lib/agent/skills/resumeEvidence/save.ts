import type { ResumeEvidenceDraft } from "./contract";

// Save eligibility for a Resume Evidence draft (D4/D5, 2026-11-19 ruling).
// Pure and client-safe: the UI uses it to decide whether to offer the save
// action, and the server re-runs it on the re-validated draft (the client is
// never trusted). Only material types that already have an Application
// Profile write path can be saved; EMPLOYMENT and CUSTOM stay draft-only.

export const RESUME_EVIDENCE_SAVE_UNSUPPORTED_TYPES = [
  "EMPLOYMENT",
  "CUSTOM",
] as const;

export type ResumeEvidenceSaveBlockCode =
  | "unsupported_type"
  | "draft_only"
  | "blocked_writes"
  | "stage_not_ready"
  | "open_conflict"
  | "no_evidence"
  | "evidence_not_accepted"
  | "invalid_evidence"
  | "missing_title"
  | "missing_target";

export type ResumeEvidenceSaveEligibility =
  | {
      ok: true;
      operation: "create_new" | "update_existing";
      type: string;
    }
  | { ok: false; code: ResumeEvidenceSaveBlockCode };

export function getResumeEvidenceSaveEligibility(
  draft: ResumeEvidenceDraft,
): ResumeEvidenceSaveEligibility {
  const mm = draft.materialMapping;
  const type = mm.type;
  if (
    type !== null &&
    (RESUME_EVIDENCE_SAVE_UNSUPPORTED_TYPES as readonly string[]).includes(type)
  ) {
    return { ok: false, code: "unsupported_type" };
  }
  if (mm.futureOperation === "draft_only" || type === null) {
    return { ok: false, code: "draft_only" };
  }
  // DRAFT_ONLY_V1 is the v1 version marker seeded by createInitialResumeEvidenceDraft,
  // not a whitelist block, so it never gates saving on its own.
  // A non-empty blockedWrites means some content cannot be written (for
  // example a detail column outside the whitelist). Saving anyway would drop
  // it silently, so the whole draft stays draft-only (contract §5).
  if (savingBlockers(mm.blockedWrites).length > 0) {
    return { ok: false, code: "blocked_writes" };
  }
  const { stage } = draft.session;
  if (stage !== "ready_to_stop" && stage !== "stopped") {
    return { ok: false, code: "stage_not_ready" };
  }
  if (draft.conflicts.some((c) => c.resolution === "open")) {
    return { ok: false, code: "open_conflict" };
  }
  if (mm.evidenceToAdd.length === 0) return { ok: false, code: "no_evidence" };
  if (mm.evidenceToAdd.some((e) => !e.userAcceptedAsEvidence)) {
    return { ok: false, code: "evidence_not_accepted" };
  }
  const contents = mm.evidenceToAdd.map((e) => e.content.trim());
  if (contents.some((c) => !c) || new Set(contents).size !== contents.length) {
    return { ok: false, code: "invalid_evidence" };
  }
  if (mm.futureOperation === "update_existing") {
    if (!mm.careerMaterialItemId) return { ok: false, code: "missing_target" };
    return { ok: true, operation: "update_existing", type };
  }
  if (mm.careerMaterialItemId) return { ok: false, code: "missing_target" };
  // LANGUAGE titles itself from detail on the server; others need a title.
  if (type !== "LANGUAGE" && !mm.parent.title?.trim()) {
    return { ok: false, code: "missing_title" };
  }
  return { ok: true, operation: "create_new", type };
}

export const DRAFT_ONLY_MARKER_CODE = "DRAFT_ONLY_V1";

/** blockedWrites entries that actually prevent saving (the v1 marker excluded). */
export function savingBlockers<T extends { code: string }>(blockedWrites: readonly T[]): T[] {
  return blockedWrites.filter((b) => b.code !== DRAFT_ONLY_MARKER_CODE);
}

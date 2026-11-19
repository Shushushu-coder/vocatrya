import {
  MATERIAL_TYPES,
  RESUME_EVIDENCE_SKILL_ID,
  RESUME_EVIDENCE_SKILL_VERSION,
  type ResumeEvidenceAuthorizationPack,
} from "./contract";
import {
  isIntakeEmpty,
  parseAuthorizationPack,
  startResumeEvidenceRun,
} from "./flow";
import { buildResumeEvidenceAuthorizationMessage } from "./prompt";

// User-initiated entry (contract §3): turns ONE picked career material plus an
// optional pasted experience and JD into the authorization pack and the first
// chat message. Read-only: nothing here touches the database or a write Action.

/** Loose shape of a career material row as returned by the read action. */
export interface ResumeEvidenceMaterialSource {
  id: string;
  type: string;
  title?: string | null;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  isCurrent?: boolean | null;
  notes?: string | null;
  evidence?: Array<{
    id: string;
    kind: string;
    content: string;
    metricText?: string | null;
  }> | null;
}

export type ResumeEvidenceStartResult =
  | {
      ok: true;
      pack: ResumeEvidenceAuthorizationPack;
      /** First user message of the run (the serialized pack). */
      message: string;
      /** True when no experience was given: the model asks one question. */
      emptyIntake: boolean;
    }
  | { ok: false; errors: string[] };

function dateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

export function isResumeEvidenceMaterialType(type: string): boolean {
  return (MATERIAL_TYPES as readonly string[]).includes(type);
}

export function buildResumeEvidenceStart(input: {
  material?: ResumeEvidenceMaterialSource | null;
  experienceText?: string;
  targetJdText?: string | null;
}): ResumeEvidenceStartResult {
  const m = input.material ?? null;
  const parsed = parseAuthorizationPack({
    skillId: RESUME_EVIDENCE_SKILL_ID,
    skillVersion: RESUME_EVIDENCE_SKILL_VERSION,
    experienceText: input.experienceText ?? "",
    existingMaterial: m
      ? {
          id: m.id,
          type: m.type,
          title: m.title ?? null,
          startDate: dateOnly(m.startDate),
          endDate: dateOnly(m.endDate),
          isCurrent: m.isCurrent ?? null,
          notes: m.notes ?? null,
          evidence: (m.evidence ?? []).map((e) => ({
            id: e.id,
            kind: e.kind,
            content: e.content,
            metricText: e.metricText ?? null,
          })),
        }
      : null,
    purpose: "unspecified",
    targetJdText: input.targetJdText?.trim() ? input.targetJdText : null,
  });
  if (!parsed.ok) return parsed;
  // The module decides the first move; an empty pack is the single-question path.
  const plan = startResumeEvidenceRun(parsed.pack);
  return {
    ok: true,
    pack: parsed.pack,
    message: buildResumeEvidenceAuthorizationMessage(parsed.pack),
    emptyIntake: isIntakeEmpty(parsed.pack) && plan.recommendation === "ask",
  };
}

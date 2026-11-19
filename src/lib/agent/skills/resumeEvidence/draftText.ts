import {
  RESUME_EVIDENCE_SKILL_ID,
  validateResumeEvidenceDraft,
  type ResumeEvidenceDraft,
} from "./contract";

// Splits assistant text into prose and Resume Evidence draft blocks so the
// chat can render a read-only card (contract §6). A block counts as a draft
// attempt only when it is a fenced json block that names this skill; every
// other code block stays ordinary markdown.

export type ResumeEvidenceTextSegment =
  | { kind: "text"; text: string }
  | { kind: "draft"; draft: ResumeEvidenceDraft }
  | { kind: "invalid"; errors: string[] };

const FENCE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;

export function hasResumeEvidenceDraftBlock(text: string): boolean {
  if (!text.includes(RESUME_EVIDENCE_SKILL_ID)) return false;
  return splitResumeEvidenceDraftText(text).some((s) => s.kind !== "text");
}

export function splitResumeEvidenceDraftText(
  text: string,
): ResumeEvidenceTextSegment[] {
  const out: ResumeEvidenceTextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    const body = match[1] ?? "";
    if (!body.includes(RESUME_EVIDENCE_SKILL_ID)) continue;
    const start = match.index ?? 0;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    last = start + match[0].length;
    let value: unknown;
    try {
      value = JSON.parse(body.trim());
    } catch {
      out.push({ kind: "invalid", errors: ["(root): not valid JSON"] });
      continue;
    }
    const parsed = validateResumeEvidenceDraft(value);
    out.push(
      parsed.ok
        ? { kind: "draft", draft: parsed.draft }
        : { kind: "invalid", errors: parsed.errors },
    );
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

import {
  RESUME_EVIDENCE_SKILL_ID,
  validateResumeEvidenceDraft,
  type ResumeEvidenceDraft,
} from "./contract";

// Splits assistant text into prose and Resume Evidence draft blocks so the
// chat can render a read-only card (contract §6). Outside a session a block
// counts as a draft attempt only when it is a fenced json block that names
// this skill; inside an active session the model's json output can only be
// the skill draft, so a draft-shaped block is recognized even when it omits
// the fixed envelope fields — it then surfaces as an invalid attempt whose
// errors are fed back instead of staying invisible (CORE-2).

export type ResumeEvidenceTextSegment =
  | { kind: "text"; text: string }
  | { kind: "draft"; draft: ResumeEvidenceDraft }
  | { kind: "invalid"; errors: string[]; raw: string };

export interface ResumeEvidenceSplitOptions {
  /**
   * True only for assistant text inside an active skill session (after the
   * authorization pack, before a stopped draft). Default false keeps the
   * strict skill-id gate so ordinary conversations stay byte-identical.
   */
  sessionScoped?: boolean;
}

const FENCE = /```(?:json)?[ \t]*\r?\n?([\s\S]*?)```/gi;

// Top-level keys of the draft contract: envelope fields plus every section.
const CONTRACT_KEYS = [
  "contractVersion",
  "skillId",
  "skillVersion",
  "artifactKind",
  "exampleKind",
  "session",
  "authorization",
  "sourceRefs",
  "confirmedFacts",
  "pending",
  "conflicts",
  "contributions",
  "actions",
  "outcomes",
  "suggestedExpressions",
  "assumptions",
  "skipped",
  "materialMapping",
  "saveGate",
  "next",
] as const;

/** Draft-shaped enough to count as a draft attempt inside a session. */
function looksLikeDraft(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = new Set(Object.keys(value));
  let hits = 0;
  for (const k of CONTRACT_KEYS) if (keys.has(k)) hits++;
  return hits >= 2;
}

export function hasResumeEvidenceDraftBlock(
  text: string,
  options?: ResumeEvidenceSplitOptions,
): boolean {
  if (!text.includes("```")) return false;
  if (!options?.sessionScoped && !text.includes(RESUME_EVIDENCE_SKILL_ID)) {
    return false;
  }
  return splitResumeEvidenceDraftText(text, options).some(
    (s) => s.kind !== "text",
  );
}

export function splitResumeEvidenceDraftText(
  text: string,
  options?: ResumeEvidenceSplitOptions,
): ResumeEvidenceTextSegment[] {
  const sessionScoped = options?.sessionScoped === true;
  const out: ResumeEvidenceTextSegment[] = [];
  let last = 0;
  for (const match of text.matchAll(FENCE)) {
    const body = match[1] ?? "";
    const start = match.index ?? 0;
    const named = body.includes(RESUME_EVIDENCE_SKILL_ID);
    let value: unknown;
    try {
      value = JSON.parse(body.trim());
    } catch {
      // A block naming this skill is an attempt even when broken; inside a
      // session a broken block still carrying the draft's signature key
      // counts too — every other malformed snippet stays ordinary markdown.
      if (!named && !(sessionScoped && body.includes('"session"'))) continue;
      if (start > last)
        out.push({ kind: "text", text: text.slice(last, start) });
      last = start + match[0].length;
      out.push({
        kind: "invalid",
        errors: ["(root): not valid JSON"],
        raw: body.trim(),
      });
      continue;
    }
    const attempt = named || (sessionScoped && looksLikeDraft(value));
    if (!attempt) continue;
    if (start > last) out.push({ kind: "text", text: text.slice(last, start) });
    last = start + match[0].length;
    const parsed = validateResumeEvidenceDraft(value);
    out.push(
      parsed.ok
        ? { kind: "draft", draft: parsed.draft }
        : { kind: "invalid", errors: parsed.errors, raw: body.trim() },
    );
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  return out;
}

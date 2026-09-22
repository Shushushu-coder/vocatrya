/**
 * Evidence grounding: candidate excerpt → unique transcript resolution
 * → authoritative slice. Ambiguous / missing / invalid fail closed.
 *
 * Source: InterviewDx backend/app/services/feedback/validators.py
 * locate_evidence_excerpt (exact then unique normalized; fuzzy skipped
 * because product UI must never show misaligned evidence).
 */
import { DomainError } from "../persistence/interviewErrors";
import type { ValidatedFeedbackItem } from "../validation/feedback";

export const INVALID_TRANSCRIPT_EVIDENCE = "INVALID_TRANSCRIPT_EVIDENCE";

function findAllOccurrences(haystack: string, needle: string): number[] {
  if (!needle) return [];
  const starts: number[] = [];
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    starts.push(index);
    from = index + 1;
  }
  return starts;
}

function normalizeForMatch(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeWithMapping(text: string): { normalized: string; mapping: number[] } {
  const mapping: number[] = [];
  let normalized = "";
  let lastWasSpace = true;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const isSpace = /\s/.test(ch);
    if (isSpace) {
      if (!lastWasSpace && normalized.length > 0) {
        mapping.push(i);
        normalized += " ";
      }
      lastWasSpace = true;
      continue;
    }
    lastWasSpace = false;
    mapping.push(i);
    normalized += ch;
  }
  if (normalized.endsWith(" ")) {
    normalized = normalized.slice(0, -1);
    mapping.pop();
  }
  return { normalized, mapping };
}

export function resolveTranscriptEvidence(
  transcriptText: string,
  candidateExcerpt: string,
): { transcriptExcerpt: string; startOffset: number; endOffset: number } {
  const excerpt = String(candidateExcerpt ?? "");
  const answer = String(transcriptText ?? "");
  if (!excerpt.trim()) {
    throw new DomainError(
      INVALID_TRANSCRIPT_EVIDENCE,
      "evidence.transcript_excerpt cannot be empty",
    );
  }
  if (!answer) {
    throw new DomainError(
      INVALID_TRANSCRIPT_EVIDENCE,
      "evidence.transcript_excerpt cannot be located because transcript is empty",
    );
  }

  const exact = findAllOccurrences(answer, excerpt);
  if (exact.length > 1) {
    throw new DomainError(
      INVALID_TRANSCRIPT_EVIDENCE,
      "evidence.transcript_excerpt has an ambiguous exact match in transcript",
    );
  }
  if (exact.length === 1) {
    const start = exact[0];
    const end = start + excerpt.length;
    return {
      transcriptExcerpt: answer.slice(start, end),
      startOffset: start,
      endOffset: end,
    };
  }

  const normalizedExcerpt = normalizeForMatch(excerpt);
  if (normalizedExcerpt.length < 3) {
    throw new DomainError(
      INVALID_TRANSCRIPT_EVIDENCE,
      "evidence.transcript_excerpt could not be located in transcript",
    );
  }
  const { normalized, mapping } = normalizeWithMapping(answer);
  const normalizedStarts = findAllOccurrences(normalized, normalizedExcerpt);
  const spans = new Set(
    normalizedStarts.map((start) => {
      const endIndex = start + normalizedExcerpt.length - 1;
      return `${mapping[start]}:${mapping[endIndex] + 1}`;
    }),
  );
  if (spans.size > 1) {
    throw new DomainError(
      INVALID_TRANSCRIPT_EVIDENCE,
      "evidence.transcript_excerpt has an ambiguous normalized match in transcript",
    );
  }
  if (spans.size === 1) {
    const [raw] = spans;
    const [startStr, endStr] = raw.split(":");
    const start = Number(startStr);
    const end = Number(endStr);
    return {
      transcriptExcerpt: answer.slice(start, end),
      startOffset: start,
      endOffset: end,
    };
  }

  throw new DomainError(
    INVALID_TRANSCRIPT_EVIDENCE,
    "evidence.transcript_excerpt could not be located in transcript",
  );
}

export function groundFeedbackItem(
  transcriptText: string,
  item: ValidatedFeedbackItem,
): ValidatedFeedbackItem {
  const grounded = resolveTranscriptEvidence(
    transcriptText,
    item.evidence.transcriptExcerpt,
  );
  return {
    ...item,
    evidence: {
      ...item.evidence,
      transcriptExcerpt: grounded.transcriptExcerpt,
      startOffset: grounded.startOffset,
      endOffset: grounded.endOffset,
    },
  };
}

/**
 * Frozen feedback item validation (DIRECT_TRANSPLANT + IMPORT_REWRITE).
 * Source: InterviewDx vocatrya-port src/validation/feedback.ts
 */
import { z } from "zod";
import { DomainError, ErrorCodes } from "../persistence/interviewErrors";

export const feedbackEvidenceSchema = z.object({
  transcriptExcerpt: z.string(),
  startOffset: z.number().int(),
  endOffset: z.number().int(),
  problemStatement: z.string(),
  groundingSources: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const feedbackExplanationSchema = z.object({
  underlyingCause: z.string(),
  performanceImpact: z.string(),
  interviewerPerspective: z.string().nullable().optional(),
});

export const feedbackItemSchema = z.object({
  problemLabel: z.string().min(1),
  suggestion: z.string().min(1),
  evidence: feedbackEvidenceSchema,
  explanation: feedbackExplanationSchema,
});

export type FeedbackEvidence = z.infer<typeof feedbackEvidenceSchema>;
export type FeedbackExplanation = z.infer<typeof feedbackExplanationSchema>;
export type ValidatedFeedbackItem = z.infer<typeof feedbackItemSchema>;

export function validateFeedbackItem(item: unknown): ValidatedFeedbackItem {
  const raw = (item ?? {}) as Record<string, unknown>;
  const explanationSource = raw.explanation ?? raw.reason_diagnostic ?? raw.reasonDiagnostic ?? {};
  const evidenceSource = raw.evidence ?? {};
  const evidenceObj = evidenceSource as Record<string, unknown>;
  const explanationObj = explanationSource as Record<string, unknown>;
  const parsed = feedbackItemSchema.safeParse({
    problemLabel: String(raw.problemLabel ?? raw.problem_label ?? "").trim(),
    suggestion: String(raw.suggestion ?? "").trim(),
    evidence: {
      transcriptExcerpt: String(
        evidenceObj.transcriptExcerpt ?? evidenceObj.transcript_excerpt ?? "",
      ),
      startOffset: Number(evidenceObj.startOffset ?? evidenceObj.start_offset ?? 0),
      endOffset: Number(evidenceObj.endOffset ?? evidenceObj.end_offset ?? 0),
      problemStatement: String(
        evidenceObj.problemStatement ?? evidenceObj.problem_statement ?? "",
      ),
      groundingSources: evidenceObj.groundingSources ?? evidenceObj.grounding_sources ?? [],
    },
    explanation: {
      underlyingCause: String(
        explanationObj.underlyingCause ?? explanationObj.underlying_cause ?? "",
      ),
      performanceImpact: String(
        explanationObj.performanceImpact ?? explanationObj.performance_impact ?? "",
      ),
      interviewerPerspective:
        explanationObj.interviewerPerspective ??
        explanationObj.interviewer_perspective ??
        null,
    },
  });
  if (!parsed.success) {
    throw new DomainError(ErrorCodes.INVALID_FEEDBACK_ITEM, parsed.error.message);
  }
  if (!parsed.data.problemLabel) {
    throw new DomainError(ErrorCodes.INVALID_FEEDBACK_ITEM, "problem_label is required");
  }
  if (!parsed.data.suggestion) {
    throw new DomainError(ErrorCodes.INVALID_FEEDBACK_ITEM, "suggestion is required");
  }
  return parsed.data;
}

const FORBIDDEN_SNAPSHOT_KEYS = [
  "transcript",
  "fullText",
  "full_text",
  "prompt",
  "providerPayload",
  "provider_payload",
  "rawContent",
];

export function assertProvenanceSnapshot(snapshot: Record<string, unknown>): void {
  for (const key of FORBIDDEN_SNAPSHOT_KEYS) {
    if (key in snapshot) {
      throw new DomainError(
        "CONTEXT_SNAPSHOT_FORBIDDEN_PAYLOAD",
        `contextSnapshot must not contain ${key}`,
      );
    }
  }
}

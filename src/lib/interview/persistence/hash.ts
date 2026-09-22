/**
 * Phase 3B — Frozen canonical hash helpers (DIRECT_TRANSPLANT).
 *
 * Source: InterviewDx migration/vocatrya-port src/validation/hash.ts
 * PORT_SOURCE_COMMIT: a7c8d9012896ba013e3bb632de1d5ff636b08233
 *
 * Repository layer never invents a new hash scheme: contentHash and
 * inputHash values are produced with these frozen helpers by callers,
 * and the repository persists them verbatim. IMPORT_REWRITE only.
 */
import { createHash } from "node:crypto";

/** Python json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False) */
export function pyCanonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map(pyCanonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    const body = keys
      .map((key) => {
        const nested = (value as Record<string, unknown>)[key];
        return `${JSON.stringify(key)}:${pyCanonicalJson(nested)}`;
      })
      .join(",");
    return `{${body}}`;
  }
  return "null";
}

export function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return sha256Utf8(pyCanonicalJson(value));
}

export function canonicalTranscriptContentHash(
  fullText: string,
  segments: unknown = [],
): string {
  return sha256Canonical({
    full_text: fullText ?? "",
    segments: segments ?? [],
  });
}

export function canonicalSummaryInputHash(
  sessionId: string,
  evidence: Array<{
    inputOrder: number;
    questionInstanceId: string;
    feedbackGenerationId: string;
    inputRevisionId: string;
    inputContentHash: string | null;
  }>,
): string {
  return sha256Canonical({
    session_id: sessionId,
    inputs: evidence.map((item) => ({
      input_order: item.inputOrder,
      question_instance_id: item.questionInstanceId,
      feedback_generation_id: item.feedbackGenerationId,
      input_revision_id: item.inputRevisionId,
      input_content_hash: item.inputContentHash,
    })),
  });
}

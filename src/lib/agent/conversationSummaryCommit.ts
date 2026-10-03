import type { UIMessage } from "ai";
import {
  hashSummaryCoverage,
  validateConversationSummaryCoverage,
} from "./conversationSummaryCoverage";
import { CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION } from "./conversationSummaryPrompt";

export type ConversationSummaryRecord = {
  conversationId: string;
  userId: string;
  text: string | null;
  throughMessageId: string | null;
  coverageHash: string | null;
  coveredCount: number | null;
  promptVersion: string | null;
  revision: number;
  units: number | null;
  generationMs: number | null;
  generatedAt: Date | null;
  failureCount: number;
  lastFailureAt: Date | null;
};

export type SummaryAttempt = {
  conversationId: string;
  userId: string;
  observedRevision: number | null;
  text: string;
  throughMessageId: string;
  coverageHash: string;
  coveredCount: number;
  promptVersion: string;
  units: number;
  generationMs: number;
  generatedAt: Date;
};

export type SummaryCommitDecision =
  | { action: "discard" }
  | { action: "create"; record: ConversationSummaryRecord }
  | { action: "update"; expectedRevision: number; record: ConversationSummaryRecord };

export type SummarySnapshot = {
  messages: UIMessage[];
  summary: ConversationSummaryRecord | null;
};

/**
 * Optimistic coverage CAS. A missing row switches to revision comparison
 * when a concurrent create landed. An older prefix never replaces a newer
 * fresh summary. A revision mismatch discards without retry.
 */
export function evaluateSummaryCommit(
  current: SummarySnapshot,
  attempt: SummaryAttempt,
): SummaryCommitDecision {
  const index = current.messages.findIndex(
    (message) => message.id === attempt.throughMessageId,
  );
  if (index < 0 || attempt.coveredCount !== index + 1) return { action: "discard" };
  if (hashSummaryCoverage(current.messages.slice(0, index + 1)) !== attempt.coverageHash) {
    return { action: "discard" };
  }
  if (isFreshLater(current.summary, current.messages, index)) return { action: "discard" };

  const record = successRecord(attempt, 0);
  if (!current.summary) {
    if (attempt.observedRevision !== null) return { action: "discard" };
    return { action: "create", record: { ...record, revision: 1 } };
  }
  const expected =
    attempt.observedRevision === null
      ? current.summary.revision
      : attempt.observedRevision;
  return {
    action: "update",
    expectedRevision: expected,
    record: { ...record, revision: expected + 1 },
  };
}

export async function persistSummaryAttempt(args: {
  reload: () => Promise<SummarySnapshot | null>;
  create: (record: ConversationSummaryRecord) => Promise<"created" | "conflict">;
  update: (expectedRevision: number, record: ConversationSummaryRecord) => Promise<number>;
  attempt: SummaryAttempt;
}): Promise<"committed" | "discarded"> {
  const loaded = await args.reload();
  if (!loaded) return "discarded";
  const decision = evaluateSummaryCommit(loaded, args.attempt);
  if (decision.action === "discard") return "discarded";
  if (decision.action === "create") {
    const created = await args.create(decision.record);
    if (created === "created") return "committed";
    const again = await args.reload();
    if (!again) return "discarded";
    const retry = evaluateSummaryCommit(again, args.attempt);
    if (retry.action !== "update") return "discarded";
    const count = await args.update(retry.expectedRevision, retry.record);
    return count === 1 ? "committed" : "discarded";
  }
  const count = await args.update(decision.expectedRevision, decision.record);
  return count === 1 ? "committed" : "discarded";
}

function isFreshLater(
  summary: ConversationSummaryRecord | null,
  messages: UIMessage[],
  ourIndex: number,
): boolean {
  if (!summary) return false;
  const verdict = validateConversationSummaryCoverage(summary, messages);
  return verdict.status === "FRESH" && verdict.throughIndex > ourIndex;
}

function successRecord(attempt: SummaryAttempt, revision: number): ConversationSummaryRecord {
  return {
    conversationId: attempt.conversationId,
    userId: attempt.userId,
    text: attempt.text,
    throughMessageId: attempt.throughMessageId,
    coverageHash: attempt.coverageHash,
    coveredCount: attempt.coveredCount,
    promptVersion: attempt.promptVersion || CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
    revision,
    units: attempt.units,
    generationMs: attempt.generationMs,
    generatedAt: attempt.generatedAt,
    failureCount: 0,
    lastFailureAt: null,
  };
}

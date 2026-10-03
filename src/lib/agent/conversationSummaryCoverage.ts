import { createHash } from "node:crypto";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  buildCareerDialogueContext,
  CAREER_DIALOGUE_CONTEXT_BUDGETS,
  careerDialogueTurnIndexSpans,
  estimateContextTokens,
  latestCompleteTurnMessageCount,
  type CareerDialogueTurnIndexSpan,
} from "./contextBudget";
import { CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION } from "./conversationSummaryPrompt";

const TERMINAL_TOOL_STATES = new Set([
  "output-available",
  "output-error",
  "output-denied",
]);

export const SUMMARY_BACKOFF_INITIAL_MS = 60_000;
export const SUMMARY_BACKOFF_CAP_MS = 15 * 60_000;
export const SUMMARY_REFRESH_DROPPED_TURNS = 2;

export type SummaryCoverageFields = {
  text: string | null;
  throughMessageId: string | null;
  coverageHash: string | null;
  coveredCount: number | null;
  promptVersion: string | null;
  units: number | null;
};

export type SummaryCoverageVerdict =
  | { status: "MISSING" }
  | { status: "STALE"; reason: SummaryStaleReason }
  | { status: "FRESH"; text: string; throughIndex: number; units: number };

export type SummaryStaleReason =
  | "empty_text"
  | "prompt_version"
  | "through_message"
  | "covered_count"
  | "hash"
  | "units";

export type SummaryCoverageTarget = {
  throughMessageId: string;
  throughIndex: number;
  coveredCount: number;
  prefix: UIMessage[];
  coverageHash: string;
};

export function conversationSummaryBackoffMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  const exponent = Math.min(failureCount - 1, 16);
  return Math.min(SUMMARY_BACKOFF_INITIAL_MS * 2 ** exponent, SUMMARY_BACKOFF_CAP_MS);
}

export function conversationSummaryBackoffElapsed(
  failureCount: number,
  lastFailureAt: Date | null,
  now: number,
): boolean {
  if (failureCount <= 0 || !lastFailureAt) return true;
  return now - lastFailureAt.getTime() >= conversationSummaryBackoffMs(failureCount);
}

export function sortSummaryJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => sortSummaryJson(item));
  if (!value || typeof value !== "object") return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) out[key] = sortSummaryJson(source[key]);
  return out;
}

export function canonicalizeSummaryCoverageMessage(
  message: UIMessage,
): { id: string; parts: unknown[]; role: string } {
  const parts: unknown[] = [];
  for (const part of message.parts ?? []) {
    if (part.type === "text") {
      parts.push(sortSummaryJson({ text: part.text, type: "text" }));
      continue;
    }
    if (!isToolUIPart(part)) continue;
    const approval = part.approval;
    let approved: boolean | null = null;
    if (approval && typeof approval === "object" && "approved" in approval) {
      approved = Boolean(approval.approved);
    }
    parts.push(
      sortSummaryJson({
        approved,
        input: sortSummaryJson(part.input ?? null),
        name: getToolName(part),
        output: sortSummaryJson(part.output ?? null),
        state: part.state,
        type: "tool",
      }),
    );
  }
  return sortSummaryJson({
    id: message.id,
    parts,
    role: message.role,
  }) as { id: string; parts: unknown[]; role: string };
}

export function hashSummaryCoverage(messages: UIMessage[]): string {
  const canonical = messages.map((message) => canonicalizeSummaryCoverageMessage(message));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function validateConversationSummaryCoverage(
  summary: SummaryCoverageFields | null | undefined,
  messages: UIMessage[],
): SummaryCoverageVerdict {
  if (!summary) return { status: "MISSING" };
  const text = summary.text?.trim() ?? "";
  if (!text) return { status: "STALE", reason: "empty_text" };
  if (summary.promptVersion !== CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION) {
    return { status: "STALE", reason: "prompt_version" };
  }
  const units = estimateContextTokens(text);
  if (
    summary.units == null ||
    summary.units > CAREER_DIALOGUE_CONTEXT_BUDGETS.summaryTokens ||
    units > CAREER_DIALOGUE_CONTEXT_BUDGETS.summaryTokens
  ) {
    return { status: "STALE", reason: "units" };
  }
  if (!summary.throughMessageId) return { status: "STALE", reason: "through_message" };
  const throughIndex = messages.findIndex((message) => message.id === summary.throughMessageId);
  if (throughIndex < 0) return { status: "STALE", reason: "through_message" };
  if (summary.coveredCount !== throughIndex + 1) {
    return { status: "STALE", reason: "covered_count" };
  }
  const hash = hashSummaryCoverage(messages.slice(0, throughIndex + 1));
  if (hash !== summary.coverageHash) return { status: "STALE", reason: "hash" };
  return { status: "FRESH", text, throughIndex, units };
}

export function storedSummaryMessages(messages: UIMessage[]): UIMessage[] {
  return messages.slice(-APP_CONSTANTS.AGENT_CHAT_MAX_STORED_MESSAGES);
}

export function summaryEvictionCount(messages: UIMessage[]): number {
  const turnSize = latestCompleteTurnMessageCount(messages);
  if (turnSize <= 0) return 0;
  return Math.max(
    0,
    messages.length + turnSize - APP_CONSTANTS.AGENT_CHAT_MAX_STORED_MESSAGES,
  );
}

/** True when the next likely complete-turn append would drop this boundary. */
export function summaryBoundaryUnderStoragePressure(
  messages: UIMessage[],
  throughMessageId: string,
): boolean {
  const index = messages.findIndex((message) => message.id === throughMessageId);
  if (index < 0) return false;
  const turnSize = latestCompleteTurnMessageCount(messages);
  if (turnSize <= 0) return false;
  const remaining = index - messages.length + APP_CONSTANTS.AGENT_CHAT_MAX_STORED_MESSAGES;
  return remaining <= turnSize;
}

export function selectConversationSummaryCoverage(
  messages: UIMessage[],
  options?: { extendForStorageCap?: boolean },
): SummaryCoverageTarget | null {
  const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages });
  if (!budget.ok) return null;
  const spans = careerDialogueTurnIndexSpans(messages);
  const dropped = new Set(budget.historyBoundary.droppedTurns.map((ids) => ids.join("\0")));
  const eligibleSpans = spans.filter(
    (span) => span.complete && span.inHistoryPool && span.lastIndex >= 0,
  );
  const current = [...spans].reverse().find((span) => span.complete && !span.inHistoryPool);

  let boundary: CareerDialogueTurnIndexSpan | null = null;
  if (options?.extendForStorageCap) {
    const evictCount = summaryEvictionCount(messages);
    const candidates = [...eligibleSpans, ...(current ? [current] : [])];
    for (const span of candidates) {
      if (!turnEligible(messages, span.messageIds)) break;
      boundary = span;
      if (span.lastIndex >= evictCount) break;
    }
  } else {
    let includedRetained = false;
    for (const span of eligibleSpans) {
      if (!turnEligible(messages, span.messageIds)) break;
      const isDropped = dropped.has(span.messageIds.join("\0"));
      if (!isDropped) {
        if (includedRetained) break;
        boundary = span;
        includedRetained = true;
        break;
      }
      boundary = span;
    }
  }
  if (!boundary) return null;
  const throughIndex = boundary.lastIndex;
  const throughMessageId = messages[throughIndex]?.id;
  if (!throughMessageId) return null;
  const prefix = messages.slice(0, throughIndex + 1);
  return {
    throughMessageId,
    throughIndex,
    coveredCount: throughIndex + 1,
    prefix,
    coverageHash: hashSummaryCoverage(prefix),
  };
}

export function additionalDroppedTurnsBeyondCoverage(
  messages: UIMessage[],
  throughIndex: number,
): number {
  const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages });
  if (!budget.ok) return 0;
  let count = 0;
  for (const ids of budget.historyBoundary.droppedTurns) {
    const lastId = ids[ids.length - 1];
    if (!lastId) continue;
    const index = messages.findIndex((message) => message.id === lastId);
    if (index > throughIndex) count += 1;
  }
  return count;
}

export function summaryAgeTurns(messages: UIMessage[], throughIndex: number): number {
  return careerDialogueTurnIndexSpans(messages).filter(
    (span) => span.complete && span.lastIndex > throughIndex,
  ).length;
}

export function shouldOpenConversationSummaryTask(input: {
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  messages: UIMessage[];
}): boolean {
  if (!input.resolvedConnectionId || !input.resolvedModel) return false;
  const messages = storedSummaryMessages(input.messages);
  const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages });
  if (!budget.ok) return false;
  if (budget.size.droppedTurnCount >= 1) return true;
  const turnSize = latestCompleteTurnMessageCount(messages);
  const room = APP_CONSTANTS.AGENT_CHAT_MAX_STORED_MESSAGES - messages.length;
  return turnSize > 0 && room <= turnSize;
}

export function turnEligible(messages: UIMessage[], messageIds: string[]): boolean {
  const wanted = new Set(messageIds);
  const turnMessages = messages.filter((message) => wanted.has(message.id));
  if (turnMessages.length !== messageIds.length) return false;
  for (const message of turnMessages) {
    for (const part of message.parts ?? []) {
      if (!isToolUIPart(part)) continue;
      if (!TERMINAL_TOOL_STATES.has(part.state)) return false;
    }
  }
  return true;
}

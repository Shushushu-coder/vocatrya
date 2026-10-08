import "server-only";
import { managedLockFromRow, rejectManagedHistoricalExecution } from "@/lib/ai/managed-provenance";

import type { UIMessage } from "ai";
import { AIBusinessError } from "@/lib/ai/connections";
import { AI_EXECUTION_DEFAULT_TIMEOUT_MS, executeAIConnectionText } from "@/lib/ai/execution";
import { log } from "@/lib/telemetry";
import {
  CAREER_DIALOGUE_CONTEXT_BUDGETS,
  buildCareerDialogueContext,
  careerDialogueTurnIndexSpans,
  estimateContextTokens,
} from "./contextBudget";
import type { SummaryAttempt } from "./conversationSummaryCommit";
import {
  additionalDroppedTurnsBeyondCoverage,
  conversationSummaryBackoffElapsed,
  hashSummaryCoverage,
  selectConversationSummaryCoverage,
  shouldOpenConversationSummaryTask,
  storedSummaryMessages,
  summaryAgeTurns,
  summaryBoundaryUnderStoragePressure,
  SUMMARY_REFRESH_DROPPED_TURNS,
  turnEligible,
  validateConversationSummaryCoverage,
} from "./conversationSummaryCoverage";
import {
  buildCareerDialogueSummaryPrompt,
  CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
  projectConversationSummaryInput,
} from "./conversationSummaryPrompt";
import {
  createPrismaSummaryRepository,
  type SummaryRepository,
} from "./conversationSummaryStore";

export type SummaryTaskResult = {
  status: "skipped" | "committed" | "discarded" | "failed";
  reason: string;
  generationMs?: number;
  summaryUnits?: number;
  coveredCount?: number;
  droppedTurnCount?: number;
  recentTurnCount?: number;
  failureCount?: number;
  syncMs?: number;
};

export type SummarySchedulerDeps = {
  now: () => number;
  repository: SummaryRepository;
  executeText: (input: {
    userId: string;
    connectionId: string;
    model: string;
    prompt: string;
  }) => Promise<{ text: string }>;
  onGenerationStart?: () => void;
  onResult?: (result: SummaryTaskResult) => void;
};

const inFlight = new Map<string, Promise<void>>();
const SUMMARY_GENERATION_MAX_MESSAGES = 50;

export function conversationSummaryInFlight(
  conversationId: string,
): Promise<void> | undefined {
  return inFlight.get(conversationId);
}

export function resetConversationSummaryInFlightForTests(): void {
  inFlight.clear();
}

export function scheduleCareerDialogueSummary(
  input: {
    userId: string;
    conversationId: string;
    resolvedConnectionId: string | null;
    resolvedModel: string | null;
    messages: UIMessage[];
  },
  deps: SummarySchedulerDeps = defaultSummarySchedulerDeps(),
): { opened: boolean; syncMs: number } {
  const started = performance.now();
  const open = shouldOpenConversationSummaryTask({
    resolvedConnectionId: input.resolvedConnectionId,
    resolvedModel: input.resolvedModel,
    messages: input.messages,
  });
  if (!open || inFlight.has(input.conversationId)) {
    return { opened: false, syncMs: performance.now() - started };
  }
  const task = Promise.resolve()
    .then(() =>
      condenseCareerDialogueSummary(
        { userId: input.userId, conversationId: input.conversationId },
        deps,
      ),
    )
    .then(() => undefined)
    .catch(() => {
      log.info("[agent-chat] summary", {
        summaryStatus: "failed",
        summaryPromptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
      });
    })
    .finally(() => {
      if (inFlight.get(input.conversationId) === task) {
        inFlight.delete(input.conversationId);
      }
    });
  inFlight.set(input.conversationId, task);
  return { opened: true, syncMs: performance.now() - started };
}

export async function condenseCareerDialogueSummary(
  input: { userId: string; conversationId: string },
  deps: SummarySchedulerDeps = defaultSummarySchedulerDeps(),
): Promise<SummaryTaskResult> {
  const finish = (result: SummaryTaskResult) => {
    deps.onResult?.(result);
    return result;
  };
  try {
    const snapshot = await deps.repository.load(input.userId, input.conversationId);
    const managed = snapshot ? managedLockFromRow(snapshot) : null;
    if (managed) {
      if (!managed.connectionId) rejectManagedHistoricalExecution(managed, null, input.userId);
      return finish({ status: "skipped", reason: "MANAGED_EXECUTION_NOT_IMPLEMENTED" });
    }
    if (!snapshot?.resolvedConnectionId || !snapshot.resolvedModel) {
      return finish({ status: "skipped", reason: "legacy" });
    }
    const messages = storedSummaryMessages(snapshot.messages);
    const windowStartIndex = snapshot.messages.length - messages.length;
    const failureCount = snapshot.summary?.failureCount ?? 0;
    if (
      !conversationSummaryBackoffElapsed(
        failureCount,
        snapshot.summary?.lastFailureAt ?? null,
        deps.now(),
      )
    ) {
      return finish({ status: "skipped", reason: "backoff", failureCount });
    }

    const verdict = validateConversationSummaryCoverage(snapshot.summary, snapshot.messages);
    const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages });
    if (!budget.ok) return finish({ status: "skipped", reason: "budget" });
    const pressure =
      verdict.status === "FRESH" &&
      snapshot.summary?.throughMessageId != null &&
      (verdict.throughIndex < windowStartIndex ||
        summaryBoundaryUnderStoragePressure(messages, snapshot.summary.throughMessageId));
    const additional =
      verdict.status === "FRESH"
        ? additionalDroppedTurnsBeyondCoverage(messages, verdict.throughIndex - windowStartIndex)
        : 0;
    let trigger: "pressure" | "missing" | "refresh" | null = null;
    if (pressure) trigger = "pressure";
    else if (verdict.status !== "FRESH" && budget.size.droppedTurnCount >= 1) trigger = "missing";
    else if (verdict.status === "FRESH" && additional >= SUMMARY_REFRESH_DROPPED_TURNS) {
      trigger = "refresh";
    }
    if (!trigger) {
      return finish({
        status: "skipped",
        reason: "trigger",
        droppedTurnCount: budget.size.droppedTurnCount,
        recentTurnCount: budget.size.recentTurnCount,
      });
    }

    const desired = selectConversationSummaryCoverage(snapshot.messages, { extendForStorageCap: trigger === "pressure" });
    if (!desired) return finish({ status: "skipped", reason: "no_boundary" });
    const startIndex = verdict.status === "FRESH" ? verdict.throughIndex + 1 : 0;
    const previousSummary = verdict.status === "FRESH" ? verdict.text : undefined;
    let coveredCount = startIndex;
    // Bound the next contiguous delta, never an arbitrary recent window.
    // A turn that cannot fit is left uncovered rather than sliced or skipped.
    for (const span of careerDialogueTurnIndexSpans(snapshot.messages)) {
      if (span.lastIndex < startIndex) continue;
      if (span.firstIndex < startIndex || !span.complete || span.lastIndex > desired.throughIndex) break;
      const delta = snapshot.messages.slice(startIndex, span.lastIndex + 1);
      if (delta.length > SUMMARY_GENERATION_MAX_MESSAGES || !turnEligible(delta, delta.map(message => message.id))) break;
      const prompt = buildCareerDialogueSummaryPrompt(projectConversationSummaryInput(delta), previousSummary);
      if (estimateContextTokens(prompt) > CAREER_DIALOGUE_CONTEXT_BUDGETS.dynamicTokens) break;
      coveredCount = span.lastIndex + 1;
    }
    if (coveredCount === startIndex) return finish({ status: "skipped", reason: "no_boundary" });
    const authoritativePrefix = snapshot.messages.slice(0, coveredCount);
    if (!turnEligible(authoritativePrefix, authoritativePrefix.map(message => message.id))) {
      return finish({ status: "skipped", reason: "no_boundary" });
    }
    const target = {
      prefix: snapshot.messages.slice(startIndex, coveredCount),
      throughMessageId: snapshot.messages[coveredCount - 1].id,
      throughIndex: coveredCount - 1,
      coveredCount,
      coverageHash: hashSummaryCoverage(authoritativePrefix),
    };
    if (
      verdict.status === "FRESH" &&
      trigger !== "pressure" &&
      target.throughIndex <= verdict.throughIndex
    ) {
      return finish({ status: "skipped", reason: "not_newer" });
    }
    const projection = projectConversationSummaryInput(target.prefix);
    if (!projection.trim()) return finish({ status: "skipped", reason: "empty_projection" });

    deps.onGenerationStart?.();
    const started = deps.now();
    let raw = "";
    try {
      const executed = await deps.executeText({
        userId: input.userId,
        connectionId: snapshot.resolvedConnectionId,
        model: snapshot.resolvedModel,
        prompt: buildCareerDialogueSummaryPrompt(projection, previousSummary),
      });
      raw = executed.text ?? "";
    } catch {
      const nextFailureCount = await recordFailure(deps, input);
      logSummary({
        summaryStatus: "failed",
        summaryCoverage: target.coveredCount,
        summaryUnits: 0,
        summaryAgeTurns: summaryAgeTurns(snapshot.messages, target.throughIndex),
        generationMs: Math.max(0, Math.round(deps.now() - started)),
        failureCount: nextFailureCount,
      });
      return finish({
        status: "failed",
        reason: "provider",
        failureCount: nextFailureCount,
        coveredCount: target.coveredCount,
        droppedTurnCount: budget.size.droppedTurnCount,
        recentTurnCount: budget.size.recentTurnCount,
      });
    }

    const text = raw.trim();
    const units = estimateContextTokens(text);
    const generationMs = Math.max(0, Math.round(deps.now() - started));
    if (!text || units > CAREER_DIALOGUE_CONTEXT_BUDGETS.summaryTokens) {
      const nextFailureCount = await recordFailure(deps, input);
      logSummary({
        summaryStatus: "failed",
        summaryCoverage: target.coveredCount,
        summaryUnits: units,
        summaryAgeTurns: summaryAgeTurns(snapshot.messages, target.throughIndex),
        generationMs,
        failureCount: nextFailureCount,
      });
      return finish({
        status: "failed",
        reason: text ? "too_large" : "empty",
        generationMs,
        summaryUnits: units,
        failureCount: nextFailureCount,
        coveredCount: target.coveredCount,
        droppedTurnCount: budget.size.droppedTurnCount,
        recentTurnCount: budget.size.recentTurnCount,
      });
    }

    const attempt: SummaryAttempt = {
      conversationId: input.conversationId,
      userId: input.userId,
      observedRevision: snapshot.summary ? snapshot.summary.revision : null,
      text,
      throughMessageId: target.throughMessageId,
      coverageHash: target.coverageHash,
      coveredCount: target.coveredCount,
      promptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
      units,
      generationMs,
      generatedAt: new Date(deps.now()),
    };
    const outcome = await deps.repository.commit(input.userId, input.conversationId, attempt);
    logSummary({
      summaryStatus: outcome,
      summaryCoverage: target.coveredCount,
      summaryUnits: units,
      summaryAgeTurns: summaryAgeTurns(snapshot.messages, target.throughIndex),
      generationMs,
      failureCount: outcome === "committed" ? 0 : failureCount,
    });
    return finish({
      status: outcome,
      reason: trigger,
      generationMs,
      summaryUnits: units,
      coveredCount: target.coveredCount,
      droppedTurnCount: budget.size.droppedTurnCount,
      recentTurnCount: budget.size.recentTurnCount,
      failureCount: outcome === "committed" ? 0 : failureCount,
    });
  } catch (error) {
    if (error instanceof AIBusinessError) return finish({ status: "failed", reason: error.code });
    log.info("[agent-chat] summary", {
      summaryStatus: "failed",
      summaryPromptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
    });
    return finish({ status: "failed", reason: "unexpected" });
  }
}

function defaultSummarySchedulerDeps(): SummarySchedulerDeps {
  return {
    now: () => Date.now(),
    repository: createPrismaSummaryRepository(),
    executeText: async (input) => {
      const result = await executeAIConnectionText({
        userId: input.userId,
        connectionId: input.connectionId,
        model: input.model,
        prompt: input.prompt,
        timeoutMs: AI_EXECUTION_DEFAULT_TIMEOUT_MS,
      });
      return { text: result.text };
    },
  };
}

async function recordFailure(
  deps: SummarySchedulerDeps,
  input: { userId: string; conversationId: string },
): Promise<number> {
  try {
    return await deps.repository.recordFailure(input.userId, input.conversationId, new Date(deps.now()));
  } catch {
    log.info("[agent-chat] summary", {
      summaryStatus: "failed",
      summaryPromptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
    });
    return 0;
  }
}

function logSummary(fields: {
  summaryStatus: string;
  summaryCoverage: number;
  summaryUnits: number;
  summaryAgeTurns: number;
  generationMs: number;
  failureCount: number;
}): void {
  log.info("[agent-chat] summary", {
    ...fields,
    summaryPromptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
  });
}

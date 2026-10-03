import "server-only";

import type { UIMessage } from "ai";
import { AI_EXECUTION_DEFAULT_TIMEOUT_MS, executeAIConnectionText } from "@/lib/ai/execution";
import { log } from "@/lib/telemetry";
import {
  CAREER_DIALOGUE_CONTEXT_BUDGETS,
  buildCareerDialogueContext,
  estimateContextTokens,
} from "./contextBudget";
import type { SummaryAttempt } from "./conversationSummaryCommit";
import {
  additionalDroppedTurnsBeyondCoverage,
  conversationSummaryBackoffElapsed,
  selectConversationSummaryCoverage,
  shouldOpenConversationSummaryTask,
  storedSummaryMessages,
  summaryAgeTurns,
  summaryBoundaryUnderStoragePressure,
  SUMMARY_REFRESH_DROPPED_TURNS,
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
    if (!snapshot?.resolvedConnectionId || !snapshot.resolvedModel) {
      return finish({ status: "skipped", reason: "legacy" });
    }
    const messages = storedSummaryMessages(snapshot.messages);
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

    const verdict = validateConversationSummaryCoverage(snapshot.summary, messages);
    const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages });
    if (!budget.ok) return finish({ status: "skipped", reason: "budget" });
    const pressure =
      verdict.status === "FRESH" &&
      snapshot.summary?.throughMessageId != null &&
      summaryBoundaryUnderStoragePressure(messages, snapshot.summary.throughMessageId);
    const additional =
      verdict.status === "FRESH"
        ? additionalDroppedTurnsBeyondCoverage(messages, verdict.throughIndex)
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

    const target = selectConversationSummaryCoverage(messages, {
      extendForStorageCap: trigger === "pressure",
    });
    if (!target) return finish({ status: "skipped", reason: "no_boundary" });
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
        prompt: buildCareerDialogueSummaryPrompt(projection),
      });
      raw = executed.text ?? "";
    } catch {
      const nextFailureCount = await recordFailure(deps, input);
      logSummary({
        summaryStatus: "failed",
        summaryCoverage: target.coveredCount,
        summaryUnits: 0,
        summaryAgeTurns: summaryAgeTurns(messages, target.throughIndex),
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
        summaryAgeTurns: summaryAgeTurns(messages, target.throughIndex),
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
      summaryAgeTurns: summaryAgeTurns(messages, target.throughIndex),
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
  } catch {
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

import "server-only";
import { createHash } from "node:crypto";
import type { ManagedAiProvenanceV1 } from "@/lib/ai/managed-provenance";

import type { UIMessage } from "ai";
import { AIBusinessError } from "@/lib/ai/connections";
import { AI_EXECUTION_DEFAULT_TIMEOUT_MS, executeAIConnectionText } from "@/lib/ai/execution";
import { log } from "@/lib/telemetry";
import {
  buildCareerDialogueContext,
  careerDialogueTurnIndexSpans,
  estimateContextTokens,
  resolveCareerDialogueBudgets,
} from "./contextBudget";
import type { SummaryAttempt } from "./conversationSummaryCommit";
import {
  additionalDroppedTurnsBeyondCoverage,
  conversationSummaryBackoffElapsed,
  hashSummaryCoverage,
  isConversationSummaryCircuitOpen,
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
  sanitizeSummaryFocusNote,
} from "./conversationSummaryPrompt";
import {
  createPrismaSummaryRepository,
  type SummaryRepository,
} from "./conversationSummaryStore";
import { refreshManagedMemoryBlockForConversation } from "./longTermMemory.server";

export type SummaryTaskResult = {
  status: "skipped" | "committed" | "discarded" | "failed";
  reason: string;
  generationMs?: number;
  summaryUnits?: number;
  coveredCount?: number;
  droppedTurnCount?: number;
  recentTurnCount?: number;
  failureCount?: number;
  circuitBreakerOpen?: boolean;
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
    /** Managed execution fields — forwarded verbatim to the seam (M4). */
    managedAiProvenance?: ManagedAiProvenanceV1;
    managedResource?: { business: string; resourceKey: string };
    operationId?: string;
    attemptIndex?: number;
  }) => Promise<{ text: string }>;
  onGenerationStart?: () => void;
  onResult?: (result: SummaryTaskResult) => void;
  /**
   * M2.1: a committed compaction rewrites the assembled prefix anyway —
   * the session-frozen managed memory block re-reads the store so the
   * post-compaction prefix stays honest. Optional + swallowed: a missed
   * refresh leaves a slightly stale block, never a failed compaction.
   */
  refreshMemorySnapshot?: (input: { userId: string; conversationId: string }) => Promise<void>;
};

const inFlight = new Map<string, Promise<void>>();
const SUMMARY_GENERATION_MAX_MESSAGES = 50;

export function conversationSummaryInFlight(
  conversationId: string,
): Promise<void> | undefined {
  return inFlight.get(conversationId);
}

export function isConversationCompactionInFlight(conversationId: string): boolean {
  return inFlight.has(conversationId);
}

/**
 * Shared single-flight lock per conversation across auto and manual compaction.
 * Returns `null` immediately when another compaction is already running.
 */
export function acquireConversationCompactionSlot<T>(
  conversationId: string,
  run: () => Promise<T>,
): Promise<T> | null {
  if (inFlight.has(conversationId)) return null;
  const promise = Promise.resolve().then(run);
  const settled = promise
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (inFlight.get(conversationId) === settled) {
        inFlight.delete(conversationId);
      }
    });
  inFlight.set(conversationId, settled);
  return promise;
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
    resolvedProvider?: string | null;
    resolvedBackendKind?: string | null;
    resolvedUpstreamModelId?: string | null;
    messages: UIMessage[];
  },
  deps: SummarySchedulerDeps = defaultSummarySchedulerDeps(),
): { opened: boolean; syncMs: number } {
  const started = performance.now();
  const open = shouldOpenConversationSummaryTask({
    resolvedConnectionId: input.resolvedConnectionId,
    resolvedModel: input.resolvedModel,
    resolvedProvider: input.resolvedProvider,
    resolvedBackendKind: input.resolvedBackendKind,
    resolvedUpstreamModelId: input.resolvedUpstreamModelId,
    messages: input.messages,
  });
  if (!open || inFlight.has(input.conversationId)) {
    return { opened: false, syncMs: performance.now() - started };
  }
  const slot = acquireConversationCompactionSlot(input.conversationId, () =>
    condenseCareerDialogueSummary(
      { userId: input.userId, conversationId: input.conversationId },
      deps,
    ).catch(() => {
      log.info("[agent-chat] summary", {
        summaryStatus: "failed",
        summaryPromptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
      });
    }),
  );
  if (!slot) {
    return { opened: false, syncMs: performance.now() - started };
  }
  return { opened: true, syncMs: performance.now() - started };
}

export async function condenseCareerDialogueSummary(
  input: {
    userId: string;
    conversationId: string;
    mode?: "auto" | "manual";
    focusNote?: string | null;
  },
  deps: SummarySchedulerDeps = defaultSummarySchedulerDeps(),
): Promise<SummaryTaskResult> {
  const mode = input.mode ?? "auto";
  const focusNote = mode === "manual" ? sanitizeSummaryFocusNote(input.focusNote) : undefined;
  const finish = (result: SummaryTaskResult) => {
    deps.onResult?.(result);
    return result;
  };
  try {
    const snapshot = await deps.repository.load(input.userId, input.conversationId);
    if (snapshot?.archived) {
      return finish({ status: "skipped", reason: "archived" });
    }
    if (snapshot?.executionPath === "NATIVE_CODEX_V1") {
      return finish({ status: "skipped", reason: "native_session" });
    }
    if (snapshot?.lockInvalid) {
      // Managed binding drift or a provenance-less managed half-state —
      // surface the stable code, never re-resolve or auto-heal.
      return finish({ status: "failed", reason: snapshot.lockInvalid });
    }
    if (!snapshot?.resolvedConnectionId || !snapshot.resolvedModel) {
      return finish({ status: "skipped", reason: "legacy" });
    }

    const resolvedBudgets = resolveCareerDialogueBudgets({
      model: snapshot.resolvedModel,
      upstreamModelId: snapshot.managed?.provenance.upstreamModelId,
      provider: snapshot.provider,
      backendKind: snapshot.backendKind,
    });
    const budgets = resolvedBudgets.budgets;

    const messages = storedSummaryMessages(snapshot.messages);
    const windowStartIndex = snapshot.messages.length - messages.length;
    const failureCount = snapshot.summary?.failureCount ?? 0;

    if (mode === "auto") {
      if (isConversationSummaryCircuitOpen(failureCount)) {
        return finish({
          status: "skipped",
          reason: "circuit_open",
          failureCount,
          circuitBreakerOpen: true,
        });
      }
      if (
        !conversationSummaryBackoffElapsed(
          failureCount,
          snapshot.summary?.lastFailureAt ?? null,
          deps.now(),
        )
      ) {
        return finish({ status: "skipped", reason: "backoff", failureCount });
      }
    }

    const verdict = validateConversationSummaryCoverage(snapshot.summary, snapshot.messages, {
      maxSummaryTokens: budgets.summaryTokens,
    });
    const budget = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
      budgets,
      autoCompactTriggerTokens: resolvedBudgets.autoCompactTriggerTokens,
    });
    if (!budget.ok) return finish({ status: "skipped", reason: "budget" });

    const liveBudget =
      verdict.status === "FRESH" && snapshot.summary?.throughMessageId
        ? buildCareerDialogueContext({
            profile: "FAST_CHAT",
            messages,
            budgets,
            summary: {
              text: verdict.text,
              throughMessageId: snapshot.summary.throughMessageId,
            },
            autoCompactTriggerTokens: resolvedBudgets.autoCompactTriggerTokens,
          })
        : null;
    const needsThresholdCompaction =
      verdict.status === "FRESH"
        ? liveBudget?.ok
          ? liveBudget.size.needsRecompaction
          : false
        : budget.size.needsRecompaction;

    const pressure =
      verdict.status === "FRESH" &&
      snapshot.summary?.throughMessageId != null &&
      (verdict.throughIndex < windowStartIndex ||
        summaryBoundaryUnderStoragePressure(messages, snapshot.summary.throughMessageId));
    const additional =
      verdict.status === "FRESH"
        ? additionalDroppedTurnsBeyondCoverage(
            messages,
            verdict.throughIndex - windowStartIndex,
            budgets,
          )
        : 0;

    let trigger: "pressure" | "missing" | "threshold" | "refresh" | "manual" | null = null;
    if (mode === "manual") {
      trigger = "manual";
    } else if (pressure) {
      trigger = "pressure";
    } else if (
      verdict.status !== "FRESH" &&
      (budget.size.droppedTurnCount >= 1 || needsThresholdCompaction)
    ) {
      trigger = "missing";
    } else if (verdict.status === "FRESH" && needsThresholdCompaction) {
      trigger = "threshold";
    } else if (verdict.status === "FRESH" && additional >= SUMMARY_REFRESH_DROPPED_TURNS) {
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

    const desired = selectConversationSummaryCoverage(snapshot.messages, {
      extendForStorageCap: trigger === "pressure",
      forceThreshold: trigger === "threshold",
      mode,
      budgets,
      autoCompactTriggerTokens: resolvedBudgets.autoCompactTriggerTokens,
    });
    if (!desired) return finish({ status: "skipped", reason: "no_boundary" });

    if (
      mode === "manual" &&
      verdict.status === "FRESH" &&
      desired.throughIndex <= verdict.throughIndex &&
      !focusNote
    ) {
      return finish({
        status: "skipped",
        reason: "already_compacted",
        coveredCount: snapshot.summary?.coveredCount ?? undefined,
        droppedTurnCount: budget.size.droppedTurnCount,
        recentTurnCount: budget.size.recentTurnCount,
      });
    }

    const sameBoundaryWithFocus =
      mode === "manual" &&
      Boolean(focusNote) &&
      verdict.status === "FRESH" &&
      desired.throughIndex <= verdict.throughIndex;

    let startIndex =
      !sameBoundaryWithFocus && verdict.status === "FRESH" ? verdict.throughIndex + 1 : 0;
    const previousSummary = verdict.status === "FRESH" ? verdict.text : undefined;
    let coveredCount = startIndex;

    if (sameBoundaryWithFocus) {
      // Re-compact the already-covered boundary with the user's focus hint.
      // Bound the re-projected tail if the prefix exceeds prompt limits while
      // still carrying `previousSummary` cumulatively.
      const maxIndex = desired.throughIndex;
      const minStart = Math.max(0, maxIndex + 1 - SUMMARY_GENERATION_MAX_MESSAGES);
      const spans = careerDialogueTurnIndexSpans(snapshot.messages).filter(
        (span) => span.complete && span.lastIndex <= maxIndex && span.firstIndex >= minStart,
      );
      let chosenFirst = minStart;
      for (let i = 0; i < spans.length; i++) {
        const candidateStart = spans[i]!.firstIndex;
        const delta = snapshot.messages.slice(candidateStart, maxIndex + 1);
        if (!turnEligible(delta, delta.map((message) => message.id))) continue;
        const candidatePrompt = buildCareerDialogueSummaryPrompt(
          projectConversationSummaryInput(delta),
          previousSummary,
          { focusNote, targetMaxTokens: budgets.summaryTokens },
        );
        if (estimateContextTokens(candidatePrompt) <= budgets.dynamicTokens) {
          chosenFirst = candidateStart;
          break;
        }
        chosenFirst = candidateStart;
      }
      startIndex = chosenFirst;
      coveredCount = maxIndex + 1;
    } else {
      // Bound the next contiguous delta, never an arbitrary recent window.
      // A turn that cannot fit is left uncovered rather than sliced or skipped.
      for (const span of careerDialogueTurnIndexSpans(snapshot.messages)) {
        if (span.lastIndex < startIndex) continue;
        if (
          span.firstIndex < startIndex ||
          !span.complete ||
          span.lastIndex > desired.throughIndex
        ) {
          break;
        }
        const delta = snapshot.messages.slice(startIndex, span.lastIndex + 1);
        if (
          delta.length > SUMMARY_GENERATION_MAX_MESSAGES ||
          !turnEligible(delta, delta.map((message) => message.id))
        ) {
          break;
        }
        const prompt = buildCareerDialogueSummaryPrompt(
          projectConversationSummaryInput(delta),
          previousSummary,
          { focusNote, targetMaxTokens: budgets.summaryTokens },
        );
        if (estimateContextTokens(prompt) > budgets.dynamicTokens) break;
        coveredCount = span.lastIndex + 1;
      }
    }

    if (coveredCount <= startIndex && !sameBoundaryWithFocus) {
      return finish({ status: "skipped", reason: "no_boundary" });
    }
    const authoritativePrefix = snapshot.messages.slice(0, coveredCount);
    if (!turnEligible(authoritativePrefix, authoritativePrefix.map((message) => message.id))) {
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
      !sameBoundaryWithFocus &&
      target.throughIndex <= verdict.throughIndex
    ) {
      return finish({ status: "skipped", reason: "not_newer" });
    }
    const projection = projectConversationSummaryInput(target.prefix);
    if (!projection.trim()) return finish({ status: "skipped", reason: "empty_projection" });

    deps.onGenerationStart?.();
    const started = deps.now();
    let raw = "";
    const manualFocusHash = focusNote
      ? createHash("sha256").update(focusNote).digest("hex").slice(0, 8)
      : "plain";
    const operationId =
      mode === "manual"
        ? `dialogue:${input.conversationId}:manual-compact:${target.coverageHash.slice(0, 16)}:r${snapshot.summary?.revision ?? 0}:${manualFocusHash}`
        : `dialogue:${input.conversationId}:summary:${target.coverageHash.slice(0, 16)}`;

    try {
      const executed = await deps.executeText({
        userId: input.userId,
        connectionId: snapshot.resolvedConnectionId,
        model: snapshot.resolvedModel,
        prompt: buildCareerDialogueSummaryPrompt(projection, previousSummary, {
          focusNote,
          targetMaxTokens: budgets.summaryTokens,
        }),
        // M4: the summary is a business operation of the conversation's
        // binding — identity is deterministic per coverage delta, so a
        // retried summary of the same coverage replays.
        ...(snapshot.managed
          ? {
              managedAiProvenance: snapshot.managed.provenance,
              managedResource: {
                business: "CAREER_DIALOGUE",
                resourceKey: `conversation:${input.conversationId}`,
              },
              operationId,
              attemptIndex: 0,
            }
          : {}),
      });
      raw = executed.text ?? "";
    } catch (error) {
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
        // Stable business codes survive the boundary instead of collapsing
        // into "provider" — they are diagnosable in logs and callers.
        reason: error instanceof AIBusinessError ? error.code : "provider",
        failureCount: nextFailureCount,
        circuitBreakerOpen: isConversationSummaryCircuitOpen(nextFailureCount),
        coveredCount: target.coveredCount,
        droppedTurnCount: budget.size.droppedTurnCount,
        recentTurnCount: budget.size.recentTurnCount,
      });
    }

    const text = raw.trim();
    const units = estimateContextTokens(text);
    const generationMs = Math.max(0, Math.round(deps.now() - started));
    if (!text || units > budgets.summaryTokens) {
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
        circuitBreakerOpen: isConversationSummaryCircuitOpen(nextFailureCount),
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
    const outcome = await deps.repository.commit(input.userId, input.conversationId, attempt, {
      maxSummaryTokens: budgets.summaryTokens,
    });
    if (outcome === "committed") {
      await deps.refreshMemorySnapshot?.(input).catch(() => undefined);
    }
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
      circuitBreakerOpen:
        outcome === "committed" ? false : isConversationSummaryCircuitOpen(failureCount),
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

export function defaultSummarySchedulerDeps(): SummarySchedulerDeps {
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
        // Managed fields forward verbatim — dropping provenance/operation
        // identity here would fail every managed summary with
        // INVOCATION_ID_REQUIRED.
        managedAiProvenance: input.managedAiProvenance,
        managedResource: input.managedResource,
        operationId: input.operationId,
        attemptIndex: input.attemptIndex,
      });
      return { text: result.text };
    },
    refreshMemorySnapshot: (input) =>
      refreshManagedMemoryBlockForConversation(input.userId, input.conversationId),
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

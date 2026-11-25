import "server-only";
import { createHash } from "node:crypto";
import type { ManagedAiProvenanceV1 } from "@/lib/ai/managed-provenance";
import { decodeManagedAiProvenance } from "@/lib/ai/managed-provenance";
import { AIBusinessError } from "@/lib/ai/connections";
import { AI_EXECUTION_DEFAULT_TIMEOUT_MS, executeAIConnectionText } from "@/lib/ai/execution";
import { log } from "@/lib/telemetry";
import prisma from "@/lib/db";
import { loadAgentPreferences } from "./preferences.server";
import { upsertUserMemoryEntry } from "./longTermMemory.server";
import {
  buildMemoryExtractionPrompt,
  extractMemorySourceText,
  longTermMemoryPrefilter,
  parseMemoryCandidates,
  sanitizeMemoryCandidate,
} from "./longTermMemory";
import {
  conversationSummaryBackoffElapsed,
  isConversationSummaryCircuitOpen,
} from "./conversationSummaryCoverage";

export type MemoryExtractionResult = {
  status: "skipped" | "committed" | "failed";
  reason: string;
  extractedCount?: number;
  failureCount?: number;
  circuitBreakerOpen?: boolean;
};

export type MemoryExtractionConversation = {
  archived: boolean;
  resolvedConnectionId: string | null;
  resolvedModel: string | null;
  managedAiProvenance: string | null;
  messages: unknown;
};

export type MemoryExtractionStore = {
  loadConversation(
    userId: string,
    conversationId: string,
  ): Promise<MemoryExtractionConversation | null>;
  upsert(input: {
    userId: string;
    category: string;
    key: string;
    content: string;
    sourceConversationId?: string | null;
  }): Promise<unknown>;
  memoryEnabled(userId: string): Promise<boolean>;
};

export type MemoryExtractionDeps = {
  now: () => number;
  store: MemoryExtractionStore;
  executeText: (input: {
    userId: string;
    connectionId: string;
    model: string;
    prompt: string;
    managedAiProvenance?: ManagedAiProvenanceV1;
    managedResource?: { business: string; resourceKey: string };
    operationId?: string;
    attemptIndex?: number;
  }) => Promise<{ text: string }>;
};

/** Single-flight + consecutive-failure state, per conversation. */
const inFlight = new Map<string, Promise<void>>();
const failureState = new Map<string, { failures: number; lastFailureAt: number | null }>();

export function resetLongTermMemoryExtractionForTests(): void {
  inFlight.clear();
  failureState.clear();
}

const MAX_EXTRACTION_CANDIDATES = 8;

function failureKey(userId: string, conversationId: string): string {
  return `${userId}:${conversationId}`;
}

function recordFailure(key: string, now: number): number {
  const state = failureState.get(key) ?? { failures: 0, lastFailureAt: null };
  state.failures += 1;
  state.lastFailureAt = now;
  failureState.set(key, state);
  return state.failures;
}

/**
 * Post-turn entry point — synchronous gate, detached work. Never throws,
 * never blocks the streaming response; a dropped extraction only delays
 * memory learning, never breaks a turn.
 */
export function scheduleLongTermMemoryExtraction(
  input: { userId: string; conversationId: string },
  deps: MemoryExtractionDeps = defaultMemoryExtractionDeps(),
): { opened: boolean } {
  const key = failureKey(input.userId, input.conversationId);
  if (inFlight.has(key)) return { opened: false };
  const promise = Promise.resolve()
    .then(() => runLongTermMemoryExtraction(input, deps))
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (inFlight.get(key) === promise) inFlight.delete(key);
    });
  inFlight.set(key, promise);
  return { opened: true };
}

async function runLongTermMemoryExtraction(
  input: { userId: string; conversationId: string },
  deps: MemoryExtractionDeps,
): Promise<MemoryExtractionResult> {
  const key = failureKey(input.userId, input.conversationId);
  const finish = (result: MemoryExtractionResult) => {
    if (result.status === "failed") {
      log.info("[agent-chat] memory", { memoryStatus: "failed", reason: result.reason });
    }
    return result;
  };
  try {
    if (!(await deps.store.memoryEnabled(input.userId))) {
      return finish({ status: "skipped", reason: "disabled" });
    }
    const snapshot = await deps.store.loadConversation(input.userId, input.conversationId);
    if (!snapshot) return finish({ status: "skipped", reason: "missing" });
    if (snapshot.archived) return finish({ status: "skipped", reason: "archived" });
    if (!snapshot.resolvedConnectionId || !snapshot.resolvedModel) {
      return finish({ status: "skipped", reason: "legacy" });
    }

    const messages = Array.isArray(snapshot.messages) ? snapshot.messages : [];
    const transcript = extractMemorySourceText(
      messages as ReadonlyArray<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>,
    );
    // Zero-cost local prefilter: ordinary small talk never reaches a model.
    if (!transcript || !longTermMemoryPrefilter(transcript)) {
      return finish({ status: "skipped", reason: "no_signal" });
    }

    const state = failureState.get(key) ?? { failures: 0, lastFailureAt: null };
    if (isConversationSummaryCircuitOpen(state.failures)) {
      return finish({
        status: "skipped",
        reason: "circuit_open",
        failureCount: state.failures,
        circuitBreakerOpen: true,
      });
    }
    if (
      !conversationSummaryBackoffElapsed(
        state.failures,
        state.lastFailureAt === null ? null : new Date(state.lastFailureAt),
        deps.now(),
      )
    ) {
      return finish({ status: "skipped", reason: "backoff", failureCount: state.failures });
    }

    const transcriptHash = createHash("sha256").update(transcript).digest("hex").slice(0, 16);
    const provenance = decodeManagedAiProvenance(snapshot.managedAiProvenance);

    let raw = "";
    try {
      const executed = await deps.executeText({
        userId: input.userId,
        connectionId: snapshot.resolvedConnectionId,
        model: snapshot.resolvedModel,
        prompt: buildMemoryExtractionPrompt(transcript),
        ...(provenance
          ? {
              managedAiProvenance: provenance,
              managedResource: {
                business: "CAREER_DIALOGUE",
                resourceKey: `conversation:${input.conversationId}`,
              },
              // Deterministic per extracted content: a retry of the same
              // transcript replays instead of double-billing.
              operationId: `dialogue:${input.conversationId}:memory:${transcriptHash}`,
              attemptIndex: 0,
            }
          : {}),
      });
      raw = executed.text ?? "";
    } catch (error) {
      const failureCount = recordFailure(key, deps.now());
      return finish({
        status: "failed",
        reason: error instanceof AIBusinessError ? error.code : "provider",
        failureCount,
        circuitBreakerOpen: isConversationSummaryCircuitOpen(failureCount),
      });
    }

    const candidates = parseMemoryCandidates(raw).slice(0, MAX_EXTRACTION_CANDIDATES);
    // Deterministic re-validation: extractor output is untrusted input.
    const valid = candidates
      .map((candidate) => sanitizeMemoryCandidate(candidate))
      .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

    let written = 0;
    for (const candidate of valid) {
      try {
        await deps.store.upsert({
          userId: input.userId,
          category: candidate.category,
          key: candidate.key,
          content: candidate.content,
          sourceConversationId: input.conversationId,
        });
        written += 1;
      } catch {
        // One bad candidate must not poison the rest of the batch.
      }
    }

    // Successful extraction clears the failure streak even when the model
    // found nothing worth remembering — an empty result is a valid answer.
    failureState.delete(key);
    log.info("[agent-chat] memory", { memoryStatus: "committed", extractedCount: written });
    return finish({ status: "committed", reason: "extracted", extractedCount: written });
  } catch (error) {
    if (error instanceof AIBusinessError) {
      const failureCount = recordFailure(key, deps.now());
      return finish({
        status: "failed",
        reason: error.code,
        failureCount,
        circuitBreakerOpen: isConversationSummaryCircuitOpen(failureCount),
      });
    }
    recordFailure(key, deps.now());
    return finish({ status: "failed", reason: "unexpected" });
  }
}

export function defaultMemoryExtractionDeps(): MemoryExtractionDeps {
  return {
    now: () => Date.now(),
    store: {
      loadConversation: async (userId, conversationId) => {
        const row = await prisma.chatConversation.findFirst({
          where: { id: conversationId, userId },
          select: {
            archivedAt: true,
            resolvedConnectionId: true,
            resolvedModel: true,
            managedAiProvenance: true,
            messages: true,
          },
        });
        if (!row) return null;
        let messages: unknown = [];
        try {
          messages = JSON.parse(row.messages);
        } catch {
          messages = [];
        }
        return {
          archived: row.archivedAt !== null,
          resolvedConnectionId: row.resolvedConnectionId,
          resolvedModel: row.resolvedModel,
          managedAiProvenance: row.managedAiProvenance,
          messages,
        };
      },
      upsert: (input) => upsertUserMemoryEntry(input),
      memoryEnabled: async (userId) =>
        (await loadAgentPreferences(userId)).longTermMemoryEnabled,
    },
    executeText: async (input) => {
      const result = await executeAIConnectionText({
        userId: input.userId,
        connectionId: input.connectionId,
        model: input.model,
        prompt: input.prompt,
        timeoutMs: AI_EXECUTION_DEFAULT_TIMEOUT_MS,
        managedAiProvenance: input.managedAiProvenance,
        managedResource: input.managedResource,
        operationId: input.operationId,
        attemptIndex: input.attemptIndex,
      });
      return { text: result.text };
    },
  };
}

/**
 * Native path only: poll the claimed request until finish/cancel releases
 * it, then run the ordinary extraction gate. Detached — the caller never
 * awaits this and the turn is never blocked by memory work.
 */
export function scheduleNativeMemoryExtractionAfterRelease(
  request: { released: boolean },
  input: { userId: string; conversationId: string },
  options: { timeoutMs?: number; intervalMs?: number } = {},
): void {
  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const intervalMs = options.intervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    while (!request.released && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
    if (!request.released) return;
    scheduleLongTermMemoryExtraction(input);
  };
  void poll().catch(() => undefined);
}

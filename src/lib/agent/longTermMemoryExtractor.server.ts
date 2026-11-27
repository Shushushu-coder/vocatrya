import "server-only";
import { createHash } from "node:crypto";
import type { ManagedAiProvenanceV1 } from "@/lib/ai/managed-provenance";
import { decodeManagedAiProvenance } from "@/lib/ai/managed-provenance";
import { AIBusinessError, classifyAIConnection } from "@/lib/ai/connections";
import { AI_EXECUTION_DEFAULT_TIMEOUT_MS, executeAIConnectionText } from "@/lib/ai/execution";
import { log } from "@/lib/telemetry";
import prisma from "@/lib/db";
import { loadAgentPreferences } from "./preferences.server";
import { applyMemoryCurationAction } from "./longTermMemory.server";
import {
  buildMemoryExtractionPrompt,
  classifyMemorySignalDelta,
  collectApprovalSignalLines,
  extractMemorySourceText,
  formatExistingMemoryForPrompt,
  parseMemoryCandidates,
  sanitizeMemoryAction,
  type MemoryCurationAction,
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
  /**
   * Identity class of the conversation's resolved connection (null when
   * the row is gone). The account-attribution gate reads this: provenance-
   * free sessions (ACCOUNT_LOGIN / native seats / unclassified) must stay
   * inside their own connection — no cross-account slot ever applies.
   */
  connectionClass: "MANAGED" | "BYOK" | "ACCOUNT_LOGIN" | "INVALID" | null;
  messages: unknown;
};

export type RouterExtractionSlotResult =
  | { kind: "absent" }
  | { kind: "invalid"; reason: string }
  | {
      kind: "resolved";
      connectionId: string;
      model: string;
      managedAiProvenance: ManagedAiProvenanceV1 | null;
      connectionClass: "MANAGED" | "BYOK";
    };

export type MemoryExtractionStore = {
  loadConversation(
    userId: string,
    conversationId: string,
  ): Promise<MemoryExtractionConversation | null>;
  /**
   * Optional D07 Router lightweight-model slot lookup (`AGENT_ROUTER`).
   * Only consulted for MANAGED / BYOK turns; independent ACCOUNT_LOGIN seats
   * never cross-account into this slot.
   */
  resolveRouterSlot?(userId: string): Promise<RouterExtractionSlotResult>;
  /** Current memory rows for the state-aware curation prompt. */
  listEntries(
    userId: string,
  ): Promise<Array<{ category: string; key: string; content: string; source: string }>>;
  /**
   * Apply one curator action. The store enforces the lock contract —
   * USER_MANUAL rows are never touched — and reports whether the action
   * landed (a "locked"/"missing" refusal is a valid outcome, not an error).
   */
  applyAction(input: {
    userId: string;
    action: MemoryCurationAction;
    sourceConversationId?: string | null;
  }): Promise<{ applied: boolean }>;
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
    disableReasoning?: boolean;
    maxOutputTokens?: number;
    managedAiProvenance?: ManagedAiProvenanceV1;
    managedResource?: { business: string; resourceKey: string };
    operationId?: string;
    attemptIndex?: number;
  }) => Promise<{ text: string }>;
  /** Weak-signal events accumulated before the gate fires (default 3). */
  weakTurnThreshold?: number;
  /** Idle debounce before pending weak signals fire (default 90s). */
  weakDebounceMs?: number;
};

/** Single-flight + consecutive-failure state, per conversation. */
const inFlight = new Map<string, Promise<void>>();
const failureState = new Map<string, { failures: number; lastFailureAt: number | null }>();

/**
 * M2.1 tiered-gate state, per conversation. `throughCount` is the count of
 * stored messages the gate already classified — the delta beyond it is
 * what each post-turn schedule evaluates. `weakTurns` accumulates weak
 * events until the multi-turn threshold fires; `timer` is the idle
 * debounce that fires them when the conversation has been quiet.
 * In-memory only — like the L2 scheduler's compaction state it is
 * best-effort learning, not business state; a restart just relearns.
 */
const signalGateState = new Map<
  string,
  { throughCount: number; weakTurns: number; timer?: ReturnType<typeof setTimeout> }
>();

export function resetLongTermMemoryExtractionForTests(): void {
  inFlight.clear();
  failureState.clear();
  for (const state of signalGateState.values()) {
    if (state.timer) clearTimeout(state.timer);
  }
  signalGateState.clear();
}

const MAX_EXTRACTION_CANDIDATES = 8;
export const WEAK_SIGNAL_TURN_THRESHOLD = 3;
export const WEAK_SIGNAL_DEBOUNCE_MS = 90_000;

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
 * In-account target resolution (D07 §2.9.4 + D08):
 * - Independent account sessions (ACCOUNT_LOGIN / native Codex seats /
 *   unclassified rows) ALWAYS stay inside their own connection — never
 *   cross-account into `AGENT_ROUTER`.
 * - MANAGED and BYOK turns transparently reuse `AGENT_ROUTER` when explicitly
 *   configured with a valid BYOK/MANAGED connection.
 * - If `AGENT_ROUTER` is explicitly configured but currently broken/invalid,
 *   return `{ skip: true }` so background curation circuit-skips quietly
 *   without blocking foreground chat or spending an unintended connection.
 */
async function resolveMemoryExtractionTarget(
  userId: string,
  snapshot: MemoryExtractionConversation,
  store: MemoryExtractionStore,
): Promise<
  | { skip: true; reason: string }
  | {
      skip: false;
      connectionId: string;
      model: string;
      managedAiProvenance: ManagedAiProvenanceV1 | null;
      viaRouter: boolean;
    }
> {
  const provenance = decodeManagedAiProvenance(snapshot.managedAiProvenance);
  const lock = {
    skip: false as const,
    connectionId: snapshot.resolvedConnectionId!,
    model: snapshot.resolvedModel!,
    managedAiProvenance: provenance,
    viaRouter: false,
  };
  const accountBound = provenance === null && snapshot.connectionClass !== "BYOK";
  if (accountBound) return lock;
  if (!store.resolveRouterSlot) return lock;
  const routerSlot = await store.resolveRouterSlot(userId).catch(() => ({ kind: "absent" as const }));
  if (routerSlot.kind === "invalid") {
    return { skip: true, reason: `router_${routerSlot.reason}` };
  }
  if (routerSlot.kind === "resolved") {
    // Only reuse when the Router slot itself is BYOK/MANAGED — never cross-bill
    // an independent ACCOUNT_LOGIN connection.
    return {
      skip: false,
      connectionId: routerSlot.connectionId,
      model: routerSlot.model,
      managedAiProvenance: routerSlot.managedAiProvenance,
      viaRouter: true,
    };
  }
  return lock;
}

/**
 * Post-turn entry point — synchronous gate, detached work. Never throws,
 * never blocks the streaming response; a dropped extraction only delays
 * memory learning, never breaks a turn. `forced` is internal: the idle-
 * debounce timer re-enters through the same single-flight with the weak-
 * signal classification bypassed.
 */
export function scheduleLongTermMemoryExtraction(
  input: { userId: string; conversationId: string },
  deps: MemoryExtractionDeps = defaultMemoryExtractionDeps(),
  options: { forced?: boolean } = {},
): { opened: boolean } {
  const key = failureKey(input.userId, input.conversationId);
  if (inFlight.has(key)) return { opened: false };
  const promise = Promise.resolve()
    .then(() => runLongTermMemoryExtraction(input, deps, options.forced === true))
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

export async function runLongTermMemoryExtraction(
  input: { userId: string; conversationId: string },
  deps: MemoryExtractionDeps,
  forced: boolean,
): Promise<MemoryExtractionResult> {
  const key = failureKey(input.userId, input.conversationId);
  const finish = (result: MemoryExtractionResult) => {
    if (result.status === "failed") {
      log.info("[agent-chat] memory", { memoryStatus: "failed", reason: result.reason });
    }
    return result;
  };
  const gate = signalGateState.get(key) ?? { throughCount: 0, weakTurns: 0 };
  signalGateState.set(key, gate);
  const armIdleTimer = (): void => {
    if (gate.timer) clearTimeout(gate.timer);
    gate.timer = setTimeout(() => {
      gate.timer = undefined;
      scheduleLongTermMemoryExtraction(input, deps, { forced: true });
    }, deps.weakDebounceMs ?? WEAK_SIGNAL_DEBOUNCE_MS);
    gate.timer.unref?.();
  };
  const disarmIdleTimer = (): void => {
    if (gate.timer) {
      clearTimeout(gate.timer);
      gate.timer = undefined;
    }
  };
  // Assigned once the run's delta is classified; a failure that reaches
  // the outer catch after consumption rolls it back so the next schedule
  // re-classifies the same signals instead of silently dropping them.
  let rollbackDelta: (() => void) | null = null;
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

    const messages = Array.isArray(snapshot.messages)
      ? (snapshot.messages as ReadonlyArray<{
          role?: string;
          parts?: Array<{ type?: string; text?: string; approval?: { approved?: boolean; reason?: string } | null }>;
        }>)
      : [];

    // Delta classification — throughCount advances only when the delta is
    // actually consumed: either deferred (weak/none waits for the idle
    // debounce) or attempted. A backoff/circuit skip or a failed call must
    // never strand a strong signal behind an already-advanced counter.
    const delta = messages.slice(Math.min(gate.throughCount, messages.length));
    const { signal, weakTurns: deltaWeakTurns } = classifyMemorySignalDelta(delta);
    const weakAfter = signal === "weak" ? gate.weakTurns + deltaWeakTurns : gate.weakTurns;
    let consumed = false;
    const consumeDelta = (): void => {
      consumed = true;
      gate.throughCount = messages.length;
      gate.weakTurns = weakAfter;
    };
    rollbackDelta = (): void => {
      if (!consumed) return;
      consumed = false;
      gate.throughCount = Math.max(0, gate.throughCount - delta.length);
      if (signal === "weak") {
        gate.weakTurns = Math.max(0, gate.weakTurns - deltaWeakTurns);
      }
    };

    if (
      !forced &&
      signal !== "strong" &&
      weakAfter < (deps.weakTurnThreshold ?? WEAK_SIGNAL_TURN_THRESHOLD)
    ) {
      // Below-threshold weak evidence (or none) waits for the idle
      // debounce — while pending events exist the timer refreshes on
      // every quiet turn, so extraction fires once the conversation
      // has actually been idle for weakDebounceMs.
      consumeDelta();
      if (gate.weakTurns > 0) armIdleTimer();
      return finish({
        status: "skipped",
        reason: signal === "none" ? "no_signal" : "weak_debounce",
      });
    }
    // Proceeding to extraction: the idle timer has served its purpose.
    disarmIdleTimer();

    const transcript = extractMemorySourceText(messages);
    const approvalSignals = collectApprovalSignalLines(messages.slice(-12));
    // A reasoned rejection can be the whole signal: even with no
    // user→assistant text on record, the approval reasons themselves are
    // the curation input and must not strand the turn at no_signal.
    if (!transcript && approvalSignals.length === 0) {
      consumeDelta();
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
    consumeDelta();

    const transcriptHash = createHash("sha256").update(transcript).digest("hex").slice(0, 16);
    const target = await resolveMemoryExtractionTarget(input.userId, snapshot, deps.store);
    if (target.skip) {
      return finish({ status: "skipped", reason: target.reason });
    }
    const existingMemory = formatExistingMemoryForPrompt(await deps.store.listEntries(input.userId));
    const prompt = buildMemoryExtractionPrompt({
      transcript: transcript || "(无对话文本 —— 仅依据下方纠偏信号抽取)",
      existingMemory,
      approvalSignals,
    });

    let raw = "";
    try {
      const executed = await deps.executeText({
        userId: input.userId,
        connectionId: target.connectionId,
        model: target.model,
        prompt,
        disableReasoning: true,
        maxOutputTokens: 400,
        ...(target.managedAiProvenance
          ? {
              managedAiProvenance: target.managedAiProvenance,
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
      rollbackDelta?.();
      const failureCount = recordFailure(key, deps.now());
      return finish({
        status: "failed",
        reason: error instanceof AIBusinessError ? error.code : "provider",
        failureCount,
        circuitBreakerOpen: isConversationSummaryCircuitOpen(failureCount),
      });
    }

    const actions = parseMemoryCandidates(raw)
      .slice(0, MAX_EXTRACTION_CANDIDATES)
      .map(sanitizeMemoryAction)
      .filter((action): action is MemoryCurationAction => action !== null);

    let written = 0;
    for (const action of actions) {
      try {
        const outcome = await deps.store.applyAction({
          userId: input.userId,
          action,
          sourceConversationId: input.conversationId,
        });
        if (outcome.applied) written += 1;
      } catch {
        // One bad action must not poison the rest of the batch.
      }
    }

    // Successful extraction clears the failure streak and the accumulated
    // weak-signal count — an empty result is a valid answer too.
    failureState.delete(key);
    gate.weakTurns = 0;
    log.info("[agent-chat] memory", { memoryStatus: "committed", extractedCount: written });
    return finish({ status: "committed", reason: "extracted", extractedCount: written });
  } catch (error) {
    rollbackDelta?.();
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
        let effectiveConnectionId = row.resolvedConnectionId;
        let effectiveModel = row.resolvedModel;
        let connectionClass: MemoryExtractionConversation["connectionClass"] = null;
        // Unified conversations lock connection/model per ChatTurnStep rather
        // than on ChatConversation: inspect the latest turn's completed steps
        // so BYOK/MANAGED steps can use AGENT_ROUTER while pure ACCOUNT_LOGIN
        // turns stay strictly inside their own seat.
        const latestTurn = await prisma.chatTurn.findFirst({
          where: { conversationId, userId },
          orderBy: { createdAt: "desc" },
          include: {
            steps: {
              where: { status: "COMPLETED", resolvedConnectionId: { not: null }, resolvedModel: { not: null } },
              orderBy: { stepIndex: "desc" },
            },
          },
        }).catch(() => null);
        if (latestTurn && latestTurn.steps.length > 0) {
          const stepConnections = await prisma.aIConnection.findMany({
            where: {
              userId,
              id: { in: latestTurn.steps.map((s) => s.resolvedConnectionId!).filter(Boolean) },
            },
            select: {
              id: true,
              provider: true,
              backendKind: true,
              authType: true,
              credentialRef: true,
              runtimeProfileRef: true,
              accountIdentity: true,
            },
          });
          const byId = new Map(stepConnections.map((c) => [c.id, classifyAIConnection(c)]));
          const managedOrByokStep = latestTurn.steps.find((s) => {
            const cls = s.resolvedConnectionId ? byId.get(s.resolvedConnectionId) : undefined;
            return cls === "BYOK" || cls === "MANAGED";
          });
          const chosen = managedOrByokStep ?? latestTurn.steps[0];
          effectiveConnectionId = chosen.resolvedConnectionId;
          effectiveModel = chosen.resolvedModel;
          connectionClass = chosen.resolvedConnectionId ? (byId.get(chosen.resolvedConnectionId) ?? null) : null;
        } else if (effectiveConnectionId) {
          const connection = await prisma.aIConnection.findFirst({
            where: { id: effectiveConnectionId, userId },
            select: {
              provider: true,
              backendKind: true,
              authType: true,
              credentialRef: true,
              runtimeProfileRef: true,
              accountIdentity: true,
            },
          });
          if (connection) connectionClass = classifyAIConnection(connection);
        }
        let messages: unknown = [];
        try {
          messages = JSON.parse(row.messages);
        } catch {
          messages = [];
        }
        return {
          archived: row.archivedAt !== null,
          resolvedConnectionId: effectiveConnectionId,
          resolvedModel: effectiveModel,
          managedAiProvenance: row.managedAiProvenance,
          connectionClass,
          messages,
        };
      },
      resolveRouterSlot: async (userId) => {
        const assignment = await prisma.aIBusinessAssignment.findUnique({
          where: { userId_purpose: { userId, purpose: "AGENT_ROUTER" } },
          select: {
            model: true,
            connectionId: true,
            connection: {
              select: {
                id: true,
                userId: true,
                status: true,
                archivedAt: true,
                provider: true,
                backendKind: true,
                authType: true,
                credentialRef: true,
                runtimeProfileRef: true,
                accountIdentity: true,
              },
            },
          },
        });
        if (!assignment) return { kind: "absent" };
        const conn = assignment.connection;
        if (!conn || conn.userId !== userId || conn.archivedAt !== null || conn.status !== "CONNECTED" || !assignment.model.trim()) {
          return { kind: "invalid", reason: "unavailable" };
        }
        const cls = classifyAIConnection(conn);
        if (cls !== "BYOK" && cls !== "MANAGED") {
          // Independent ACCOUNT_LOGIN router must not be cross-billed by background memory.
          return { kind: "absent" };
        }
        return {
          kind: "resolved",
          connectionId: conn.id,
          model: assignment.model.trim(),
          managedAiProvenance: null,
          connectionClass: cls,
        };
      },
      listEntries: async (userId) =>
        prisma.userMemoryEntry.findMany({
          where: { userId },
          select: { category: true, key: true, content: true, source: true },
          orderBy: [{ category: "asc" }, { key: "asc" }],
        }),
      applyAction: (input) => applyMemoryCurationAction(input),
      memoryEnabled: async (userId) =>
        (await loadAgentPreferences(userId)).longTermMemoryEnabled,
    },
    executeText: async (input) => {
      const result = await executeAIConnectionText({
        userId: input.userId,
        connectionId: input.connectionId,
        model: input.model,
        prompt: input.prompt,
        disableReasoning: input.disableReasoning,
        maxOutputTokens: input.maxOutputTokens,
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

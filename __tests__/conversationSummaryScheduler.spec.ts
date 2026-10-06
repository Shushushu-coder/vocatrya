import type { UIMessage } from "ai";
import { AIBusinessError } from "@/lib/ai/connections";
import {
  buildCareerDialogueContext,
  CAREER_DIALOGUE_CONTEXT_BUDGETS,
  estimateContextTokens,
} from "@/lib/agent/contextBudget";
import {
  persistSummaryAttempt,
  type ConversationSummaryRecord,
  type SummaryAttempt,
} from "@/lib/agent/conversationSummaryCommit";
import {
  additionalDroppedTurnsBeyondCoverage,
  hashSummaryCoverage,
  selectConversationSummaryCoverage,
  SUMMARY_BACKOFF_INITIAL_MS,
  summaryBoundaryUnderStoragePressure,
  validateConversationSummaryCoverage,
} from "@/lib/agent/conversationSummaryCoverage";
import { CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION, projectConversationSummaryInput } from "@/lib/agent/conversationSummaryPrompt";
import {
  condenseCareerDialogueSummary,
  conversationSummaryInFlight,
  resetConversationSummaryInFlightForTests,
  scheduleCareerDialogueSummary,
  type SummarySchedulerDeps,
} from "@/lib/agent/conversationSummaryScheduler";
import type { SummaryRepository } from "@/lib/agent/conversationSummaryStore";

const USER = "user-1";
const CONVERSATION = "conv-1";

function user(id: string, text: string): UIMessage {
  return { id, role: "user", parts: [{ type: "text", text }] };
}

function assistant(id: string, text: string): UIMessage {
  return { id, role: "assistant", parts: [{ type: "text", text }] };
}

function dialogue(turns: number): UIMessage[] {
  const messages: UIMessage[] = [];
  for (let i = 0; i < turns; i++) {
    messages.push(user(`u${i}`, `用户目标 ${i}：准备后端面试并保持简短`));
    messages.push(assistant(`a${i}`, `记下目标 ${i}`));
  }
  return messages;
}

function emptySummary(overrides: Partial<ConversationSummaryRecord> = {}): ConversationSummaryRecord {
  return {
    conversationId: CONVERSATION,
    userId: USER,
    text: null,
    throughMessageId: null,
    coverageHash: null,
    coveredCount: null,
    promptVersion: null,
    revision: 0,
    units: null,
    generationMs: null,
    generatedAt: null,
    failureCount: 0,
    lastFailureAt: null,
    ...overrides,
  };
}

function memoryRepository(seed?: {
  messages?: UIMessage[];
  summary?: ConversationSummaryRecord | null;
  resolvedConnectionId?: string | null;
  resolvedModel?: string | null;
}): SummaryRepository & {
  state: {
    messages: UIMessage[];
    summary: ConversationSummaryRecord | null;
    resolvedConnectionId: string | null;
    resolvedModel: string | null;
  };
} {
  const state = {
    messages: seed?.messages ?? [],
    summary: seed?.summary ?? null,
    resolvedConnectionId: seed?.resolvedConnectionId === undefined ? "conn-locked" : seed.resolvedConnectionId,
    resolvedModel: seed?.resolvedModel === undefined ? "model-locked" : seed.resolvedModel,
  };
  return {
    state,
    async load() {
      return {
        messages: state.messages,
        summary: state.summary,
        resolvedConnectionId: state.resolvedConnectionId,
        resolvedModel: state.resolvedModel,
      };
    },
    async commit(_userId, _conversationId, attempt) {
      return persistSummaryAttempt({
        reload: async () => ({ messages: state.messages, summary: state.summary }),
        create: async (record) => {
          if (state.summary) return "conflict";
          state.summary = record;
          return "created";
        },
        update: async (expectedRevision, record) => {
          if (!state.summary || state.summary.revision !== expectedRevision) return 0;
          if (state.summary.userId !== record.userId) return 0;
          state.summary = record;
          return 1;
        },
        attempt,
      });
    },
    async recordFailure(_userId, conversationId, at) {
      if (!state.summary) {
        state.summary = emptySummary({ conversationId, failureCount: 1, lastFailureAt: at });
        return 1;
      }
      state.summary = {
        ...state.summary,
        failureCount: state.summary.failureCount + 1,
        lastFailureAt: at,
      };
      return state.summary.failureCount;
    },
  };
}

function mockExecute(
  impl: SummarySchedulerDeps["executeText"] = async () => ({ text: "" }),
) {
  return vi.fn<SummarySchedulerDeps["executeText"]>(impl);
}

function depsFor(
  repo: SummaryRepository,
  executeText: SummarySchedulerDeps["executeText"],
  extras: Partial<SummarySchedulerDeps> = {},
): SummarySchedulerDeps {
  return {
    now: extras.now ?? (() => 1_700_000_000_000),
    repository: repo,
    executeText,
    onGenerationStart: extras.onGenerationStart,
    onResult: extras.onResult,
  };
}

describe("career dialogue summary scheduler", () => {
  it("catches up a 120-message prefix cumulatively, carrying early facts in each prompt", async () => {
    const messages = dialogue(60);
    messages[0] = user("u0", "UNIQUE_CONSTRAINT_ALPHA EARLY_FACT_001");
    const repo = memoryRepository({ messages });
    const prompts: string[] = [];
    const executeText = mockExecute(async ({ prompt }) => {
      prompts.push(prompt);
      expect(prompt).toContain("EARLY_FACT_001");
      return { text: "EARLY_FACT_001 UNIQUE_CONSTRAINT_ALPHA" };
    });
    const deps = depsFor(repo, executeText);
    for (const [pass, expectedCount] of [50, 74, 110].entries()) {
      expect(await condenseCareerDialogueSummary({ userId: USER, conversationId: CONVERSATION }, deps)).toMatchObject({ status: "committed", coveredCount: expectedCount });
      expect(repo.state.summary).toMatchObject({ coveredCount: expectedCount, throughMessageId: messages[expectedCount - 1].id, revision: pass + 1 });
      expect(repo.state.summary?.coverageHash).toBe(hashSummaryCoverage(messages.slice(0, expectedCount)));
      const delta = JSON.parse(prompts[pass].split("New dialogue (JSON data):\n\n")[1]).new_messages as string;
      const start = pass === 0 ? 0 : pass === 1 ? 50 : 74;
      expect(delta).toBe(projectConversationSummaryInput(messages.slice(start, expectedCount)));
      if (pass === 0) expect(prompts[pass]).not.toContain('"previous_summary":');
      else {
        expect(prompts[pass]).toContain('"previous_summary":"EARLY_FACT_001 UNIQUE_CONSTRAINT_ALPHA"');
        expect(delta).not.toContain("EARLY_FACT_001");
      }
      expect(estimateContextTokens(prompts[pass])).toBeLessThanOrEqual(CAREER_DIALOGUE_CONTEXT_BUDGETS.dynamicTokens);
      expect(repo.state.messages).toEqual(messages);
    }
  });
  beforeEach(() => {
    resetConversationSummaryInFlightForTests();
  });

  it("does not create a summary or call a model when nothing has been dropped", async () => {
    const messages = dialogue(3);
    const repo = memoryRepository({ messages });
    const executeText = mockExecute();
    const opened = scheduleCareerDialogueSummary(
      {
        userId: USER,
        conversationId: CONVERSATION,
        resolvedConnectionId: "conn-locked",
        resolvedModel: "model-locked",
        messages,
      },
      depsFor(repo, executeText),
    );
    expect(opened.opened).toBe(false);
    expect(conversationSummaryInFlight(CONVERSATION)).toBeUndefined();
    const result = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText),
    );
    expect(result).toMatchObject({ status: "skipped", reason: "trigger" });
    expect(executeText).not.toHaveBeenCalled();
    expect(repo.state.summary).toBeNull();
    const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages });
    if (!budget.ok) throw new Error(budget.code);
    expect(budget.size.droppedTurnCount).toBe(0);
    expect(budget.summary).toBeUndefined();
  });

  it("writes a fresh summary after the foreground turn and injects it on the next turn", async () => {
    const messages = dialogue(8);
    const repo = memoryRepository({ messages });
    const executeText = mockExecute(async () => ({ text: "用户在准备后端面试，目标按序号保留。" }));
    const result = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText),
    );
    expect(result.status).toBe("committed");
    expect(executeText).toHaveBeenCalledTimes(1);
    expect(executeText.mock.calls[0]?.[0]).toMatchObject({
      connectionId: "conn-locked",
      model: "model-locked",
    });
    const verdict = validateConversationSummaryCoverage(repo.state.summary, messages);
    expect(verdict.status).toBe("FRESH");
    if (verdict.status !== "FRESH") return;
    const next = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages,
      summary: verdict.text,
    });
    if (!next.ok) throw new Error(next.code);
    expect(next.transcript).toContain("Earlier conversation summary:");
    expect(next.transcript).toContain(verdict.text);
    expect(next.size.recentTurnCount).toBeLessThanOrEqual(CAREER_DIALOGUE_CONTEXT_BUDGETS.maxRecentTurns);
    expect(next.size.summaryTokens).toBeLessThanOrEqual(CAREER_DIALOGUE_CONTEXT_BUDGETS.summaryTokens);
    expect(next.size.dynamicTokens).toBeLessThanOrEqual(CAREER_DIALOGUE_CONTEXT_BUDGETS.dynamicTokens);
  });

  it("returns the foreground turn before a slow summary generation finishes", async () => {
    const messages = dialogue(8);
    const repo = memoryRepository({ messages });
    const order: string[] = [];
    let release: (value: { text: string }) => void = () => {};
    const executeText = mockExecute(
      () =>
        new Promise<{ text: string }>((resolve) => {
          release = resolve;
        }),
    );
    order.push("stream-complete");
    const started = performance.now();
    const ack = scheduleCareerDialogueSummary(
      {
        userId: USER,
        conversationId: CONVERSATION,
        resolvedConnectionId: "conn-locked",
        resolvedModel: "model-locked",
        messages,
      },
      depsFor(repo, executeText, {
        onGenerationStart: () => order.push("summary-start"),
      }),
    );
    expect(performance.now() - started).toBeLessThan(200);
    expect(ack.opened).toBe(true);
    expect(ack.syncMs).toBeLessThan(200);
    expect(order).toEqual(["stream-complete"]);
    let foregroundDone = true;
    const pending = conversationSummaryInFlight(CONVERSATION);
    expect(pending).toBeDefined();
    const finished = pending!.then(() => {
      expect(foregroundDone).toBe(true);
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(repo.state.summary?.text ?? null).toBeNull();
    release({ text: "慢速摘要：用户仍在准备面试。" });
    await finished;
    expect(order).toEqual(["stream-complete", "summary-start"]);
    expect(validateConversationSummaryCoverage(repo.state.summary, messages).status).toBe("FRESH");
  }, 10_000);

  it("keeps the foreground success path independent when summary generation fails", async () => {
    const messages = dialogue(8);
    const repo = memoryRepository({ messages });
    let now = 1_700_000_000_000;
    const executeText = mockExecute(async () => {
      throw new Error("provider down");
    });
    const rejections: unknown[] = [];
    const onRejection = (error: unknown) => rejections.push(error);
    process.on("unhandledRejection", onRejection);
    try {
      const ack = scheduleCareerDialogueSummary(
        {
          userId: USER,
          conversationId: CONVERSATION,
          resolvedConnectionId: "conn-locked",
          resolvedModel: "model-locked",
          messages,
        },
        depsFor(repo, executeText, { now: () => now }),
      );
      expect(ack.opened).toBe(true);
      await conversationSummaryInFlight(CONVERSATION);
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
    expect(repo.state.summary?.text ?? null).toBeNull();
    expect(repo.state.summary?.failureCount).toBe(1);
    expect(repo.state.summary?.lastFailureAt).toBeInstanceOf(Date);
    const again = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText, { now: () => now + 1_000 }),
    );
    expect(again).toMatchObject({ status: "skipped", reason: "backoff" });
    expect(executeText).toHaveBeenCalledTimes(1);
    now += SUMMARY_BACKOFF_INITIAL_MS;
    executeText.mockImplementationOnce(async () => ({ text: "恢复后的摘要。" }));
    const recovered = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText, { now: () => now }),
    );
    expect(recovered.status).toBe("committed");
    expect(repo.state.summary?.failureCount).toBe(0);
    expect(repo.state.summary?.lastFailureAt).toBeNull();
  });

  it("rejects an oversized summary without truncating or storing it", async () => {
    const messages = dialogue(8);
    const repo = memoryRepository({ messages });
    const huge = "中".repeat(CAREER_DIALOGUE_CONTEXT_BUDGETS.summaryTokens + 1);
    const executeText = mockExecute(async () => ({ text: huge }));
    const result = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText),
    );
    expect(result).toMatchObject({ status: "failed", reason: "too_large" });
    expect(repo.state.summary?.text ?? null).toBeNull();
    expect(repo.state.summary?.failureCount).toBe(1);
    expect(estimateContextTokens(huge)).toBeGreaterThan(CAREER_DIALOGUE_CONTEXT_BUDGETS.summaryTokens);
  });

  it("drops a summary when a covered message is regenerated and replaces it later", async () => {
    const messages = dialogue(8);
    const repo = memoryRepository({ messages });
    const executeText = mockExecute(async () => ({ text: "第一版摘要。" }));
    await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText),
    );
    const fresh = repo.state.summary;
    expect(validateConversationSummaryCoverage(fresh, messages).status).toBe("FRESH");
    const regenerated = messages.map((message) =>
      message.id === "a0" ? { ...message, id: "a0-regenerated" } : message,
    );
    repo.state.messages = regenerated;
    expect(validateConversationSummaryCoverage(fresh, regenerated).status).toBe("STALE");
    const hidden = buildCareerDialogueContext({ profile: "FAST_CHAT", messages: regenerated });
    if (!hidden.ok) throw new Error(hidden.code);
    expect(hidden.transcript).not.toContain("第一版摘要。");
    executeText.mockResolvedValueOnce({ text: "再生后的摘要。" });
    const replaced = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText),
    );
    expect(replaced.status).toBe("committed");
    expect(validateConversationSummaryCoverage(repo.state.summary, regenerated).status).toBe("FRESH");
    expect(repo.state.summary?.text).toBe("再生后的摘要。");
  });

  it("keeps a fresh summary when regeneration is outside its coverage", async () => {
    const messages = dialogue(8);
    const repo = memoryRepository({ messages });
    const executeText = mockExecute(async () => ({ text: "覆盖范围内的摘要。" }));
    await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText),
    );
    const before = repo.state.summary ? { ...repo.state.summary } : null;
    const outside: UIMessage[] = messages.map((message) =>
      message.id === "a7"
        ? ({
            ...message,
            parts: [{ type: "text", text: "regenerated tail" }],
          } as UIMessage)
        : message,
    );
    repo.state.messages = outside;
    expect(validateConversationSummaryCoverage(before, outside).status).toBe("FRESH");
    expect(before?.coverageHash).toBe(hashSummaryCoverage(outside.slice(0, before?.coveredCount ?? 0)));
    const skipped = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText),
    );
    expect(skipped.status).toBe("skipped");
    expect(executeText).toHaveBeenCalledTimes(1);
    const verdict = validateConversationSummaryCoverage(repo.state.summary, outside);
    expect(verdict.status).toBe("FRESH");
    if (verdict.status !== "FRESH") return;
    const injected = buildCareerDialogueContext({
      profile: "FAST_CHAT",
      messages: outside,
      summary: verdict.text,
    });
    if (!injected.ok) throw new Error(injected.code);
    expect(injected.transcript).toContain("覆盖范围内的摘要。");
  });

  it("refreshes before storage eviction and then refuses the evicted boundary", async () => {
    const messages: UIMessage[] = [];
    const addTurn = (index: number, assistants: number, text: string) => {
      messages.push(user(`u${index}`, text));
      for (let i = 0; i < assistants; i++) messages.push(assistant(`a${index}-${i}`, `${text} ${i}`));
    };
    addTurn(0, 1, "early goal one");
    addTurn(1, 1, "early goal two");
    addTurn(2, 10, "recent fat two");
    addTurn(3, 10, "recent fat three");
    addTurn(4, 10, "recent fat four");
    addTurn(5, 11, "current fat");
    const prefix = messages.slice(0, 4);
    const old = emptySummary({
      text: "OLD_BOUNDARY_SUMMARY",
      throughMessageId: "a1-0",
      coverageHash: hashSummaryCoverage(prefix),
      coveredCount: 4,
      promptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
      revision: 2,
      units: estimateContextTokens("OLD_BOUNDARY_SUMMARY"),
      failureCount: 0,
    });
    expect(summaryBoundaryUnderStoragePressure(messages, "a1-0")).toBe(true);
    expect(
      additionalDroppedTurnsBeyondCoverage(
        messages,
        validateConversationSummaryCoverage(old, messages).status === "FRESH"
          ? 3
          : -1,
      ),
    ).toBeLessThan(2);
    const repo = memoryRepository({ messages, summary: old });
    const executeText = mockExecute(async () => ({ text: "扩展后的早期目标摘要。" }));
    const result = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText),
    );
    expect(result.status).toBe("committed");
    expect(executeText).toHaveBeenCalledTimes(1);
    expect(repo.state.summary?.throughMessageId).not.toBe("a1-0");
    expect(messages.some((message) => message.id === repo.state.summary?.throughMessageId)).toBe(true);
    const evicted = messages.slice(4);
    expect(validateConversationSummaryCoverage(old, evicted).status).toBe("STALE");
    const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages: evicted });
    if (!budget.ok) throw new Error(budget.code);
    expect(budget.transcript).not.toContain("OLD_BOUNDARY_SUMMARY");
  });

  it("does not summarize a legacy conversation or fall back from a disconnected lock", async () => {
    const messages = dialogue(8);
    const legacy = memoryRepository({
      messages,
      resolvedConnectionId: null,
      resolvedModel: null,
    });
    const executeText = mockExecute();
    expect(
      scheduleCareerDialogueSummary(
        {
          userId: USER,
          conversationId: CONVERSATION,
          resolvedConnectionId: null,
          resolvedModel: null,
          messages,
        },
        depsFor(legacy, executeText),
      ).opened,
    ).toBe(false);
    expect(
      await condenseCareerDialogueSummary(
        { userId: USER, conversationId: CONVERSATION },
        depsFor(legacy, executeText),
      ),
    ).toMatchObject({ status: "skipped", reason: "legacy" });
    const budget = buildCareerDialogueContext({ profile: "FAST_CHAT", messages });
    if (!budget.ok) throw new Error(budget.code);
    expect(budget.size.dynamicTokens).toBeLessThanOrEqual(CAREER_DIALOGUE_CONTEXT_BUDGETS.dynamicTokens);

    const locked = memoryRepository({ messages });
    const failing = mockExecute(async () => {
      throw new AIBusinessError("CONNECTION_DISCONNECTED", "disconnected");
    });
    const failed = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(locked, failing),
    );
    expect(failed.status).toBe("failed");
    expect(failing).toHaveBeenCalledTimes(1);
    expect(failing.mock.calls[0]?.[0]).toMatchObject({
      connectionId: "conn-locked",
      model: "model-locked",
    });
    expect(locked.state.summary?.text ?? null).toBeNull();
    expect(locked.state.resolvedModel).toBe("model-locked");
  });

  it("regenerates a summary whose prompt version is not current", async () => {
    const messages = dialogue(8);
    const text = "旧版本摘要";
    const target = selectConversationSummaryCoverage(messages);
    if (!target) throw new Error("expected coverage");
    const repo = memoryRepository({
      messages,
      summary: emptySummary({
        text,
        throughMessageId: target.throughMessageId,
        coverageHash: target.coverageHash,
        coveredCount: target.coveredCount,
        promptVersion: "career-dialogue-summary-v0",
        revision: 4,
        units: estimateContextTokens(text),
      }),
    });
    expect(validateConversationSummaryCoverage(repo.state.summary, messages).status).toBe("STALE");
    const executeText = mockExecute(async () => ({ text: "新版本摘要。" }));
    const result = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, executeText),
    );
    expect(result.status).toBe("committed");
    expect(repo.state.summary?.promptVersion).toBe(CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION);
    expect(validateConversationSummaryCoverage(repo.state.summary, messages).status).toBe("FRESH");
  });

  it("does not let an older snapshot overwrite a newer summary", async () => {
    const short = dialogue(8);
    const extra = dialogue(10);
    const olderTarget = selectConversationSummaryCoverage(short);
    const newerTarget = selectConversationSummaryCoverage(extra);
    if (!olderTarget || !newerTarget) throw new Error("expected both targets");
    expect(newerTarget.throughIndex).toBeGreaterThan(olderTarget.throughIndex);
    const newer = emptySummary({
      text: "newer summary",
      throughMessageId: newerTarget.throughMessageId,
      coverageHash: newerTarget.coverageHash,
      coveredCount: newerTarget.coveredCount,
      promptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
      revision: 1,
      units: estimateContextTokens("newer summary"),
    });
    const olderAttempt: SummaryAttempt = {
      conversationId: CONVERSATION,
      userId: USER,
      observedRevision: null,
      text: "older summary",
      throughMessageId: olderTarget.throughMessageId,
      coverageHash: hashSummaryCoverage(extra.slice(0, olderTarget.coveredCount)),
      coveredCount: olderTarget.coveredCount,
      promptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
      units: estimateContextTokens("older summary"),
      generationMs: 5,
      generatedAt: new Date(0),
    };
    const written: { summary: ConversationSummaryRecord | null } = { summary: null };
    const created = await persistSummaryAttempt({
      reload: async () => ({ messages: extra, summary: written.summary }),
      create: async (record) => {
        written.summary = record;
        return "created";
      },
      update: async () => {
        throw new Error("newer row should not be updated by the losing create");
      },
      attempt: {
        ...olderAttempt,
        text: "newer summary",
        throughMessageId: newer.throughMessageId!,
        coverageHash: newer.coverageHash!,
        coveredCount: newer.coveredCount!,
        units: newer.units!,
      },
    });
    expect(created).toBe("committed");
    const discarded = await persistSummaryAttempt({
      reload: async () => ({ messages: extra, summary: written.summary }),
      create: async () => {
        throw new Error("create should not run once a newer row exists");
      },
      update: async () => {
        throw new Error("older coverage must be discarded before write");
      },
      attempt: olderAttempt,
    });
    expect(discarded).toBe("discarded");
    expect(written.summary?.text).toBe("newer summary");

    let calls = 0;
    const raced = await persistSummaryAttempt({
      reload: async () => {
        calls += 1;
        if (calls === 1) return { messages: extra, summary: null };
        return { messages: extra, summary: written.summary };
      },
      create: async () => "conflict",
      update: async () => {
        throw new Error("conflict with a newer row must not update");
      },
      attempt: olderAttempt,
    });
    expect(raced).toBe("discarded");

    const current = emptySummary({
      text: "kept",
      throughMessageId: olderTarget.throughMessageId,
      coverageHash: olderTarget.coverageHash,
      coveredCount: olderTarget.coveredCount,
      promptVersion: CAREER_DIALOGUE_SUMMARY_PROMPT_VERSION,
      revision: 4,
      units: estimateContextTokens("kept"),
    });
    const attemptedRevisions: number[] = [];
    const revisionMiss = await persistSummaryAttempt({
      reload: async () => ({ messages: short, summary: current }),
      create: async () => "conflict",
      update: async (expected) => {
        attemptedRevisions.push(expected);
        return 0;
      },
      attempt: {
        ...olderAttempt,
        observedRevision: 3,
        text: "stale writer",
        throughMessageId: olderTarget.throughMessageId,
        coverageHash: olderTarget.coverageHash,
        coveredCount: olderTarget.coveredCount,
      },
    });
    expect(attemptedRevisions).toEqual([3]);
    expect(revisionMiss).toBe("discarded");
  });

  it("deduplicates in-flight condensation and omits summary text from logs", async () => {
    const messages = dialogue(8);
    const repo = memoryRepository({ messages });
    let release: (value: { text: string }) => void = () => {};
    const executeText = mockExecute(
      () => new Promise<{ text: string }>((resolve) => {
        release = resolve;
      }),
    );
    const input = {
      userId: USER,
      conversationId: CONVERSATION,
      resolvedConnectionId: "conn-locked",
      resolvedModel: "model-locked",
      messages,
    };
    expect(scheduleCareerDialogueSummary(input, depsFor(repo, executeText)).opened).toBe(true);
    expect(scheduleCareerDialogueSummary(input, depsFor(repo, executeText)).opened).toBe(false);
    await vi.waitFor(() => expect(executeText).toHaveBeenCalledTimes(1));
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    release({ text: "UNIQUE_SUMMARY_SENTENCE_XYZ" });
    await conversationSummaryInFlight(CONVERSATION);
    expect(executeText).toHaveBeenCalledTimes(1);
    const blob = JSON.stringify(info.mock.calls);
    expect(blob).not.toContain("UNIQUE_SUMMARY_SENTENCE_XYZ");
    expect(blob).toContain("summaryStatus");
    info.mockRestore();
  });

  it("records bounded context metrics for a synthetic long dialogue", async () => {
    const messages = dialogue(16);
    const repo = memoryRepository({ messages });
    const text = "用户在准备后端面试，希望回答保持简短，并继续按目标序号推进。";
    const started = performance.now();
    const result = await condenseCareerDialogueSummary(
      { userId: USER, conversationId: CONVERSATION },
      depsFor(repo, async () => ({ text })),
    );
    const generationMs = performance.now() - started;
    const verdict = validateConversationSummaryCoverage(repo.state.summary, messages);
    expect(verdict.status).toBe("FRESH");
    if (verdict.status !== "FRESH") return;
    const next = buildCareerDialogueContext({ profile: "FAST_CHAT", messages, summary: verdict.text });
    if (!next.ok) throw new Error(next.code);
    const metrics = {
      generationMs: result.generationMs,
      measuredMs: Math.round(generationMs),
      syncSchedulingNote: "schedule returns before executeText",
      summaryUnits: next.size.summaryTokens,
      recentTurnCount: next.size.recentTurnCount,
      droppedTurnCount: next.size.droppedTurnCount,
      dynamicTokens: next.size.dynamicTokens,
      historyTokens: next.size.historyTokens,
    };
    expect(metrics.summaryUnits).toBeLessThanOrEqual(1_000);
    expect(metrics.summaryUnits).toBeGreaterThan(0);
    expect(metrics.recentTurnCount).toBeLessThanOrEqual(6);
    expect(metrics.droppedTurnCount).toBeGreaterThan(0);
    expect(metrics.dynamicTokens).toBeLessThanOrEqual(6_000);
    console.info("P3B_METRICS", JSON.stringify(metrics));
  });
});

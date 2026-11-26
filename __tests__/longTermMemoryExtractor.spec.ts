// @vitest-environment node
vi.mock("@/lib/db", () => ({ default: {} }));
import {
  resetLongTermMemoryExtractionForTests,
  scheduleLongTermMemoryExtraction,
  WEAK_SIGNAL_TURN_THRESHOLD,
  type MemoryExtractionConversation,
  type MemoryExtractionDeps,
} from "@/lib/agent/longTermMemoryExtractor.server";
import { encodeManagedAiProvenance } from "@/lib/ai/managed-provenance";
import type { MemoryCurationAction } from "@/lib/agent/longTermMemory";

function conversation(messages: unknown[]): MemoryExtractionConversation {
  return {
    archived: false,
    resolvedConnectionId: "conn-1",
    resolvedModel: "gpt-test",
    managedAiProvenance: null,
    connectionClass: "ACCOUNT_LOGIN",
    messages,
  };
}

function turn(user: string, assistant = "好的"): unknown[] {
  return [
    { role: "user", parts: [{ type: "text", text: user }] },
    { role: "assistant", parts: [{ type: "text", text: assistant }] },
  ];
}

function rejection(reason?: string): unknown {
  return {
    role: "assistant",
    parts: [
      {
        type: "tool-add_job",
        approval: { id: "ap-1", approved: false, ...(reason ? { reason } : {}) },
      },
    ],
  };
}

function makeDeps() {
  const executeText = vi.fn(async () => ({ text: "[]" }));
  const applied: Array<{
    action: MemoryCurationAction;
    sourceConversationId?: string | null;
  }> = [];
  const fixture = {
    conversation: conversation(turn("你好")),
    entries: [] as Array<{ category: string; key: string; content: string; source: string }>,
    enabled: true,
  };
  const deps: MemoryExtractionDeps = {
    now: () => Date.now(),
    executeText,
    weakTurnThreshold: WEAK_SIGNAL_TURN_THRESHOLD,
    weakDebounceMs: 20,
    store: {
      loadConversation: async () => fixture.conversation,
      listEntries: async () => fixture.entries,
      applyAction: async (input) => {
        applied.push(input);
        return { applied: true };
      },
      memoryEnabled: async () => fixture.enabled,
    },
  };
  return { deps, executeText, applied, fixture };
}

async function settle() {
  // schedule* is fire-and-forget; flush the microtask chain to its end.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

async function idle(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await settle();
}

beforeEach(() => {
  resetLongTermMemoryExtractionForTests();
});

describe("long-term memory extraction", () => {
  it("skips small talk entirely — the model is never called", async () => {
    const { deps, executeText } = makeDeps();
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c1" }, deps);
    await settle();
    expect(executeText).not.toHaveBeenCalled();
  });

  it("extracts on a strong correction signal and applies sanitized actions", async () => {
    const { deps, executeText, applied, fixture } = makeDeps();
    fixture.conversation = conversation(turn("我不考虑外包和 996 的岗位"));
    executeText.mockResolvedValueOnce({
      text: JSON.stringify([
        { action: "upsert", category: "career_goal", key: "target_cities", content: "上海，远程优先" },
        { action: "remove", category: "industry_preference", key: "outdated_slot" },
        // Untrusted output: these two must be dropped by deterministic validation.
        { action: "upsert", category: "career_goal", key: "secret", content: "sk-abc12345678" },
        { action: "delete", category: "career_goal", key: "x" },
        // Legacy no-action shape still reads as upsert.
        { category: "collaboration_habit", key: "reply_style", content: "简洁" },
      ]),
    });
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c2" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
    expect(applied.map((a) => [a.action.action, a.action.key])).toEqual([
      ["upsert", "target_cities"],
      ["remove", "outdated_slot"],
      ["upsert", "reply_style"],
    ]);
    expect(applied[0].sourceConversationId).toBe("c2");
  });

  it("shows existing memory and rejection reasons to the curator", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.entries = [
      { category: "career_goal", key: "target_cities", content: "上海", source: "USER_MANUAL" },
      { category: "industry_preference", key: "avoid", content: "外包", source: "AI_EXTRACTED" },
    ];
    fixture.conversation = conversation([...turn("我不考虑外包"), rejection("太远了")]);
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c2b" }, deps);
    await settle();
    const call = (executeText.mock.calls[0] as unknown[])[0] as { prompt: string };
    expect(call.prompt).toContain("target_cities: 上海  (locked)");
    expect(call.prompt).toContain("avoid: 外包");
    expect(call.prompt).toContain("rejected add_job: 太远了");
  });

  it("weak signals do not fire immediately — they accumulate across turns", async () => {
    const { deps, executeText, fixture } = makeDeps();
    const messages: unknown[] = [];
    fixture.conversation = conversation(messages);

    for (let i = 0; i < WEAK_SIGNAL_TURN_THRESHOLD - 1; i += 1) {
      messages.push(...turn("我想看看行业趋势"));
      scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c3" }, deps);
      await settle();
      expect(executeText).not.toHaveBeenCalled();
    }
    messages.push(...turn("再聊聊岗位方向"));
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c3" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
  });

  it("pending weak signals fire on the idle debounce", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = conversation(turn("我想看看行业趋势"));
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c3b" }, deps);
    await settle();
    expect(executeText).not.toHaveBeenCalled();
    await idle(60);
    expect(executeText).toHaveBeenCalledTimes(1);
  });

  it("a reasoned proposal rejection triggers extraction in the same turn", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = conversation([rejection("太远了，只看上海")]);
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c3c" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
  });

  it("a strong turn clears pending weak accumulation instead of waiting", async () => {
    const { deps, executeText, fixture } = makeDeps();
    const messages: unknown[] = [...turn("我想看看行业趋势")];
    fixture.conversation = conversation(messages);
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c3d" }, deps);
    await settle();
    expect(executeText).not.toHaveBeenCalled();
    // One strong turn must not have to reach the weak threshold.
    messages.push(...turn("说错了，我不考虑创业公司"));
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c3d" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
  });

  it("extracts on the conversation's own connection — account attribution is locked", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = {
      ...conversation(turn("我不考虑外包")),
      connectionClass: "ACCOUNT_LOGIN",
    };
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c4a" }, deps);
    await settle();
    const call = (executeText.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(call.connectionId).toBe("conn-1");
    expect(call.model).toBe("gpt-test");
    // No managed provenance for an account session — it can never silently
    // spend another connection's or the managed pool's quota.
    expect(call.managedAiProvenance).toBeUndefined();
    expect(call.managedResource).toBeUndefined();
  });

  it("single-flights concurrent schedules for one conversation", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = conversation(turn("我不考虑外包"));
    executeText.mockResolvedValue({ text: "[]" });
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c4" }, deps);
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c4" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
  });

  it("opens the circuit after consecutive failures", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = conversation(turn("我不考虑外包"));
    let now = 0;
    deps.now = () => now;
    executeText.mockRejectedValue(new Error("boom"));
    for (let i = 0; i < 3; i += 1) {
      scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c5" }, deps);
      await settle();
      // Each failure doubles the backoff — jump well past it per attempt.
      now += 10 * 60_000;
    }
    expect(executeText).toHaveBeenCalledTimes(3);
    // Circuit open: further schedules skip without touching the model.
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c5" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(3);
  });

  it("backs off after a failure instead of hammering the provider", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = conversation(turn("我不考虑外包"));
    let now = 0;
    deps.now = () => now;
    executeText.mockRejectedValue(new Error("boom"));
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c6" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
    // 30s later — inside the initial 60s backoff — still no call.
    now += 30_000;
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c6" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
    // After the backoff elapses the retry runs.
    now += 31_000;
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c6" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the master switch is off — no extraction at all", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.enabled = false;
    fixture.conversation = conversation(turn("我不考虑外包"));
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c7" }, deps);
    await settle();
    expect(executeText).not.toHaveBeenCalled();
  });

  it("skips archived and legacy (unlocked) conversations", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = { ...conversation(turn("我不考虑外包")), archived: true };
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c8" }, deps);
    await settle();
    fixture.conversation = { ...conversation(turn("我不考虑外包")), resolvedConnectionId: null };
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c9" }, deps);
    await settle();
    expect(executeText).not.toHaveBeenCalled();
  });

  it("forwards managed provenance for managed conversations", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = {
      ...conversation(turn("我不考虑外包")),
      connectionClass: "MANAGED",
      managedAiProvenance: encodeManagedAiProvenance({
        schemaVersion: 1,
        managedBindingId: "bnd_1",
        requestedModelKey: "gpt-test",
        upstreamModelId: "upstream-1",
        mappingRevision: "7",
        adapterContractRevision: "3",
      }),
    };
    executeText.mockResolvedValue({ text: "[]" });
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c10" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
    const call = (executeText.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(call.managedResource).toEqual({ business: "CAREER_DIALOGUE", resourceKey: "conversation:c10" });
    expect(String(call.operationId)).toContain("dialogue:c10:memory:");
    expect(call.attemptIndex).toBe(0);
    // The Router lightweight slot is not configured yet — the contract
    // fallback is the conversation's own resolved model.
    expect(call.model).toBe("gpt-test");
  });
});

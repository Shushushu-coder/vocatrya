// @vitest-environment node
vi.mock("@/lib/db", () => ({ default: {} }));
import {
  resetLongTermMemoryExtractionForTests,
  scheduleLongTermMemoryExtraction,
  type MemoryExtractionConversation,
  type MemoryExtractionDeps,
} from "@/lib/agent/longTermMemoryExtractor.server";
import { encodeManagedAiProvenance } from "@/lib/ai/managed-provenance";

function conversation(messages: unknown[]): MemoryExtractionConversation {
  return {
    archived: false,
    resolvedConnectionId: "conn-1",
    resolvedModel: "gpt-test",
    managedAiProvenance: null,
    messages,
  };
}

function turn(user: string, assistant = "好的"): unknown[] {
  return [
    { role: "user", parts: [{ type: "text", text: user }] },
    { role: "assistant", parts: [{ type: "text", text: assistant }] },
  ];
}

function makeDeps() {
  const executeText = vi.fn(async () => ({ text: "[]" }));
  const upserts: Array<{
    category: string;
    key: string;
    content: string;
    sourceConversationId?: string | null;
  }> = [];
  const fixture = {
    conversation: conversation(turn("你好")),
    enabled: true,
  };
  const deps: MemoryExtractionDeps = {
    now: () => Date.now(),
    executeText,
    store: {
      loadConversation: async () => fixture.conversation,
      upsert: async (input) => {
        upserts.push(input);
        return input;
      },
      memoryEnabled: async () => fixture.enabled,
    },
  };
  return { deps, executeText, upserts, fixture };
}

async function settle() {
  // schedule* is fire-and-forget; flush the microtask chain to its end.
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
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

  it("extracts on preference signals and writes sanitized entries", async () => {
    const { deps, executeText, upserts, fixture } = makeDeps();
    fixture.conversation = conversation(turn("我希望找上海的远程工作，月薪不低于 30k"));
    executeText.mockResolvedValueOnce({
      text: JSON.stringify([
        { category: "career_goal", key: "target_cities", content: "上海，远程优先" },
        { category: "career_goal", key: "salary_floor", content: "月薪不低于 30k" },
        // Untrusted output: these two must be dropped by deterministic validation.
        { category: "career_goal", key: "secret", content: "sk-abc12345678" },
        { category: "nonsense", key: "x", content: "y" },
      ]),
    });
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c2" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
    expect(upserts.map((u) => u.key)).toEqual(["target_cities", "salary_floor"]);
    expect(upserts[0].sourceConversationId).toBe("c2");
  });

  it("single-flights concurrent schedules for one conversation", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = conversation(turn("我希望找远程工作"));
    executeText.mockResolvedValue({ text: "[]" });
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c3" }, deps);
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c3" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
  });

  it("opens the circuit after consecutive failures", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = conversation(turn("我希望找远程工作"));
    let now = 0;
    deps.now = () => now;
    executeText.mockRejectedValue(new Error("boom"));
    for (let i = 0; i < 3; i += 1) {
      scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c4" }, deps);
      await settle();
      // Each failure doubles the backoff — jump well past it per attempt.
      now += 10 * 60_000;
    }
    expect(executeText).toHaveBeenCalledTimes(3);
    // Circuit open: further schedules skip without touching the model.
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c4" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(3);
  });

  it("backs off after a failure instead of hammering the provider", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = conversation(turn("我希望找远程工作"));
    let now = 0;
    deps.now = () => now;
    executeText.mockRejectedValue(new Error("boom"));
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c5" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
    // 30s later — inside the initial 60s backoff — still no call.
    now += 30_000;
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c5" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
    // After the backoff elapses the retry runs.
    now += 31_000;
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c5" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(2);
  });

  it("does nothing when the master switch is off — no extraction at all", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.enabled = false;
    fixture.conversation = conversation(turn("我希望找远程工作"));
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c6" }, deps);
    await settle();
    expect(executeText).not.toHaveBeenCalled();
  });

  it("skips archived and legacy (unlocked) conversations", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = { ...conversation(turn("我希望找远程工作")), archived: true };
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c7" }, deps);
    await settle();
    fixture.conversation = { ...conversation(turn("我希望找远程工作")), resolvedConnectionId: null };
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c8" }, deps);
    await settle();
    expect(executeText).not.toHaveBeenCalled();
  });

  it("forwards managed provenance for managed conversations", async () => {
    const { deps, executeText, fixture } = makeDeps();
    fixture.conversation = {
      ...conversation(turn("我希望找远程工作")),
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
    scheduleLongTermMemoryExtraction({ userId: "u1", conversationId: "c9" }, deps);
    await settle();
    expect(executeText).toHaveBeenCalledTimes(1);
    const call = (executeText.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(call.managedResource).toEqual({ business: "CAREER_DIALOGUE", resourceKey: "conversation:c9" });
    expect(String(call.operationId)).toContain("dialogue:c9:memory:");
    expect(call.attemptIndex).toBe(0);
  });
});

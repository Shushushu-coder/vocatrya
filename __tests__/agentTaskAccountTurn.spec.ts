// @vitest-environment node
/**
 * Account-runtime turn wiring for task sessions: agentTaskId + handoffLine
 * reach the context builder on every profile (fast chat, decision, answer),
 * the task tool extension reaches the registry, and a turn without a task
 * binding is untouched. Fake model only.
 */
import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeAIConnectionTextStream } from "@/lib/ai/streaming-execution";
import { buildAgentTools } from "@/lib/agent/tools";
import { runCareerDialogueTurn } from "@/lib/agent/careerDialogueTurn";
import { routeCareerDialogueTurn } from "@/lib/agent/careerDialogueRoute";
import type { ToolSet, UIMessage } from "ai";

vi.mock("@/lib/ai/execution", () => ({ executeAIConnectionText: vi.fn() }));
vi.mock("@/lib/ai/streaming-execution", () => ({
  executeAIConnectionTextStream: vi.fn(),
  checkStreamingTurnReadiness: vi.fn(),
  fetchAccountRuntimeState: vi.fn(),
}));
vi.mock("@/lib/agent/tools", () => ({ buildAgentTools: vi.fn() }));

const LINE =
  "Active task state (system-maintained, verified 2026-11-19T00:00:00.000Z):\nTask: 面试冲刺 · milestone=PRACTICING · blocked=no\nNext: Answer mock question 1";

const userMsg = (text: string): UIMessage =>
  ({ id: `u-${text.slice(0, 6)}`, role: "user", parts: [{ type: "text", text }] }) as UIMessage;

function captureWriter() {
  return {
    write: () => {},
    merge: () => {},
    onError: undefined,
  } as never;
}

function streamEvents(events: unknown[]) {
  return (async function* () {
    for (const event of events) yield event as never;
  })();
}

const baseInput = {
  userId: "user-1",
  connectionId: "conn-1",
  provider: "OPENAI",
  backendKind: "CODEX_RUNTIME",
  modelName: "gpt-5.6-sol",
  systemPrompt: "You are the Vocatrya assistant.",
  agentRole: "pilot",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  (executeAIConnectionText as any).mockResolvedValue({
    text: '{"type":"assistant_response","tool":null,"arguments":null}',
  });
  (executeAIConnectionTextStream as any).mockImplementation(() =>
    streamEvents([
      { type: "text-delta", delta: "ok" },
      { type: "completed", text: "ok" },
    ]),
  );
  (buildAgentTools as any).mockReturnValue({} satisfies Partial<ToolSet>);
});

const streamPrompt = () => (executeAIConnectionTextStream as any).mock.calls[0][0].prompt as string;
const decisionPrompt = () => (executeAIConnectionText as any).mock.calls[0][0].prompt as string;

describe("task session turn", () => {
  it("fast chat carries the handoff line", async () => {
    const decision = routeCareerDialogueTurn({ messages: [userMsg("hi")] });
    expect(decision.route).toBe("FAST_CHAT");
    await runCareerDialogueTurn({
      ...baseInput,
      messages: [userMsg("hi")],
      writer: captureWriter(),
      signal: new AbortController().signal,
      decision,
      agentTaskId: "task-1",
      handoffLine: LINE,
    });
    expect(streamPrompt()).toContain("Active task state (system-maintained");
    expect(streamPrompt()).toContain("Next: Answer mock question 1");
  });

  it("agent turn: decision AND final-answer prompts carry the line; the registry gets the extension", async () => {
    const decision = routeCareerDialogueTurn({ messages: [userMsg("save this job")] });
    expect(decision.route).toBe("AGENT");
    await runCareerDialogueTurn({
      ...baseInput,
      messages: [userMsg("save this job")],
      writer: captureWriter(),
      signal: new AbortController().signal,
      decision,
      agentTaskId: "task-1",
      handoffLine: LINE,
      taskExtraTools: ["match_job", "get_resume"],
    });
    expect(decisionPrompt()).toContain("Active task state (system-maintained");
    expect(streamPrompt()).toContain("Active task state (system-maintained");
    expect((buildAgentTools as any).mock.calls[0][0]).toMatchObject({
      agentRole: "pilot",
      taskExtraTools: ["match_job", "get_resume"],
    });
  });
});

describe("ordinary turn (no task binding)", () => {
  it("never shows a handoff line, even if one is passed without a task id", async () => {
    const decision = routeCareerDialogueTurn({ messages: [userMsg("save this job")] });
    await runCareerDialogueTurn({
      ...baseInput,
      messages: [userMsg("save this job")],
      writer: captureWriter(),
      signal: new AbortController().signal,
      decision,
      handoffLine: LINE,
    });
    expect(decisionPrompt()).not.toContain("Active task state");
    expect(streamPrompt()).not.toContain("Active task state");
    expect((buildAgentTools as any).mock.calls[0][0].taskExtraTools).toBeUndefined();
  });

  it("is byte-identical with and without the (absent) task fields", async () => {
    const run = async (extra: Record<string, unknown>) => {
      (executeAIConnectionText as any).mockClear();
      (executeAIConnectionTextStream as any).mockClear();
      const decision = routeCareerDialogueTurn({ messages: [userMsg("save this job")] });
      await runCareerDialogueTurn({
        ...baseInput,
        messages: [userMsg("save this job")],
        writer: captureWriter(),
        signal: new AbortController().signal,
        decision,
        ...extra,
      });
      return [decisionPrompt(), streamPrompt()];
    };
    const plain = await run({});
    expect(await run({ agentTaskId: null, handoffLine: undefined, taskExtraTools: null })).toEqual(plain);
    expect(await run({ agentTaskId: undefined })).toEqual(plain);
  });
});

// Provider-neutral agent orchestration — the Career Dialogue ACCOUNT_LOGIN
// turn. The runtime is mocked at the Vocatrya seam boundary
// (executeAIConnectionText / executeAIConnectionTextStream): these tests
// pin the PROTOCOL — decision steps, allowlist, argument validation,
// approval gating, terminal tools, streaming emission, abort — not any
// vendor runtime.
import { runAccountAgentTurn } from "@/lib/agent/accountTurn";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeAIConnectionTextStream } from "@/lib/ai/streaming-execution";
import { buildAgentTools } from "@/lib/agent/tools";
import { AIBusinessError } from "@/lib/ai/connections";
import type { ToolSet, UIMessage } from "ai";
import { z } from "zod";
import { tool } from "ai";

vi.mock("@/lib/ai/execution", () => ({
  executeAIConnectionText: vi.fn(),
}));
vi.mock("@/lib/ai/streaming-execution", () => ({
  executeAIConnectionTextStream: vi.fn(),
  checkStreamingTurnReadiness: vi.fn(),
}));
vi.mock("@/lib/agent/tools", () => ({
  buildAgentTools: vi.fn(),
}));

const userMsg = (text: string): UIMessage =>
  ({
    id: `u-${text.slice(0, 6)}`,
    role: "user",
    parts: [{ type: "text", text }],
  }) as UIMessage;

// Collects every chunk the turn writes — the UI message stream contract.
function captureWriter() {
  const chunks: { type: string; [k: string]: unknown }[] = [];
  return {
    chunks,
    writer: {
      write: (part: { type: string }) => {
        chunks.push(part as { type: string });
      },
      merge: () => {},
      onError: undefined,
    } as never,
  };
}

function fakeTool({
  name,
  inputSchema,
  output,
  needsApproval,
  execute,
}: {
  name: string;
  inputSchema?: unknown;
  output?: unknown;
  needsApproval?: boolean;
  execute?: (input: unknown) => Promise<unknown> | unknown;
}) {
  return tool({
    description: `fake ${name}`,
    inputSchema: (inputSchema ?? z.object({})) as never,
    needsApproval: needsApproval ? () => true : undefined,
    execute: async (input: unknown) =>
      execute ? await execute(input) : (output ?? { status: "ok" }),
  });
}

function streamEvents(events: unknown[]) {
  return (async function* () {
    for (const event of events) yield event as never;
  })();
}

const baseInput = {
  userId: "user-1",
  connectionId: "conn-1",
  provider: "DEVIN",
  backendKind: "DEVIN_RUNTIME",
  modelName: "swe-2",
  systemPrompt: "system",
  pageContext: undefined,
} as const;

describe("runAccountAgentTurn", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"assistant_response"}',
    });
    (executeAIConnectionTextStream as any).mockReturnValue(
      streamEvents([
        { type: "text-delta", delta: "Hello " },
        { type: "text-delta", delta: "there" },
        { type: "completed", text: "Hello there" },
      ]),
    );
    (buildAgentTools as any).mockReturnValue({
      get_resume: fakeTool({ name: "get_resume", output: { status: "ok" } }),
    } satisfies Partial<ToolSet>);
  });

  it("assistant_response decision → real streamed deltas to the UI stream", async () => {
    const { writer, chunks } = captureWriter();
    const result = await runAccountAgentTurn({
      ...baseInput,
      messages: [userMsg("hi")],
      writer,
      signal: new AbortController().signal,
    });
    expect(result.paused).toBe(false);
    const types = chunks.map((c) => c.type);
    expect(types[0]).toBe("start");
    expect(chunks.filter((c) => c.type === "text-delta")).toEqual([
      expect.objectContaining({ delta: "Hello " }),
      expect.objectContaining({ delta: "there" }),
    ]);
    expect(types.at(-1)).toBe("finish");
    // The decision ran through the verified structured contract on the
    // locked pair — never a different connection or model.
    const execCall = (executeAIConnectionText as any).mock.calls[0][0];
    expect(execCall).toMatchObject({
      userId: "user-1",
      connectionId: "conn-1",
      model: "swe-2",
    });
    expect(execCall.structuredOutput.schemaName).toBe(
      "vocatrya_agent_decision",
    );
  });

  it("tool_call decision → validated args → executes → result → next decision", async () => {
    const executed: unknown[] = [];
    (buildAgentTools as any).mockReturnValue({
      get_resume: fakeTool({
        name: "get_resume",
        inputSchema: z.object({ resumeTitle: z.string().optional() }),
        execute: (input) => {
          executed.push(input);
          return { status: "ok", resumeText: "r" };
        },
      }),
    });
    (executeAIConnectionText as any)
      .mockResolvedValueOnce({
        text: '{"type":"tool_call","tool":"get_resume","arguments":{"resumeTitle":"Main"}}',
      })
      .mockResolvedValueOnce({ text: '{"type":"assistant_response"}' });
    const { writer, chunks } = captureWriter();
    const result = await runAccountAgentTurn({
      ...baseInput,
      messages: [userMsg("what does my resume say?")],
      writer,
      signal: new AbortController().signal,
    });
    expect(result.paused).toBe(false);
    expect(executed).toEqual([{ resumeTitle: "Main" }]);
    const types = chunks.map((c) => c.type);
    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-output-available");
    expect(types.at(-1)).toBe("finish");
    // Two decision calls + one final stream on the same lock.
    expect(executeAIConnectionText).toHaveBeenCalledTimes(2);
    expect(executeAIConnectionTextStream).toHaveBeenCalledTimes(1);
  });

  it("rejects a tool that is not in the registry", async () => {
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"tool_call","tool":"drop_table","arguments":{}}',
    });
    const { writer } = captureWriter();
    await expect(
      runAccountAgentTurn({
        ...baseInput,
        messages: [userMsg("x")],
        writer,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "AGENT_TOOL_NOT_ALLOWED" });
  });

  it("rejects malformed decision output after the bounded retries", async () => {
    (executeAIConnectionText as any).mockResolvedValue({ text: "not json" });
    const { writer } = captureWriter();
    await expect(
      runAccountAgentTurn({
        ...baseInput,
        messages: [userMsg("x")],
        writer,
        signal: new AbortController().signal,
      }),
    ).rejects.toBeInstanceOf(AIBusinessError);
    // parse → validate → ≤1 retry inside runStructuredValidation + one
    // semantic correction attempt — bounded, never an open loop.
    const calls = (executeAIConnectionText as any).mock.calls.length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(calls).toBeLessThanOrEqual(6);
  });

  it("rejects arguments that fail the tool schema", async () => {
    (buildAgentTools as any).mockReturnValue({
      get_resume: fakeTool({
        name: "get_resume",
        inputSchema: z.object({ resumeTitle: z.string() }),
      }),
    });
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"tool_call","tool":"get_resume","arguments":{"resumeTitle":42}}',
    });
    const { writer } = captureWriter();
    await expect(
      runAccountAgentTurn({
        ...baseInput,
        messages: [userMsg("x")],
        writer,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "AGENT_TOOL_ARGUMENT_INVALID" });
  });

  it("approval-gated tool pauses the turn with tool-approval-request", async () => {
    (buildAgentTools as any).mockReturnValue({
      add_job: fakeTool({
        name: "add_job",
        needsApproval: true,
        inputSchema: z.object({ company: z.string() }),
      }),
    });
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"tool_call","tool":"add_job","arguments":{"company":"Acme"}}',
    });
    const { writer, chunks } = captureWriter();
    const result = await runAccountAgentTurn({
      ...baseInput,
      messages: [userMsg("add this job")],
      writer,
      signal: new AbortController().signal,
    });
    expect(result.paused).toBe(true);
    const types = chunks.map((c) => c.type);
    expect(types).toContain("tool-input-available");
    expect(types).toContain("tool-approval-request");
    // Nothing executed, no output part — the write waits for the user.
    expect(types).not.toContain("tool-output-available");
    expect(chunks.find((c) => c.type === "tool-approval-request")).toMatchObject(
      { approvalId: expect.any(String) },
    );
  });

  it("approved resume executes the tool and continues the loop", async () => {
    const executed: unknown[] = [];
    (buildAgentTools as any).mockReturnValue({
      add_job: fakeTool({
        name: "add_job",
        needsApproval: true,
        inputSchema: z.object({ company: z.string() }),
        execute: (input) => {
          executed.push(input);
          return { created: true, jobId: "j1" };
        },
      }),
    });
    const approvalMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [
        {
          type: "tool-add_job",
          toolCallId: "call-1",
          state: "approval-responded",
          input: { company: "Acme" },
          approval: { id: "ap-1", approved: true },
        },
      ],
    } as unknown as UIMessage;
    const { writer, chunks } = captureWriter();
    await runAccountAgentTurn({
      ...baseInput,
      messages: [userMsg("add this job"), approvalMessage],
      writer,
      signal: new AbortController().signal,
    });
    expect(executed).toEqual([{ company: "Acme" }]);
    // add_job is terminal once settled — the turn ends on the write.
    expect(chunks.at(-1)?.type).toBe("finish");
    const types = chunks.map((c) => c.type);
    expect(types).toContain("tool-output-available");
    // The continuation appends to the SAME assistant message.
    expect(chunks[0]).toMatchObject({ type: "start", messageId: "asst-1" });
  });

  it("denied resume emits tool-output-denied and lets the model react", async () => {
    (buildAgentTools as any).mockReturnValue({
      add_job: fakeTool({
        name: "add_job",
        needsApproval: true,
        inputSchema: z.object({ company: z.string() }),
        execute: () => {
          throw new Error("must not run");
        },
      }),
    });
    const deniedMessage = {
      id: "asst-1",
      role: "assistant",
      parts: [
        {
          type: "tool-add_job",
          toolCallId: "call-1",
          state: "approval-responded",
          input: { company: "Acme" },
          approval: { id: "ap-1", approved: false, reason: "wrong title" },
        },
      ],
    } as unknown as UIMessage;
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"assistant_response"}',
    });
    const { writer, chunks } = captureWriter();
    const result = await runAccountAgentTurn({
      ...baseInput,
      messages: [userMsg("add"), deniedMessage],
      writer,
      signal: new AbortController().signal,
    });
    expect(result.paused).toBe(false);
    expect(chunks.map((c) => c.type)).toContain("tool-output-denied");
  });

  it("a terminal nested tool ends the turn after its result", async () => {
    (buildAgentTools as any).mockReturnValue({
      review_resume: fakeTool({
        name: "review_resume",
        inputSchema: z.object({ resumeTitle: z.string().optional() }),
        output: { status: "ok", body: "review body" },
      }),
    });
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"tool_call","tool":"review_resume","arguments":{}}',
    });
    const { writer, chunks } = captureWriter();
    const result = await runAccountAgentTurn({
      ...baseInput,
      messages: [userMsg("review my resume")],
      writer,
      signal: new AbortController().signal,
    });
    expect(result.paused).toBe(false);
    // No decision after the terminal result — the turn ends.
    expect(executeAIConnectionText).toHaveBeenCalledTimes(1);
    expect(executeAIConnectionTextStream).not.toHaveBeenCalled();
    expect(chunks.at(-1)?.type).toBe("finish");
  });

  it("aborts cleanly when the signal fires mid-stream", async () => {
    const controller = new AbortController();
    (executeAIConnectionTextStream as any).mockReturnValue(
      streamEvents([
        { type: "text-delta", delta: "partial" },
        { type: "error", code: "ABORTED" },
      ]),
    );
    controller.abort();
    const { writer } = captureWriter();
    await expect(
      runAccountAgentTurn({
        ...baseInput,
        messages: [userMsg("hi")],
        writer,
        signal: controller.signal,
      }),
    ).rejects.toBeTruthy();
  });

  it("ends the turn on the step budget instead of looping forever", async () => {
    // A non-terminal tool keeps being requested — the step cap must stop it.
    (buildAgentTools as any).mockReturnValue({
      get_resume: fakeTool({
        name: "get_resume",
        inputSchema: z.object({}),
        output: { status: "ok" },
      }),
    });
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"tool_call","tool":"get_resume","arguments":{}}',
    });
    const { writer } = captureWriter();
    await expect(
      runAccountAgentTurn({
        ...baseInput,
        messages: [userMsg("loop")],
        writer,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "AGENT_STEP_LIMIT_REACHED" });
  });
});

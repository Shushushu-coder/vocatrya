import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeAIConnectionTextStream, fetchAccountRuntimeState } from "@/lib/ai/streaming-execution";
import { buildAgentTools } from "@/lib/agent/tools";
import {
  prepareCareerDialogueTurn,
  runCareerDialogueTurn,
} from "@/lib/agent/careerDialogueTurn";
import { routeCareerDialogueTurn } from "@/lib/agent/careerDialogueRoute";
import type { ToolSet, UIMessage } from "ai";
import { tool } from "ai";
import { z } from "zod";

vi.mock("@/lib/ai/execution", () => ({
  executeAIConnectionText: vi.fn(),
}));
vi.mock("@/lib/ai/streaming-execution", () => ({
  executeAIConnectionTextStream: vi.fn(),
  checkStreamingTurnReadiness: vi.fn(),
  fetchAccountRuntimeState: vi.fn(),
}));
vi.mock("@/lib/agent/tools", () => ({
  buildAgentTools: vi.fn(),
}));

const userMsg = (text: string): UIMessage =>
  ({
    id: `u-${text.slice(0, 8)}`,
    role: "user",
    parts: [{ type: "text", text }],
  }) as UIMessage;

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
  pageContext: undefined,
} as const;

const verifiedState = {
  capabilities: {
    implemented: true,
    structuredOutput: {
      strategy: "NATIVE_JSON_SCHEMA",
      mechanism: "codex exec --output-schema",
      verification: "PASS",
      verifiedRuntimeVersion: "0.160.0",
    },
  },
  runtimeVersion: "0.160.0",
  runtimeReady: true,
};

describe("Career Dialogue fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"assistant_response","tool":null,"arguments":null}',
    });
    (executeAIConnectionTextStream as any).mockReturnValue(
      streamEvents([
        { type: "text-delta", delta: "Hello" },
        { type: "completed", text: "Hello" },
      ]),
    );
    (buildAgentTools as any).mockReturnValue({} satisfies Partial<ToolSet>);
    (fetchAccountRuntimeState as any).mockResolvedValue(verifiedState);
  });

  it("answers a greeting with one stream and no structured call", async () => {
    const prepared = await prepareCareerDialogueTurn({
      messages: [userMsg("hi")],
      connection: { backendKind: "CODEX_RUNTIME", provider: "OPENAI" },
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.decision).toEqual({ route: "FAST_CHAT", reason: "GREETING" });
    expect(fetchAccountRuntimeState).not.toHaveBeenCalled();

    const signal = new AbortController().signal;
    const { writer, chunks } = captureWriter();
    const result = await runCareerDialogueTurn({
      ...baseInput,
      messages: [userMsg("hi")],
      writer,
      signal,
      decision: prepared.decision,
      routerDurationMs: prepared.routerDurationMs,
    });

    expect(result.paused).toBe(false);
    expect(result.steps).toBe(0);
    expect(executeAIConnectionText).not.toHaveBeenCalled();
    expect(executeAIConnectionTextStream).toHaveBeenCalledTimes(1);
    expect(buildAgentTools).not.toHaveBeenCalled();
    expect(executeAIConnectionTextStream).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-1",
        model: "gpt-5.6-sol",
        signal,
      }),
    );
    const prompt = (executeAIConnectionTextStream as any).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("You are the Vocatrya assistant.");
    expect(prompt).toContain("no Vocatrya tools available");
    expect(prompt).not.toContain("Your ONLY output is one JSON object");
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "start",
      "start-step",
      "text-start",
      "text-delta",
      "text-end",
      "finish-step",
      "finish",
    ]);
  });

  it("keeps the agent answer prompt unchanged for an agent turn", async () => {
    const decision = routeCareerDialogueTurn({
      messages: [userMsg("save this job")],
    });
    const { writer } = captureWriter();
    await runCareerDialogueTurn({
      ...baseInput,
      messages: [userMsg("save this job")],
      writer,
      signal: new AbortController().signal,
      decision,
    });
    expect(executeAIConnectionText).toHaveBeenCalledTimes(1);
    expect(executeAIConnectionTextStream).toHaveBeenCalledTimes(1);
    const prompt = (executeAIConnectionTextStream as any).mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain("no Vocatrya tools available");
    expect(executeAIConnectionText).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: "conn-1",
        model: "gpt-5.6-sol",
      }),
    );
  });

  it("does not fall back to fast chat when structured output is unverified", async () => {
    (fetchAccountRuntimeState as any).mockResolvedValue({
      ...verifiedState,
      capabilities: {
        ...verifiedState.capabilities,
        structuredOutput: {
          ...verifiedState.capabilities.structuredOutput,
          verification: "PENDING",
          verifiedRuntimeVersion: null,
        },
      },
    });
    const prepared = await prepareCareerDialogueTurn({
      messages: [userMsg("add this job")],
      connection: { backendKind: "CODEX_RUNTIME", provider: "OPENAI" },
    });
    expect(prepared.ok).toBe(false);
    if (prepared.ok) return;
    expect(prepared.decision.route).toBe("AGENT");
    expect(prepared.error).toMatchObject({ code: "STRUCTURED_OUTPUT_NOT_VERIFIED" });
    expect(executeAIConnectionText).not.toHaveBeenCalled();
    expect(executeAIConnectionTextStream).not.toHaveBeenCalled();
  });

  it("blocks an agent turn when the structured-output version drifts", async () => {
    (fetchAccountRuntimeState as any).mockResolvedValue({
      ...verifiedState,
      runtimeVersion: "9.9.9",
    });
    const prepared = await prepareCareerDialogueTurn({
      messages: [userMsg("review my resume")],
      connection: { backendKind: "CODEX_RUNTIME", provider: "OPENAI" },
    });
    expect(prepared.ok).toBe(false);
    expect(executeAIConnectionText).not.toHaveBeenCalled();
  });

  it("allows a fast chat when structured output is unverified", async () => {
    (fetchAccountRuntimeState as any).mockResolvedValue({
      ...verifiedState,
      capabilities: {
        ...verifiedState.capabilities,
        structuredOutput: {
          strategy: "UNSUPPORTED",
          mechanism: null,
          verification: "FAIL",
          verifiedRuntimeVersion: null,
        },
      },
    });
    const prepared = await prepareCareerDialogueTurn({
      messages: [userMsg("你好")],
      connection: { backendKind: "CODEX_RUNTIME", provider: "OPENAI" },
    });
    expect(prepared).toMatchObject({
      ok: true,
      decision: { route: "FAST_CHAT", reason: "GREETING" },
    });
    expect(fetchAccountRuntimeState).not.toHaveBeenCalled();
  });

  it("still approval-gates add_job on the agent path", async () => {
    const executed: unknown[] = [];
    (buildAgentTools as any).mockReturnValue({
      add_job: tool({
        description: "add",
        inputSchema: z.object({ company: z.string() }),
        needsApproval: () => true,
        execute: async (input) => {
          executed.push(input);
          return { created: true };
        },
      }),
    } satisfies Partial<ToolSet>);
    (executeAIConnectionText as any).mockResolvedValue({
      text: '{"type":"tool_call","tool":"add_job","arguments":"{\\\"company\\\":\\\"Acme\\\"}"}',
    });
    const decision = routeCareerDialogueTurn({
      messages: [userMsg("保存这个岗位")],
    });
    expect(decision.route).toBe("AGENT");
    const { writer, chunks } = captureWriter();
    const result = await runCareerDialogueTurn({
      ...baseInput,
      messages: [userMsg("保存这个岗位")],
      writer,
      signal: new AbortController().signal,
      decision,
    });
    expect(result.paused).toBe(true);
    expect(executed).toEqual([]);
    expect(chunks.map((chunk) => chunk.type)).toContain("tool-approval-request");
    expect(executeAIConnectionTextStream).not.toHaveBeenCalled();
    expect(executeAIConnectionText).toHaveBeenCalledTimes(1);
  });

  it("injects the same page context the final answer already uses", async () => {
    const decision = routeCareerDialogueTurn({
      messages: [userMsg("这个岗位里 stakeholder management 是什么意思？")],
      pageContext: { jobId: "job-1" },
    });
    const { writer } = captureWriter();
    await runCareerDialogueTurn({
      ...baseInput,
      pageContext: { jobId: "job-1", route: "/dashboard/myjobs/job-1" },
      messages: [userMsg("这个岗位里 stakeholder management 是什么意思？")],
      writer,
      signal: new AbortController().signal,
      decision,
    });
    const prompt = (executeAIConnectionTextStream as any).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("viewing a specific job's page");
    expect(executeAIConnectionText).not.toHaveBeenCalled();
  });

  it("answers a follow-up from the persisted transcript without another tool call", async () => {
    const messages = [
      userMsg("查看我的简历"),
      {
        id: "asst-1",
        role: "assistant",
        parts: [
          {
            type: "tool-get_resume",
            toolCallId: "call-1",
            state: "output-available",
            input: {},
            output: { status: "ok", title: "Main" },
          },
          { type: "text", text: "你的简历强调了协作。" },
        ],
      } as UIMessage,
      userMsg("为什么"),
    ];
    const decision = routeCareerDialogueTurn({ messages });
    expect(decision.route).toBe("FAST_CHAT");
    const { writer } = captureWriter();
    await runCareerDialogueTurn({
      ...baseInput,
      messages,
      writer,
      signal: new AbortController().signal,
      decision,
    });
    const prompt = (executeAIConnectionTextStream as any).mock.calls[0][0].prompt as string;
    expect(prompt).toContain("Tool get_resume returned");
    expect(prompt).toContain("为什么");
    expect(executeAIConnectionText).not.toHaveBeenCalled();
    expect(buildAgentTools).not.toHaveBeenCalled();
  });

  it("does not start a structured call when the fast stream fails", async () => {
    (executeAIConnectionTextStream as any).mockReturnValue(
      streamEvents([{ type: "error", code: "AI_EXECUTION_TIMEOUT" }]),
    );
    const { writer } = captureWriter();
    await expect(
      runCareerDialogueTurn({
        ...baseInput,
        messages: [userMsg("hi")],
        writer,
        signal: new AbortController().signal,
        decision: { route: "FAST_CHAT", reason: "GREETING" },
      }),
    ).rejects.toMatchObject({ code: "AI_EXECUTION_TIMEOUT" });
    expect(executeAIConnectionText).not.toHaveBeenCalled();
    expect(executeAIConnectionTextStream).toHaveBeenCalledTimes(1);
  });

  it("stops a fast chat before any model call when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { writer } = captureWriter();
    await expect(
      runCareerDialogueTurn({
        ...baseInput,
        messages: [userMsg("hi")],
        writer,
        signal: controller.signal,
        decision: { route: "FAST_CHAT", reason: "GREETING" },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(executeAIConnectionTextStream).not.toHaveBeenCalled();
    expect(executeAIConnectionText).not.toHaveBeenCalled();
  });
});

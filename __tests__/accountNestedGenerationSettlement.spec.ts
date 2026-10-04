import { runAccountAgentTurn } from "@/lib/agent/accountTurn";
import { createAccountRuntimeLanguageModel } from "@/lib/agent/accountLanguageModel";
import { runNestedGeneration } from "@/lib/agent/nestedGeneration";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeAIConnectionTextStream } from "@/lib/ai/streaming-execution";
import { AI_BUSINESS_ERROR_CODES, AIBusinessError } from "@/lib/ai/connections";
import { generateCoverLetterForJob } from "@/actions/coverLetter.actions";
import { saveResumeReviewResult } from "@/actions/profile.actions";
import { resolveJobForAgent } from "@/lib/agent/jobLookup";
import { resolveCanonicalResumeForAgent, resolveResumeForAgent } from "@/lib/agent/resumeLookup";
import { preprocessJob } from "@/lib/ai/tools/preprocessing-job";
import { preprocessResume, preprocessText } from "@/lib/ai/tools/preprocessing";
import { APP_CONSTANTS } from "@/lib/constants";
import type { UIMessage } from "ai";
import { streamText } from "ai";

vi.mock("@/lib/ai/execution", () => ({
  executeAIConnectionText: vi.fn(),
}));
vi.mock("@/lib/ai/streaming-execution", () => ({
  executeAIConnectionTextStream: vi.fn(),
  checkStreamingTurnReadiness: vi.fn(),
}));
vi.mock("@/lib/agent/resumeLookup", () => ({
  resolveCanonicalResumeForAgent: vi.fn(),
  resolveResumeForAgent: vi.fn(),
}));
vi.mock("@/lib/agent/jobLookup", () => ({ resolveJobForAgent: vi.fn() }));
vi.mock("@/lib/ai/tools/preprocessing", () => ({
  preprocessResume: vi.fn(),
  preprocessText: vi.fn(),
}));
vi.mock("@/lib/ai/tools/preprocessing-job", () => ({ preprocessJob: vi.fn() }));
vi.mock("@/actions/profile.actions", () => ({ saveResumeReviewResult: vi.fn() }));
vi.mock("@/actions/coverLetter.actions", () => ({ generateCoverLetterForJob: vi.fn() }));

const streamEvents = executeAIConnectionTextStream as unknown as ReturnType<typeof vi.fn>;
const decisionText = executeAIConnectionText as unknown as ReturnType<typeof vi.fn>;
const findCanonicalResume = resolveCanonicalResumeForAgent as unknown as ReturnType<typeof vi.fn>;
const findResume = resolveResumeForAgent as unknown as ReturnType<typeof vi.fn>;
const findJob = resolveJobForAgent as unknown as ReturnType<typeof vi.fn>;
const preResume = preprocessResume as unknown as ReturnType<typeof vi.fn>;
const preText = preprocessText as unknown as ReturnType<typeof vi.fn>;
const preJob = preprocessJob as unknown as ReturnType<typeof vi.fn>;
const saveReview = saveResumeReviewResult as unknown as ReturnType<typeof vi.fn>;
const saveLetter = generateCoverLetterForJob as unknown as ReturnType<typeof vi.fn>;

const REVIEW =
  "SCORES: overall=78 impact=72 clarity=81 ats=69\n\n## Summary\n\n评审 Résumé 😀";
const LETTER =
  "Dear Hiring Manager,\n\nI am writing to apply for the Senior Backend Engineer role.\n\nSincerely,\nAvery";

function abortError() {
  return Object.assign(new Error("Execution aborted"), { name: "AbortError" });
}

function streamOf(events: unknown[]) {
  return (async function* () {
    for (const event of events) yield event;
  })();
}

function model() {
  return createAccountRuntimeLanguageModel({
    userId: "user-1",
    connectionId: "conn-1",
    modelName: "gpt-test",
    timeoutMs: 5_000,
  });
}

function writer() {
  return { write: vi.fn(), merge: vi.fn(), onError: undefined };
}

function nestedArgs(overrides: Record<string, unknown> = {}) {
  return {
    model: model(),
    system: "SYSTEM",
    prompt: "PROMPT-SECRET",
    temperature: 0.2,
    numCtx: APP_CONSTANTS.AI_OLLAMA_NUM_CTX,
    timeoutMs: 5_000,
    writer: writer() as never,
    toolCallId: "call-1",
    guard: { running: false },
    label: "review_resume",
    provider: "account",
    modelName: "gpt-test",
    ...overrides,
  };
}

async function settle<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("nested generation did not settle")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type StreamChunk = { type: string; [key: string]: unknown };

function captureWriter() {
  const chunks: StreamChunk[] = [];
  const writer = {
    write: (part: StreamChunk) => {
      chunks.push(part);
    },
    merge: () => {},
    onError: undefined as undefined,
  };
  return { chunks, writer };
}

const userMsg = (text: string): UIMessage =>
  ({
    id: "u1",
    role: "user",
    parts: [{ type: "text", text }],
  }) as UIMessage;

describe("account nested-generation settlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    findCanonicalResume.mockResolvedValue({
      status: "ok",
      family: "legacy",
      resume: { id: "r1", title: "Senior Engineer Resume" },
      source: "default",
      ambiguousTitle: false,
    });
    preResume.mockResolvedValue({
      success: true,
      data: { normalizedText: "resume body", metadata: {}, isValid: true },
    });
    preText.mockResolvedValue({
      success: true,
      data: { normalizedText: "resume body", metadata: {}, isValid: true },
    });
    saveReview.mockResolvedValue({ success: true });
    findJob.mockResolvedValue({
      status: "ok",
      job: {
        id: "job-1",
        resumeId: "r9",
        matchData: null,
        descriptionCompleteness: "full",
        JobTitle: { label: "Senior Backend Engineer" },
        Company: { label: "Northwind Cloud" },
      },
    });
    findResume.mockResolvedValue({
      status: "ok",
      resume: { id: "r9", title: "Senior Engineer Resume" },
      source: "page",
      ambiguousTitle: false,
    });
    preJob.mockResolvedValue({
      success: true,
      data: { normalizedText: "job body", metadata: {}, isValid: true },
    });
    saveLetter.mockResolvedValue({
      success: true,
      data: { id: "cl-1", title: "Senior Backend Engineer - Northwind Cloud" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("settles a completed stream that has no provider finishReason", async () => {
    streamEvents.mockReturnValue(
      streamOf([
        { type: "text-delta", delta: "hello " },
        { type: "text-delta", delta: "世界 😀" },
        { type: "completed", text: "hello 世界 😀" },
      ]),
    );
    const sink = writer();
    const result = await settle(
      runNestedGeneration(nestedArgs({ writer: sink })),
    );
    expect(result).toEqual({ status: "ok", text: "hello 世界 😀" });
    expect(sink.write).toHaveBeenCalledTimes(2);
    expect(sink.write.mock.calls.map((call) => call[0].data.delta)).toEqual([
      "hello ",
      "世界 😀",
    ]);
  });

  it("delivers deltas before the terminal event, including a split surrogate", async () => {
    streamEvents.mockImplementation(async function* () {
      yield { type: "text-delta", delta: "审" };
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { type: "text-delta", delta: "\uD83D" };
      await new Promise((resolve) => setTimeout(resolve, 40));
      yield { type: "text-delta", delta: "\uDE00" };
      yield { type: "completed" };
    });
    const sub = streamText({ model: model(), prompt: "review" });
    const seen: number[] = [];
    let text = "";
    for await (const delta of sub.textStream) {
      seen.push(Date.now());
      text += delta;
    }
    const finishReason = await sub.finishReason;
    expect(text).toBe("审😀");
    expect(finishReason).toBe("stop");
    expect(seen[1] - seen[0]).toBeGreaterThanOrEqual(25);
    expect(seen).toHaveLength(3);
  });

  it("treats a completed event with no prior deltas as one successful delivery", async () => {
    streamEvents.mockReturnValue(streamOf([{ type: "completed", text: "一次性" }]));
    const result = await settle(runNestedGeneration(nestedArgs()));
    expect(result).toEqual({ status: "ok", text: "一次性" });
  });

  it("accepts an empty completed event as terminal success", async () => {
    streamEvents.mockReturnValue(streamOf([{ type: "completed", text: "" }]));
    const result = await settle(runNestedGeneration(nestedArgs()));
    expect(result).toEqual({ status: "ok", text: "" });
  });

  it("fails when the iterator ends without a completed event", async () => {
    streamEvents.mockReturnValue(streamOf([{ type: "text-delta", delta: "truncated" }]));
    const result = await settle(runNestedGeneration(nestedArgs()));
    expect(result).toEqual({ status: "failed" });
  });

  it("ignores a duplicate completed event and a late delta", async () => {
    streamEvents.mockReturnValue(
      streamOf([
        { type: "text-delta", delta: "你" },
        { type: "text-delta", delta: "好" },
        { type: "completed", text: "你好" },
        { type: "text-delta", delta: "LATE" },
        { type: "completed", text: "你好LATE" },
      ]),
    );
    const sink = writer();
    const result = await settle(runNestedGeneration(nestedArgs({ writer: sink })));
    expect(result).toEqual({ status: "ok", text: "你好" });
    expect(sink.write.mock.calls.map((call) => call[0].data.delta)).toEqual(["你", "好"]);
  });

  it("fails before the first delta when the provider throws", async () => {
    streamEvents.mockImplementation(async function* () {
      throw new AIBusinessError(
        AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
        "connect failed",
      );
    });
    const sink = writer();
    const result = await settle(runNestedGeneration(nestedArgs({ writer: sink })));
    expect(result).toEqual({ status: "failed" });
    expect(sink.write).not.toHaveBeenCalled();
  });

  it("fails when the provider throws after a delta", async () => {
    streamEvents.mockImplementation(async function* () {
      yield { type: "text-delta", delta: "half" };
      throw new AIBusinessError(
        AI_BUSINESS_ERROR_CODES.AI_EXECUTION_FAILED,
        "protocol parse failure",
      );
    });
    const result = await settle(runNestedGeneration(nestedArgs()));
    expect(result).toEqual({ status: "failed" });
  });

  it("fails on a yielded provider error event", async () => {
    streamEvents.mockReturnValue(
      streamOf([
        { type: "text-delta", delta: "half" },
        { type: "error", code: "STREAM_PROTOCOL_PARSE_FAILED" },
        { type: "text-delta", delta: "LATE" },
        { type: "completed", text: "halfLATE" },
      ]),
    );
    const result = await settle(runNestedGeneration(nestedArgs()));
    expect(result).toEqual({ status: "failed" });
  });

  it("settles an abort before the first delta as failure", async () => {
    const ac = new AbortController();
    ac.abort();
    streamEvents.mockImplementation(async function* (input: { signal?: AbortSignal }) {
      if (input.signal?.aborted) throw abortError();
      yield { type: "text-delta", delta: "nope" };
      yield { type: "completed", text: "nope" };
    });
    const result = await settle(
      runNestedGeneration(nestedArgs({ abortSignal: ac.signal })),
    );
    expect(result).toEqual({ status: "failed" });
  });

  it("settles an abort after a delta and drops late deltas", async () => {
    const ac = new AbortController();
    streamEvents.mockImplementation(async function* (input: { signal?: AbortSignal }) {
      yield { type: "text-delta", delta: "部分" };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        input.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(abortError());
        });
      });
      yield { type: "text-delta", delta: "LATE" };
      yield { type: "completed", text: "部分LATE" };
    });
    const sink = writer();
    sink.write.mockImplementation(() => {
      ac.abort();
    });
    const result = await settle(
      runNestedGeneration(nestedArgs({ abortSignal: ac.signal, writer: sink })),
    );
    expect(result).toEqual({ status: "failed" });
    expect(sink.write).toHaveBeenCalledTimes(1);
  });

  it("settles a timeout before terminal completion as failure", async () => {
    streamEvents.mockImplementation(async function* (input: { signal?: AbortSignal }) {
      yield { type: "text-delta", delta: "still going" };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        input.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(
            new AIBusinessError(
              AI_BUSINESS_ERROR_CODES.AI_EXECUTION_TIMEOUT,
              "Streaming execution timed out",
            ),
          );
        });
      });
      yield { type: "completed", text: "still going done" };
    });
    const result = await settle(
      runNestedGeneration(nestedArgs({ timeoutMs: 40 })),
      2_000,
    );
    expect(result).toEqual({ status: "failed" });
  });

  it("does not let a stale timeout flip a settled success", async () => {
    streamEvents.mockReturnValue(
      streamOf([
        { type: "text-delta", delta: "完整" },
        { type: "completed", text: "完整" },
      ]),
    );
    const result = await settle(runNestedGeneration(nestedArgs({ timeoutMs: 80 })));
    expect(result).toEqual({ status: "ok", text: "完整" });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(result).toEqual({ status: "ok", text: "完整" });
  });

  it("logs settlement metadata without prompt or output text", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    streamEvents.mockReturnValue(
      streamOf([
        { type: "text-delta", delta: REVIEW },
        { type: "completed", text: REVIEW },
      ]),
    );
    await settle(runNestedGeneration(nestedArgs()));
    const line = info.mock.calls.find((call) =>
      String(call[0]).includes("account stream settled"),
    );
    expect(line?.[1]).toMatchObject({
      provider: "vocatrya.account",
      model: "gpt-test",
      outcome: "succeeded",
      finishReasonPresent: false,
      deltaCount: 1,
      aborted: false,
    });
    expect(JSON.stringify(line?.[1])).not.toContain(REVIEW);
    expect(JSON.stringify(line?.[1])).not.toContain("PROMPT-SECRET");
  });

  it("review_resume reaches one successful tool result and persists the review once", async () => {
    streamEvents.mockReturnValue(
      streamOf([
        { type: "text-delta", delta: REVIEW.slice(0, 20) },
        { type: "text-delta", delta: REVIEW.slice(20) },
        { type: "completed", text: REVIEW },
      ]),
    );
    decisionText.mockResolvedValue({
      text: '{"type":"tool_call","tool":"review_resume","arguments":"{}"}',
    });
    const { writer: turnWriter, chunks } = captureWriter();
    const result = await settle(
      runAccountAgentTurn({
        userId: "user-1",
        connectionId: "conn-1",
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        modelName: "gpt-test",
        systemPrompt: "system",
        messages: [userMsg("review my resume")],
        writer: turnWriter as never,
        signal: new AbortController().signal,
      }),
    );
    expect(result.paused).toBe(false);
    const outputs = chunks.filter((chunk) => chunk.type === "tool-output-available");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].output).toMatchObject({ status: "ok", title: "Senior Engineer Resume" });
    expect(chunks.filter((chunk) => chunk.type === "finish")).toHaveLength(1);
    expect(saveReview).toHaveBeenCalledTimes(1);
    expect(streamEvents).toHaveBeenCalledTimes(1);
  });

  it("generate_cover_letter settles on the same runtime without a fresh/full exposure change", async () => {
    streamEvents.mockReturnValue(
      streamOf([
        { type: "text-delta", delta: LETTER.slice(0, 12) },
        { type: "text-delta", delta: LETTER.slice(12) },
        { type: "completed" },
      ]),
    );
    decisionText.mockResolvedValue({
      text: '{"type":"tool_call","tool":"generate_cover_letter","arguments":"{}"}',
    });
    const { writer: turnWriter, chunks } = captureWriter();
    await settle(
      runAccountAgentTurn({
        userId: "user-1",
        connectionId: "conn-1",
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        modelName: "gpt-test",
        systemPrompt: "system",
        messages: [userMsg("write a cover letter")],
        pageContext: { jobId: "job-1" },
        writer: turnWriter as never,
        signal: new AbortController().signal,
        freshNativeFull: false,
      }),
    );
    const outputs = chunks.filter((chunk) => chunk.type === "tool-output-available");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].output).toMatchObject({ status: "ok", jobId: "job-1" });
    expect(saveLetter).toHaveBeenCalledTimes(1);
    expect(chunks.filter((chunk) => chunk.type === "finish")).toHaveLength(1);
  });

  it("an aborted review does not persist a successful review or assistant success", async () => {
    const ac = new AbortController();
    streamEvents.mockImplementation(async function* (input: { signal?: AbortSignal }) {
      yield { type: "text-delta", delta: REVIEW.slice(0, 12) };
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 5_000);
        input.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(abortError());
        });
      });
      yield { type: "completed", text: REVIEW };
    });
    decisionText.mockResolvedValue({
      text: '{"type":"tool_call","tool":"review_resume","arguments":"{}"}',
    });
    const { writer: turnWriter, chunks } = captureWriter();
    const sink = {
      ...turnWriter,
      write: (part: StreamChunk) => {
        turnWriter.write(part);
        if (part.type === "data-nested-stream") ac.abort();
      },
    };
    await settle(
      runAccountAgentTurn({
        userId: "user-1",
        connectionId: "conn-1",
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        modelName: "gpt-test",
        systemPrompt: "system",
        messages: [userMsg("review my resume")],
        writer: sink as never,
        signal: ac.signal,
      }),
    );
    const outputs = chunks.filter((chunk) => chunk.type === "tool-output-available");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].output).toMatchObject({ status: "generation_failed" });
    expect(JSON.stringify(outputs[0].output)).not.toContain("## Summary");
    expect(saveReview).not.toHaveBeenCalled();
    expect(chunks.filter((chunk) => chunk.type === "text-delta")).toHaveLength(0);
  });
});

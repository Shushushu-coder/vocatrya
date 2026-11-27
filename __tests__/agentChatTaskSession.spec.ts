/**
 * Chat route wiring for task sessions (legacy-lock path, fake model): the
 * session context is resolved from the conversation row, the task prompt
 * section / tool extension / verified line apply to task sessions only, the
 * handoff trigger fires after the turn is committed, and none of it can fail
 * the user's turn. Ordinary conversations take none of these paths.
 */
vi.mock("@/lib/agent/preferences.server", () => ({
  loadAgentPreferences: vi.fn(async () => ({ personalInstructions: "", defaultPermission: "rules", autoArchiveDays: 0, compressHistory: false })),
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
const archiveRows = vi.hoisted(() => ({ findMany: vi.fn(async () => [] as { id: string }[]) }));
vi.mock("@/lib/db", () => ({ default: { jobOpportunity: archiveRows } }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));
vi.mock("@/lib/ai/rate-limiter", () => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/ai/providers", () => ({ getModel: vi.fn() }));
vi.mock("@/actions/userSettings.actions", () => ({ getUserSettings: vi.fn() }));
vi.mock("@/lib/agent/conversationStream", () => ({ conversationCommitStream: (stream: unknown) => stream }));
const conversationStore = vi.hoisted(() => ({
  row: {
    id: "conv-1",
    revision: 0,
    userId: "user-1",
    title: null as string | null,
    context: null as string | null,
    messages: "[]",
    resolvedConnectionId: null as string | null,
    resolvedModel: null as string | null,
    agentRole: null as string | null,
    agentTaskId: null as string | null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
}));
vi.mock("@/lib/agent/conversationRequest", async (original) => ({
  ...(await original<typeof import("@/lib/agent/conversationRequest")>()),
  admitConversationRequest: vi.fn(async (input: any) => ({
    ...input,
    revision: input.expectedRevision + 1,
    messages: input.operation === "send" ? [...JSON.parse(conversationStore.row.messages), input.newMessage] : JSON.parse(conversationStore.row.messages),
    responseMessageId: "",
    released: false,
    wrote: false,
  })),
  finishConversationRequest: vi.fn(async (request: any, messages: any[]) => {
    request.released = true;
    request.messages = messages;
    return ++request.revision;
  }),
  cancelConversationRequest: vi.fn(async () => true),
}));
vi.mock("@/lib/agent/chatConversationStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/chatConversationStore")>();
  return { ...actual, getOwnedChatConversation: vi.fn(async () => conversationStore.row) };
});
vi.mock("@/lib/agent/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent/tools")>();
  return { ...actual, buildAgentTools: vi.fn(actual.buildAgentTools) };
});
vi.mock("@/lib/agent/conversationSummaryScheduler", () => ({
  scheduleCareerDialogueSummary: vi.fn(() => ({ opened: false, syncMs: 0 })),
}));
const taskHooks = vi.hoisted(() => ({
  resolveTaskSessionContext: vi.fn(),
  scheduleTaskHandoff: vi.fn(() => ({ opened: true })),
}));
vi.mock("@/lib/agent/task/agentTaskBootstrap", () => ({
  resolveTaskSessionContext: taskHooks.resolveTaskSessionContext,
}));
vi.mock("@/lib/agent/task/agentTaskHandoffTrigger", () => ({
  scheduleTaskHandoff: taskHooks.scheduleTaskHandoff,
}));
vi.mock("@/lib/career/runtimeMode", () => ({
  resolveCareerRuntimeMode: vi.fn(async () => ({ mode: "LEGACY_ONLY", rolloutScope: "none", origin: "legacy" })),
}));

const toUIMessageStream = vi.fn(
  () =>
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
);
const streamText = vi.fn((..._args: any[]) => ({ toUIMessageStream }));
const streamArgs = (): any => streamText.mock.calls[0]![0];
let capturedOnFinish: ((arg: any) => Promise<void>) | undefined;
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    streamText: (...args: unknown[]) => streamText(...(args as [])),
    createUIMessageStream: (options: any) => {
      capturedOnFinish = options.onFinish;
      return actual.createUIMessageStream(options);
    },
  };
});

import { POST } from "@/app/api/ai/chat/route";
import { auth } from "@/auth";
import { checkRateLimit } from "@/lib/ai/rate-limiter";
import { getModel } from "@/lib/ai/providers";
import { getUserSettings } from "@/actions/userSettings.actions";
import { finishConversationRequest } from "@/lib/agent/conversationRequest";
import { buildAgentTools } from "@/lib/agent/tools";

const LINE = "Active task state (system-maintained, verified 2026-11-19T00:00:00.000Z):\nTask: 面试冲刺 · milestone=PRACTICING · blocked=no";
const TASK_SESSION = {
  taskId: "task-1",
  extraTools: ["match_job", "get_resume"],
  handoffLine: LINE,
};

const req = (text = "continue") => {
  conversationStore.row.messages = "[]";
  return {
    json: async () => ({
      conversationId: "conv-1",
      expectedRevision: 0,
      requestId: "request-1",
      operation: "send",
      newMessage: { id: "m1", role: "user", parts: [{ type: "text", text }] },
    }),
    signal: new AbortController().signal,
  } as any;
};

const finalMessages = [
  { id: "m1", role: "user", parts: [{ type: "text", text: "continue" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", text: "done" }] },
];
const finish = (over: Record<string, unknown> = {}) =>
  capturedOnFinish!({
    messages: finalMessages,
    responseMessage: finalMessages[1],
    isAborted: false,
    ...over,
  });
const modelMessageTexts = () =>
  (streamArgs().messages as any[]).map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

describe("POST /api/ai/chat: task sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (auth as any).mockResolvedValue({ user: { id: "user-1" } });
    (checkRateLimit as any).mockReturnValue({ allowed: true, remaining: 29, resetIn: 60000 });
    (getUserSettings as any).mockResolvedValue({
      success: true,
      data: { settings: { ai: { provider: "ollama", model: "qwen3.5:9b" } } },
    });
    (getModel as any).mockResolvedValue({ id: "fake-model" });
    conversationStore.row.agentRole = "pilot";
    conversationStore.row.agentTaskId = null;
    conversationStore.row.context = null;
    conversationStore.row.resolvedConnectionId = null;
    conversationStore.row.resolvedModel = null;
    taskHooks.resolveTaskSessionContext.mockResolvedValue(null);
    taskHooks.scheduleTaskHandoff.mockImplementation(() => ({ opened: true }));
  });

  it("task session: prompt section, verified line, tool extension, and handoff trigger after commit", async () => {
    conversationStore.row.agentTaskId = "task-1";
    taskHooks.resolveTaskSessionContext.mockResolvedValue(TASK_SESSION);
    const res = await POST(req());
    expect(res.status).not.toBe(503);
    expect(taskHooks.resolveTaskSessionContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "user-1", agentTaskId: "task-1", agentRole: "pilot" }),
    );
    expect(streamArgs().system).toContain("long-running job-search task");
    expect(streamArgs().system).toContain("match_job screens the job");
    const texts = modelMessageTexts();
    const lineIndex = texts.findIndex((text) => text.includes("Active task state"));
    const pageIndex = texts.findIndex((text) => text.includes("<page-context>"));
    expect(lineIndex).toBeGreaterThanOrEqual(0);
    expect(lineIndex).toBeLessThan(pageIndex);
    expect((buildAgentTools as any).mock.calls[0][0]).toMatchObject({
      agentRole: "pilot",
      taskExtraTools: ["match_job", "get_resume"],
    });

    expect(taskHooks.scheduleTaskHandoff).not.toHaveBeenCalled();
    await finish();
    expect(taskHooks.scheduleTaskHandoff).toHaveBeenCalledTimes(1);
    expect(taskHooks.scheduleTaskHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-1", conversationId: "conv-1", taskId: "task-1" }),
    );
    const saveOrder = (finishConversationRequest as any).mock.invocationCallOrder.at(-1);
    expect(saveOrder).toBeLessThan(taskHooks.scheduleTaskHandoff.mock.invocationCallOrder[0]);
  });

  it("a handoff trigger that throws never fails the turn", async () => {
    conversationStore.row.agentTaskId = "task-1";
    taskHooks.resolveTaskSessionContext.mockResolvedValue(TASK_SESSION);
    taskHooks.scheduleTaskHandoff.mockImplementation(() => {
      throw new Error("handoff exploded");
    });
    await POST(req());
    await expect(finish()).resolves.toBeUndefined();
    expect(finishConversationRequest).toHaveBeenCalled();
  });

  it("an aborted task turn writes no handoff", async () => {
    conversationStore.row.agentTaskId = "task-1";
    taskHooks.resolveTaskSessionContext.mockResolvedValue(TASK_SESSION);
    await POST(req());
    await finish({ isAborted: true });
    expect(taskHooks.scheduleTaskHandoff).not.toHaveBeenCalled();
  });

  it("a grounding-less task session keeps its tools and prompt section but sends no line", async () => {
    conversationStore.row.agentTaskId = "task-1";
    taskHooks.resolveTaskSessionContext.mockResolvedValue({ ...TASK_SESSION, handoffLine: undefined });
    await POST(req());
    expect(streamArgs().system).toContain("long-running job-search task");
    expect(modelMessageTexts().some((text) => text.includes("Active task state"))).toBe(false);
    expect((buildAgentTools as any).mock.calls[0][0].taskExtraTools).toEqual(["match_job", "get_resume"]);
  });

  it("an ordinary Pilot conversation: no section, no line, no extension, no handoff", async () => {
    await POST(req());
    expect(taskHooks.resolveTaskSessionContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ agentTaskId: null, agentRole: "pilot" }),
    );
    expect(streamArgs().system).not.toContain("long-running job-search task");
    expect(modelMessageTexts().some((text) => text.includes("Active task state"))).toBe(false);
    expect((buildAgentTools as any).mock.calls[0][0].taskExtraTools).toBeUndefined();
    await finish();
    expect(taskHooks.scheduleTaskHandoff).not.toHaveBeenCalled();
  });

  it("an ordinary conversation's system prompt and tool registry are identical to a task-free build", async () => {
    await POST(req());
    const system = streamArgs().system as string;
    const { buildAgentChatSystemPrompt } = await import("@/lib/agent/prompt");
    expect(system.startsWith(buildAgentChatSystemPrompt("zh-CN", { agentRole: "pilot", freshNativeFull: false, notionTools: [] }))).toBe(true);
    const names = Object.keys(streamArgs().tools).sort();
    expect(names).not.toContain("match_job");
    // D02: read-only get_resume is shared across all three roles; match_job stays task-extended only.
    expect(names).toContain("get_resume");
  });
});

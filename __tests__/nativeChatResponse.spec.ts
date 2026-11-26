// @vitest-environment node
import { vi, describe, it, expect, beforeEach } from "vitest";
import type { UIMessage } from "ai";
import { AGENT_NATIVE_SEARCH_PART_TYPE, AGENT_NATIVE_TOOL_PART_TYPE } from "@/models/agent.model";
import type { ConversationRequest } from "@/lib/agent/conversationRequest";

const mocks = vi.hoisted(() => ({
  executeNativeTurn: vi.fn(),
  finishConversationRequest: vi.fn(async () => 2),
  cancelConversationRequest: vi.fn(async () => true),
}));

vi.mock("@/lib/agent/nativeSession.server", () => ({
  executeNativeTurn: mocks.executeNativeTurn,
}));

vi.mock("@/lib/agent/conversationRequest", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent/conversationRequest")>()),
  finishConversationRequest: mocks.finishConversationRequest,
  cancelConversationRequest: mocks.cancelConversationRequest,
}));

vi.mock("@/lib/agent/conversationStream", () => ({
  conversationCommitStream: (stream: ReadableStream) => stream,
}));

import { nativeChatResponse } from "@/lib/agent/nativeChatResponse";

function makeRequest(userText = "帮我查一下最近招聘动态"): ConversationRequest {
  return {
    operation: "send",
    userId: "user-1",
    conversationId: "conv-1",
    requestId: "req-1",
    revision: 1,
    messages: [{ id: "u1", role: "user", parts: [{ type: "text", text: userText }] }],
    responseMessageId: "a1",
    released: false,
    wrote: false,
  };
}

async function consumeResponse(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

describe("nativeChatResponse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams and persists normalized native search parts without leaking thread ids", async () => {
    mocks.executeNativeTurn.mockImplementation(async function* () {
      yield {
        type: "native-session",
        threadId: "thread-secret-id",
        resumed: false,
        runtimeVersion: "0.170.0",
        runtimeProfileRef: "rp_1",
        configHash: "cfg_1",
      };
      yield {
        type: "native-event",
        version: 1,
        kind: "search",
        conversationId: "conv-1",
        nativeSessionId: "thread-secret-id",
        nativeTurnId: "turn-secret-id",
        itemId: "ws-1",
        occurredAt: "2026-11-25T05:00:00.000Z",
        payload: {
          status: "started",
          actionType: "search",
          query: "vocatrya jobs",
          queries: ["vocatrya jobs"],
          sources: [],
        },
      };
      yield {
        type: "native-event",
        version: 1,
        kind: "search",
        conversationId: "conv-1",
        nativeSessionId: "thread-secret-id",
        nativeTurnId: "turn-secret-id",
        itemId: "ws-1",
        occurredAt: "2026-11-25T05:00:01.000Z",
        payload: {
          status: "completed",
          actionType: "search",
          query: "vocatrya jobs",
          queries: ["vocatrya jobs"],
          sources: [{ url: "https://example.com/jobs", host: "example.com", title: "Example Jobs" }],
        },
      };
      yield { type: "text-delta", delta: "Found jobs." };
      yield { type: "completed", text: "Found jobs." };
    });

    const req = makeRequest();
    const res = nativeChatResponse({
      request: req,
      signal: new AbortController().signal,
      connectionId: "conn-1",
      model: "gpt-5.4",
      instructions: "career assistant",
    });

    const wire = await consumeResponse(res);
    expect(wire).toContain("data-native-search");
    expect(wire).not.toContain("thread-secret-id");
    expect(wire).not.toContain("turn-secret-id");

    expect(mocks.finishConversationRequest).toHaveBeenCalledTimes(1);
    const savedMessages = (mocks.finishConversationRequest.mock.calls[0] as unknown as [unknown, UIMessage[]])[1];
    const assistant = savedMessages.at(-1)!;
    expect(assistant.role).toBe("assistant");
    const searchPart = assistant.parts.find((p) => p.type === AGENT_NATIVE_SEARCH_PART_TYPE) as any;
    expect(searchPart).toMatchObject({
      type: AGENT_NATIVE_SEARCH_PART_TYPE,
      id: "native-search-ws-1",
      data: {
        version: 1,
        kind: "search",
        itemId: "ws-1",
        status: "completed",
        actionType: "search",
        query: "vocatrya jobs",
        sources: [{ url: "https://example.com/jobs", host: "example.com", title: "Example Jobs" }],
      },
    });
    expect(JSON.stringify(savedMessages)).not.toContain("thread-secret-id");
    expect(JSON.stringify(savedMessages)).not.toContain("turn-secret-id");
  });

  it("does not persist search parts when the model only writes search prose without native search events", async () => {
    mocks.executeNativeTurn.mockImplementation(async function* () {
      yield {
        type: "native-session",
        threadId: "thread-1",
        resumed: true,
        runtimeVersion: "0.170.0",
        runtimeProfileRef: "rp_1",
        configHash: "cfg_1",
      };
      yield { type: "text-delta", delta: "我已经搜索了 https://fake.example" };
      yield { type: "completed", text: "我已经搜索了 https://fake.example" };
    });

    const res = nativeChatResponse({
      request: makeRequest(),
      signal: new AbortController().signal,
      connectionId: "conn-1",
      model: "gpt-5.4",
      instructions: "career assistant",
    });

    await consumeResponse(res);
    expect(mocks.finishConversationRequest).toHaveBeenCalledTimes(1);
    const savedMessages = (mocks.finishConversationRequest.mock.calls[0] as unknown as [unknown, UIMessage[]])[1];
    const assistant = savedMessages.at(-1)!;
    expect(assistant.parts.some((p) => p.type === AGENT_NATIVE_SEARCH_PART_TYPE)).toBe(false);
  });

  it("cancels rather than finishing when execution errors or aborts", async () => {
    mocks.executeNativeTurn.mockImplementation(async function* () {
      yield {
        type: "native-session",
        threadId: "thread-1",
        resumed: false,
        runtimeVersion: "0.170.0",
        runtimeProfileRef: "rp_1",
        configHash: "cfg_1",
      };
      throw new Error("boom");
    });

    const res = nativeChatResponse({
      request: makeRequest(),
      signal: new AbortController().signal,
      connectionId: "conn-1",
      model: "gpt-5.4",
      instructions: "career assistant",
    });

    await consumeResponse(res);
    expect(mocks.finishConversationRequest).not.toHaveBeenCalled();
    expect(mocks.cancelConversationRequest).toHaveBeenCalledWith("user-1", "conv-1", "req-1");
  });

  it("streams and persists native approval_required and queued tool parts with proposal identity", async () => {
    mocks.executeNativeTurn.mockImplementation(async function* () {
      yield {
        type: "native-session",
        threadId: "thread-secret-2",
        resumed: false,
        runtimeVersion: "0.170.0",
        runtimeProfileRef: "rp_1",
        configHash: "cfg_1",
      };
      yield {
        type: "native-event",
        version: 1,
        kind: "tool_call",
        conversationId: "conv-1",
        nativeSessionId: "thread-secret-2",
        nativeTurnId: "turn-2",
        itemId: "call-add-1",
        occurredAt: "2026-11-26T05:00:00.000Z",
        payload: {
          tool: "add_job",
          status: "running",
          argumentsSummary: '{"company":"Acme","jobTitle":"Engineer"}',
        },
      };
      yield {
        type: "native-event",
        version: 1,
        kind: "tool_result",
        conversationId: "conv-1",
        nativeSessionId: "thread-secret-2",
        nativeTurnId: "turn-2",
        itemId: "call-add-1",
        occurredAt: "2026-11-26T05:00:01.000Z",
        payload: {
          tool: "add_job",
          status: "approval_required",
          proposalId: "prop-1",
          approvalId: "ap-1",
          expiresAt: "2026-12-03T05:00:01.000Z",
          resultSummary: '{"saved":false,"status":"approval_required","tool":"add_job","proposalId":"prop-1"}',
        },
      };
      yield { type: "text-delta", delta: "Created an approval card for you." };
      yield { type: "completed", text: "Created an approval card for you." };
    });

    const res = nativeChatResponse({
      request: makeRequest("Add Acme Engineer"),
      signal: new AbortController().signal,
      connectionId: "conn-1",
      model: "gpt-5.4",
      instructions: "career assistant",
      permissionMode: "ask",
      agentRole: "pilot",
    });

    const wire = await consumeResponse(res);
    expect(wire).toContain("data-native-tool");
    expect(wire).toContain("approval_required");
    expect(wire).not.toContain("thread-secret-2");

    const savedMessages = (mocks.finishConversationRequest.mock.calls[0] as unknown as [unknown, UIMessage[]])[1];
    const assistant = savedMessages.at(-1)!;
    const toolPart = assistant.parts.find((p) => p.type === AGENT_NATIVE_TOOL_PART_TYPE) as any;
    expect(toolPart).toMatchObject({
      type: AGENT_NATIVE_TOOL_PART_TYPE,
      id: "native-tool-call-add-1",
      data: {
        version: 1,
        kind: "tool",
        itemId: "call-add-1",
        tool: "add_job",
        status: "approval_required",
        proposalId: "prop-1",
        approvalId: "ap-1",
      },
    });
  });
});

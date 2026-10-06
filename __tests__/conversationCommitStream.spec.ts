// @vitest-environment node
import type { UIMessageChunk } from "ai";
import { conversationCommitStream } from "@/lib/agent/conversationStream";
import { ConversationRequestError, type ConversationRequest } from "@/lib/agent/conversationRequest";
import { AgentChatRequestSchema } from "@/models/agent.schema";
import { cancelConversationRequest } from "@/lib/agent/conversationRequest";
vi.mock("@/lib/agent/conversationRequest", async original => ({ ...await original<typeof import("@/lib/agent/conversationRequest")>(), cancelConversationRequest: vi.fn(async () => true) }));

const request = (): ConversationRequest => ({ userId: "u", conversationId: "c", requestId: "r", revision: 1, messages: [], responseMessageId: "a", released: false, wrote: false });
it("holds actionable approval and finish until the persistence barrier completes", async () => {
  const owned = request();
  let source!: ReadableStreamDefaultController<UIMessageChunk>;
  const input = new ReadableStream<UIMessageChunk>({ start(c) { source = c; } });
  const reader = conversationCommitStream(input, owned).getReader();
  expect((await reader.read()).value).toMatchObject({ type: "data-conversation", data: { durable: false } });
  source.enqueue({ type: "tool-approval-request", approvalId: "approval", toolCallId: "call" });
  source.enqueue({ type: "finish" });
  let arrived = false;
  const next = reader.read().then(value => { arrived = true; return value; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(arrived).toBe(false);
  owned.released = true;
  owned.revision = 2;
  source.close();
  expect((await next).value).toMatchObject({ type: "data-conversation", data: { durable: true, revision: 2 } });
  expect((await reader.read()).value?.type).toBe("tool-approval-request");
  expect((await reader.read()).value?.type).toBe("finish");
  expect((await reader.read()).done).toBe(true);
});
it("suppresses uncommitted approval on failure and reports a stable persistence code", async () => {
  const owned = request();
  const stream = conversationCommitStream(new ReadableStream<UIMessageChunk>({ start(c) {
    c.enqueue({ type: "tool-approval-request", approvalId: "approval", toolCallId: "call" });
    c.enqueue({ type: "finish" }); c.close();
  } }), owned);
  const reader = stream.getReader();
  const chunks: UIMessageChunk[] = [];
  for (;;) { const value = await reader.read(); if (value.done) break; chunks.push(value.value); }
  expect(chunks.some(c => c.type === "tool-approval-request" || c.type === "finish")).toBe(false);
  expect(chunks).toContainEqual(expect.objectContaining({ type: "error", errorText: expect.stringContaining("CONVERSATION_PERSISTENCE_FAILED") }));
  expect(cancelConversationRequest).toHaveBeenCalledWith("u", "c", "r");
});
it("emits stale ownership errors after HTTP 200", async () => {
  const owned = request();
  owned.failure = new ConversationRequestError("CONVERSATION_STALE_WRITE");
  const reader = conversationCommitStream(new ReadableStream<UIMessageChunk>({ start(c) { c.close(); } }), owned).getReader();
  await reader.read();
  expect((await reader.read()).value).toMatchObject({ type: "error", errorText: expect.stringContaining("CONVERSATION_STALE_WRITE") });
  await reader.read();
});
it("cancels ownership while an upstream read is pending without exposing approval", async () => {
  const owned = request();
  const upstreamCancel = vi.fn();
  const reader = conversationCommitStream(new ReadableStream<UIMessageChunk>({
    cancel: upstreamCancel,
  }), owned).getReader();
  await reader.read();
  const pending = reader.read();
  await reader.cancel("user stopped");
  expect(await pending).toMatchObject({ done: true });
  expect(cancelConversationRequest).toHaveBeenCalledWith("u", "c", "r");
  expect(upstreamCancel).toHaveBeenCalledWith("user stopped");
});
it.each([
  { dbFails: false, upstreamFails: false },
  { dbFails: true, upstreamFails: false },
  { dbFails: false, upstreamFails: true },
  { dbFails: true, upstreamFails: true },
])("always unlocks upstream on cancellation: %j", async ({ dbFails, upstreamFails }) => {
  const dbError = new Error("DB release failed");
  const upstreamError = new Error("upstream cancel failed");
  vi.mocked(cancelConversationRequest).mockImplementationOnce(async () => {
    if (dbFails) throw dbError;
    return true;
  });
  const upstreamCancel = vi.fn(async () => {
    if (upstreamFails) throw upstreamError;
  });
  const input = new ReadableStream<UIMessageChunk>({ cancel: upstreamCancel });
  const owned = request();
  owned.abort = vi.fn();
  const reader = conversationCommitStream(input, owned).getReader();
  await reader.read();
  const pending = reader.read();
  const cancellation = reader.cancel("stopped");
  if (dbFails || upstreamFails) {
    await expect(cancellation).rejects.toBe(dbFails ? dbError : upstreamError);
  } else {
    await cancellation;
  }
  expect(await pending).toMatchObject({ done: true });
  expect(upstreamCancel).toHaveBeenCalledExactlyOnceWith("stopped");
  expect(input.locked).toBe(false);
  expect(owned.abort).toHaveBeenCalledTimes(1);
  await reader.cancel("again");
  expect(upstreamCancel).toHaveBeenCalledTimes(1);
});
it.each(["toolCallId", "input", "toolName", "assistantId", "messages"])("rejects approval transport tampering through %s", field => {
  expect(AgentChatRequestSchema.safeParse({ conversationId: "c", expectedRevision: 0, requestId: "r", operation: "approval", approvalId: "p", decision: true, [field]: "tampered" }).success).toBe(false);
});
it.each(["expectedRevision", "requestId", "operation"])("rejects missing %s", field => {
  const body: Record<string, unknown> = { conversationId: "c", expectedRevision: 0, requestId: "r", operation: "send", newMessage: { id: "m", role: "user", parts: [{ type: "text", text: "hi" }] } };
  delete body[field];
  expect(AgentChatRequestSchema.safeParse(body).success).toBe(false);
});

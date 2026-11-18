import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { UIMessage } from "ai";
import { AIBusinessError } from "@/lib/ai/connections";
import { cancelConversationRequest, finishConversationRequest, type ConversationRequest } from "./conversationRequest";
import { conversationCommitStream } from "./conversationStream";
import { executeNativeTurn } from "./nativeSession.server";
import { formatAgentStreamError } from "./errors";

// No application router, transcript budgeting, summary or tool loop enters this
// path. Only the current user text is sent; the runtime owns its saved history.
export function nativeChatResponse(input: { request: ConversationRequest; signal: AbortSignal; connectionId: string; model: string; instructions: string }) {
  const { request, connectionId, model, instructions } = input;
  const current = request.messages.at(-1);
  if (current?.role !== "user" || current.parts.some(part => part.type !== "text")) throw new AIBusinessError("NATIVE_TEXT_ONLY", "Native sessions currently accept plain text only");
  const prompt = current.parts.map(part => part.type === "text" ? part.text : "").join("\n");
  const controller = new AbortController();
  request.abort = () => controller.abort();
  const signal = AbortSignal.any([input.signal, controller.signal, AbortSignal.timeout(120000)]);
  let failed = false;
  const stream = createUIMessageStream({
    originalMessages: request.messages,
    execute: async ({ writer }) => {
      const id = request.responseMessageId!;
      writer.write({ type: "start", messageId: id });
      writer.write({ type: "text-start", id });
      for await (const event of executeNativeTurn({ request, connectionId, model, prompt, instructions, signal })) {
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        if (event.type === "native-session") writer.write({ type: "data-native-session", transient: true, data: { conversationId: request.conversationId, requestId: request.requestId, resumed: event.resumed } });
        if (event.type === "text-delta") writer.write({ type: "text-delta", id, delta: event.delta });
        // Native ids remain on the server; the visible status makes no claim
        // that search, business tools or skills were loaded.
      }
      writer.write({ type: "text-end", id });
      writer.write({ type: "finish" });
    },
    onError: error => { failed = true; return formatAgentStreamError(error); },
    onFinish: async ({ messages, isAborted }: { messages: UIMessage[]; isAborted: boolean }) => {
      if (isAborted || failed || signal.aborted) await cancelConversationRequest(request.userId, request.conversationId, request.requestId);
      else await finishConversationRequest(request, messages);
    },
  });
  return createUIMessageStreamResponse({ stream: conversationCommitStream(stream, request) });
}

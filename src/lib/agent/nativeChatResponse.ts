import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import type { UIMessage } from "ai";
import { AIBusinessError } from "@/lib/ai/connections";
import {
  AGENT_NATIVE_SEARCH_PART_TYPE,
  type AgentNativeSearchPartData,
  type AgentNativeSearchSource,
} from "@/models/agent.model";
import { cancelConversationRequest, finishConversationRequest, type ConversationRequest } from "./conversationRequest";
import { conversationCommitStream } from "./conversationStream";
import { executeNativeTurn, type NativeSessionNeutralEvent } from "./nativeSession.server";
import { formatAgentStreamError } from "./errors";

function mergeNativeSearchPart(
  previous: AgentNativeSearchPartData | undefined,
  event: NativeSessionNeutralEvent,
): AgentNativeSearchPartData {
  const seenQueries = new Set<string>();
  const queries: string[] = [];
  for (const q of [...(previous?.queries ?? []), ...event.payload.queries]) {
    if (!q || seenQueries.has(q) || queries.length >= 12) continue;
    seenQueries.add(q);
    queries.push(q);
  }
  const byUrl = new Map<string, AgentNativeSearchSource>();
  for (const source of [...(previous?.sources ?? []), ...event.payload.sources]) {
    const existing = byUrl.get(source.url);
    if (existing) {
      if (!existing.title && source.title) existing.title = source.title;
      if (!existing.host && source.host) existing.host = source.host;
      continue;
    }
    if (byUrl.size >= 20) break;
    byUrl.set(source.url, { ...source });
  }
  const actionType =
    event.payload.actionType !== "other" || !previous
      ? event.payload.actionType
      : previous.actionType;
  return {
    version: 1,
    kind: "search",
    itemId: event.itemId,
    status: event.payload.status,
    actionType,
    query: event.payload.query || previous?.query || "",
    queries,
    ...(event.payload.pattern ?? previous?.pattern
      ? { pattern: event.payload.pattern ?? previous?.pattern }
      : {}),
    sources: [...byUrl.values()],
    occurredAt: event.occurredAt || previous?.occurredAt,
  };
}

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
      const searchParts = new Map<string, AgentNativeSearchPartData>();
      let textPartIndex = 0;
      let activeTextId: string | null = null;
      const closeText = () => {
        if (!activeTextId) return;
        writer.write({ type: "text-end", id: activeTextId });
        activeTextId = null;
      };
      writer.write({ type: "start", messageId: id });
      for await (const event of executeNativeTurn({ request, connectionId, model, prompt, instructions, signal })) {
        if (signal.aborted) throw new DOMException("Stopped", "AbortError");
        if (event.type === "native-session") {
          writer.write({ type: "data-native-session", transient: true, data: { conversationId: request.conversationId, requestId: request.requestId, resumed: event.resumed } });
        } else if (event.type === "native-event" && event.kind === "search") {
          closeText();
          const merged = mergeNativeSearchPart(searchParts.get(event.itemId), event);
          searchParts.set(event.itemId, merged);
          writer.write({
            type: AGENT_NATIVE_SEARCH_PART_TYPE,
            id: `native-search-${event.itemId}`,
            data: merged,
          });
        } else if (event.type === "text-delta") {
          if (!activeTextId) {
            activeTextId = textPartIndex === 0 ? id : `${id}-text-${textPartIndex}`;
            textPartIndex += 1;
            writer.write({ type: "text-start", id: activeTextId });
          }
          writer.write({ type: "text-delta", id: activeTextId, delta: event.delta });
        }
        // Native ids remain on the server; persisted parts carry only normalized
        // search queries and verified sources (no credentials or raw reasoning).
      }
      closeText();
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

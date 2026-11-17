import "server-only";
import type { UIMessageChunk } from "ai";
import { cancelConversationRequest, ConversationRequestError, type ConversationRequest } from "./conversationRequest";
import { formatAgentStreamError } from "./errors";

/** SDK onFinish completes before this reader reaches EOF. Approval and finish
 * chunks cross this barrier only after Vocatrya's persistence acknowledgement. */
export function conversationCommitStream(stream: ReadableStream<UIMessageChunk>, request: ConversationRequest) {
  const reader = stream.getReader();
  let buffered: UIMessageChunk[] = [];
  const ready: UIMessageChunk[] = [{ type: "data-conversation", transient: true, data: {
    conversationId: request.conversationId, requestId: request.requestId, revision: request.revision, durable: false,
  } }];
  let failed = false;
  let ended = false;
  let cancelled = false;
  const release = async () => {
    if (!request.released) await cancelConversationRequest(request.userId, request.conversationId, request.requestId);
  };
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (ready.length) { controller.enqueue(ready.shift()!); return; }
      if (ended) { controller.close(); return; }
      try {
        while (!cancelled) {
          const item = await reader.read();
          if (cancelled) return;
          if (item.done) {
            if (request.failure) throw request.failure;
            if (!failed && !request.released) throw new ConversationRequestError("CONVERSATION_PERSISTENCE_FAILED");
            if (!failed) {
              ready.push({ type: "data-conversation", transient: true, data: {
                conversationId: request.conversationId, requestId: request.requestId, revision: request.revision,
                durable: true, released: true, wrote: request.wrote,
              } }, ...buffered.map(chunk => {
                if (chunk.type !== "tool-approval-request") return chunk;
                const settled = request.messages.flatMap(m => m.parts).find(p =>
                  "toolCallId" in p && p.toolCallId === chunk.toolCallId && "state" in p && p.state === "output-available");
                // Full access approval was committed with a real queued task.
                // Do not briefly show a user approval card for that operation.
                if (settled && "output" in settled) return { type: "tool-output-available" as const, toolCallId: chunk.toolCallId, output: settled.output };
                return chunk;
              }));
            }
            await release();
            ended = true;
            reader.releaseLock();
            if (ready.length) controller.enqueue(ready.shift()!); else controller.close();
            return;
          }
          const chunk = item.value;
          if (chunk.type === "error") { failed = true; buffered = []; }
          if (chunk.type === "tool-approval-request" || chunk.type === "finish" || buffered.length) {
            if (!failed) buffered.push(chunk);
          } else { controller.enqueue(chunk); return; }
        }
      } catch (error) {
        if (cancelled) return;
        ended = true;
        const failure = error instanceof ConversationRequestError ? error : new ConversationRequestError("CONVERSATION_PERSISTENCE_FAILED");
        controller.enqueue({ type: "error", errorText: formatAgentStreamError(failure) });
        try { await release(); }
        catch { controller.enqueue({ type: "error", errorText: formatAgentStreamError(new ConversationRequestError("CONVERSATION_PERSISTENCE_FAILED")) }); }
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
    async cancel(reason) {
      cancelled = true;
      let releaseFailed = false;
      let releaseError: unknown;
      try {
        await release();
      } catch (error) {
        releaseFailed = true;
        releaseError = error;
      }
      try {
        try {
          await reader.cancel(reason);
        } finally {
          try {
            reader.releaseLock();
          } finally {
            request.abort?.();
          }
        }
      } finally {
        // A secondary upstream failure must not hide the DB release failure.
        if (releaseFailed) throw releaseError;
      }
    },
  });
}

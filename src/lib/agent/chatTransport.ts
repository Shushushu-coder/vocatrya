import {
  DefaultChatTransport,
  type ChatTransport,
  type HttpChatTransportInitOptions,
  type UIMessage,
  type UIMessageChunk,
} from "ai";

/**
 * ChatTransport that normalizes the backend's stable error envelope into a
 * human-readable Error. Every server action/route on this surface answers
 * failures as `{ error: "<message>" }` (sometimes with a structured `code`);
 * DefaultChatTransport would rethrow the raw body text — the UI then showed
 * the JSON verbatim (`{"error":"..."}`) instead of the message.
 *
 * Body parse failures (empty/non-JSON/malformed bodies, network errors) keep
 * DefaultChatTransport's original fallback — Error.message = response text.
 */
export class VocatryaChatTransport
  extends DefaultChatTransport<UIMessage>
  implements ChatTransport<UIMessage>
{
  constructor(options?: HttpChatTransportInitOptions<UIMessage>) {
    super(options ?? {});
  }

  async sendMessages(
    options: Parameters<ChatTransport<UIMessage>["sendMessages"]>[0],
  ): Promise<ReadableStream<UIMessageChunk>> {
    try {
      return await super.sendMessages(options);
    } catch (error) {
      throw humanizeChatTransportError(error);
    }
  }

  async reconnectToStream(
    options: Parameters<ChatTransport<UIMessage>["reconnectToStream"]>[0],
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    try {
      return await super.reconnectToStream(options);
    } catch (error) {
      throw humanizeChatTransportError(error);
    }
  }
}

/**
 * Unwraps `{ "error": "..." }` bodies embedded in transport errors. Returns
 * the original rejection unchanged when it isn't the stable envelope — the
 * caller's fallback semantics stay identical.
 */
export function humanizeChatTransportError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const message = error.message;
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start === -1 || end <= start) return error;
  try {
    const body = JSON.parse(message.slice(start, end + 1)) as {
      error?: unknown;
    };
    if (typeof body.error === "string" && body.error.length > 0) {
      return new Error(body.error);
    }
  } catch {
    // Malformed — keep the original message.
  }
  return error;
}

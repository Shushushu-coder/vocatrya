import {
  DefaultChatTransport,
  type ChatTransport,
  type HttpChatTransportInitOptions,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { parseAgentStreamError } from "./errors";

export class AgentChatClientError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = "AgentChatClientError";
    this.code = code;
  }
}

function envelopeOf(raw: string): { message: string; code: string } | null {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"error"')) return null;
  try {
    const body = JSON.parse(trimmed) as { error?: unknown; code?: unknown };
    return {
      message: typeof body.error === "string" ? body.error : "",
      code: typeof body.code === "string" && body.code ? body.code : "GENERIC",
    };
  } catch {
    return { message: "", code: "GENERIC" };
  }
}

export function readAgentChatError(error: unknown): {
  message: string;
  code: string;
} {
  if (error instanceof AgentChatClientError) {
    return { message: error.message, code: error.code };
  }
  const raw = error instanceof Error ? error.message : "";
  const parsed = parseAgentStreamError(raw);
  if (parsed) return parsed;
  const envelope = envelopeOf(raw);
  if (envelope) return envelope;
  if (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return { message: raw, code: (error as { code: string }).code };
  }
  if (raw.trim().startsWith("{")) return { message: "", code: "GENERIC" };
  return { message: raw, code: "GENERIC" };
}

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
      code?: unknown;
    };
    if (typeof body.error === "string" && body.error.length > 0) {
      const code = typeof body.code === "string" && body.code ? body.code : "GENERIC";
      return new AgentChatClientError(body.error, code);
    }
  } catch {
    // Malformed — keep the original message.
  }
  return error;
}

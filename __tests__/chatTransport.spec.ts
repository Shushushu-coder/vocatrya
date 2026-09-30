/**
 * VocatryaChatTransport — normalizes the backend's stable error envelope
 * ({error: "<human message>"}) that DefaultChatTransport would otherwise
 * rethrow as raw JSON text. The UI must never display an envelope.
 */
import {
  VocatryaChatTransport,
  humanizeChatTransportError,
} from "@/lib/agent/chatTransport";

describe("humanizeChatTransportError", () => {
  it("unwraps the {error} envelope into the human message", () => {
    const error = new Error('{"error":"The model is unavailable"}');
    const normalized = humanizeChatTransportError(error);
    expect(normalized).toBeInstanceOf(Error);
    expect((normalized as Error).message).toBe("The model is unavailable");
  });

  it("passes through a plain-text error untouched", () => {
    const error = new Error("network down");
    expect(humanizeChatTransportError(error)).toBe(error);
  });

  it("passes through malformed JSON bodies", () => {
    const error = new Error('{"error": unterminated');
    expect(humanizeChatTransportError(error)).toBe(error);
  });

  it("ignores JSON that is not the error envelope", () => {
    const error = new Error('{"code":"X","detail":"no error key"}');
    expect(humanizeChatTransportError(error)).toBe(error);
  });

  it("ignores a non-Error rejection", () => {
    expect(humanizeChatTransportError("raw string")).toBe("raw string");
    expect(humanizeChatTransportError(null)).toBeNull();
  });
});

describe("VocatryaChatTransport", () => {
  const options = {
    chatId: "c1",
    messageMetadata: undefined,
    requestMetadata: undefined,
    messages: [
      {
        id: "m1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hi" }],
      },
    ],
    abortSignal: undefined,
    messageId: undefined,
    trigger: "submit-message" as const,
  };

  it("turns a 503 {error} body into a human-readable Error", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "The assigned AI runtime cannot stream responses, so it cannot run Career Dialogue.",
          }),
          { status: 503, headers: { "content-type": "application/json" } },
        ),
    );
    const transport = new VocatryaChatTransport({
      api: "/api/ai/chat",
      fetch: fetchImpl as never,
    });
    await expect(transport.sendMessages(options)).rejects.toMatchObject({
      message:
        "The assigned AI runtime cannot stream responses, so it cannot run Career Dialogue.",
    });
  });

  it("keeps a non-envelope error body as its raw text", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("plain failure text", { status: 500 }),
    );
    const transport = new VocatryaChatTransport({
      api: "/api/ai/chat",
      fetch: fetchImpl as never,
    });
    await expect(transport.sendMessages(options)).rejects.toMatchObject({
      message: "plain failure text",
    });
  });
});

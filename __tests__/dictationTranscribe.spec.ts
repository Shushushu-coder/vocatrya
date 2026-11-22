// AWU-DICTATION provider adapter: the Gemini request shapes per protocol
// and the stable wire-code mapping for every failure surface. fetchImpl is
// injected so no network ever runs. Dictation is Gemini-only (N-2) — the
// shared HTTP error mapper is exercised through the generateContent path.
import {
  DictationError,
  transcribeDictationAudio,
  type TranscribeOptions,
} from "@/lib/dictation/transcribe.server";
import { DICTATION_ERROR_CODES } from "@/lib/dictation/config";

const audio = {
  bytes: Buffer.from([1, 2, 3]),
  mimeType: "audio/webm",
  fileName: "dictation.webm",
};

function opts(overrides: Partial<TranscribeOptions> = {}): TranscribeOptions {
  return {
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    apiKey: "AIza-test",
    audio,
    ...overrides,
  };
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("transcribeDictationAudio — Gemini generateContent", () => {
  it("sends inline audio to generateContent and joins the text parts", async () => {
    const doFetch = vi.fn(async () =>
      okJson({
        candidates: [
          { content: { parts: [{ text: "hello " }, { text: "world" }] } },
        ],
      }),
    );
    const text = await transcribeDictationAudio(opts({ fetchImpl: doFetch }));
    expect(text).toBe("hello world");
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent",
    );
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "AIza-test",
    );
    const body = JSON.parse(init.body as string);
    const part = body.contents[0].parts[0];
    expect(part.inline_data.mime_type).toBe("audio/webm");
    expect(part.inline_data.data).toBe(audio.bytes.toString("base64"));
    // The key stays in a header, never in the URL.
    expect(url).not.toContain("AIza-test");
  });

  it.each([
    [400, DICTATION_ERROR_CODES.INVALID_AUDIO],
    [401, DICTATION_ERROR_CODES.AUTH_FAILED],
    [403, DICTATION_ERROR_CODES.AUTH_FAILED],
    [404, DICTATION_ERROR_CODES.MODEL_UNAVAILABLE],
    [413, DICTATION_ERROR_CODES.AUDIO_TOO_LARGE],
    [429, DICTATION_ERROR_CODES.RATE_LIMITED],
    [500, DICTATION_ERROR_CODES.PROVIDER_ERROR],
    [503, DICTATION_ERROR_CODES.PROVIDER_ERROR],
  ])("maps HTTP %i to %s", async (status, code) => {
    const doFetch = vi.fn(async () => okJson({ error: "nope" }, status));
    await expect(
      transcribeDictationAudio(opts({ fetchImpl: doFetch })),
    ).rejects.toMatchObject({ name: "DictationError", code });
  });

  it("maps a fetch rejection to NETWORK", async () => {
    const doFetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      transcribeDictationAudio(opts({ fetchImpl: doFetch })),
    ).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.NETWORK });
  });

  it("maps an abort to TIMEOUT", async () => {
    const doFetch = vi.fn(async () => {
      throw Object.assign(new Error("The operation was aborted"), {
        name: "AbortError",
      });
    });
    await expect(
      transcribeDictationAudio(opts({ fetchImpl: doFetch })),
    ).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.TIMEOUT });
  });

  it("rejects an unreadable or textless response as PROVIDER_ERROR", async () => {
    const badJson = vi.fn(
      async () => new Response("<html>", { status: 200 }),
    );
    await expect(
      transcribeDictationAudio(opts({ fetchImpl: badJson })),
    ).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.PROVIDER_ERROR });

    const noText = vi.fn(async () => okJson({}));
    await expect(
      transcribeDictationAudio(opts({ fetchImpl: noText })),
    ).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.EMPTY_RESULT });
  });

  it("never echoes provider error bodies in the thrown message", async () => {
    const doFetch = vi.fn(async () =>
      okJson({ error: { message: "AIza-test leaked" } }, 401),
    );
    try {
      await transcribeDictationAudio(opts({ fetchImpl: doFetch }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DictationError);
      expect((error as Error).message).not.toContain("AIza-test");
    }
  });

  it("identifies Gemini key rejection without exposing the upstream message", async () => {
    await expect(transcribeDictationAudio(opts({ fetchImpl: vi.fn(async () => okJson({
      error: { message: "synthetic secret", details: [{ reason: "API_KEY_INVALID" }] },
    }, 400)) }))).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.AUTH_FAILED,
      message: "The transcription service rejected the configured API key" });
  });
});

describe("transcribeDictationAudio — Gemini Interactions", () => {
  it("classifies the Interactions array error envelope without leaking its message", async () => {
    await expect(transcribeDictationAudio(opts({
      model: "gemini-3.5-transcribe",
      fetchImpl: vi.fn(async () => okJson([{
        error: { message: "synthetic secret", details: [{ reason: "API_KEY_INVALID" }] },
      }], 400)),
    }))).rejects.toMatchObject({
      code: DICTATION_ERROR_CODES.AUTH_FAILED,
      message: "The transcription service rejected the configured API key",
      upstreamStatus: 400,
    });
  });

  it.each([[], [null], null])("falls back to HTTP status for an unusable error envelope %#", async body => {
    await expect(transcribeDictationAudio(opts({
      model: "gemini-3.5-transcribe",
      fetchImpl: vi.fn(async () => okJson(body, 400)),
    }))).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.INVALID_AUDIO, upstreamStatus: 400 });
  });
  it("routes a dedicated transcription model to Interactions and preserves verbatim mode", async () => {
    const doFetch = vi.fn(async () => okJson({ status: "completed", output_text: "实际转写" }));
    await expect(transcribeDictationAudio(opts({ model: "models/gemini-3.5-transcribe", fetchImpl: doFetch,
      audio: { ...audio, mimeType: "audio/webm;codecs=opus" } }))).resolves.toBe("实际转写");
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "gemini-3.5-transcribe", store: false,
      input: [{ type: "audio", mime_type: "audio/webm" }],
      generation_config: { transcription_config: { mode: { type: "verbatim" } } } });
  });

  it("rejects incomplete interactions even when partial text exists", async () => {
    await expect(transcribeDictationAudio(opts({ model: "gemini-3.5-transcribe",
      fetchImpl: vi.fn(async () => okJson({ status: "incomplete", output_text: "partial" })) })))
      .rejects.toMatchObject({ code: DICTATION_ERROR_CODES.PROVIDER_ERROR });
  });

  it.each([
    ["DICTATION_TIMEOUT", DICTATION_ERROR_CODES.TIMEOUT],
    ["DICTATION_CANCELLED", DICTATION_ERROR_CODES.CANCELLED],
  ])("classifies the actual route abort reason %s", async (reason, code) => {
    const controller = new AbortController();
    controller.abort(new Error(reason));
    await expect(transcribeDictationAudio(opts({ signal: controller.signal,
      fetchImpl: vi.fn(async () => { throw controller.signal.reason; }) }))).rejects.toMatchObject({ code });
  });
});

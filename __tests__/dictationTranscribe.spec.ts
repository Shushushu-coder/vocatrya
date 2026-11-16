// AWU-DICTATION provider adapters: request shape per provider and the
// stable wire-code mapping for every failure surface. fetchImpl is
// injected so no network ever runs.
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
    provider: "openai",
    model: "gpt-transcribe",
    apiKey: "sk-test",
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

describe("transcribeDictationAudio — OpenAI", () => {
  it("posts the clip to the OpenAI transcriptions endpoint and returns the text", async () => {
    const doFetch = vi.fn(async () => okJson({ text: " transcript " }));
    const text = await transcribeDictationAudio(opts({ fetchImpl: doFetch }));
    expect(text).toBe(" transcript ");
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer sk-test",
    );
    const form = init.body as FormData;
    expect(form.get("model")).toBe("gpt-transcribe");
    const file = form.get("file") as File;
    expect(file.name).toBe("dictation.webm");
    expect(file.type).toBe("audio/webm");
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
    ).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.PROVIDER_ERROR });
  });

  it("never echoes provider error bodies in the thrown message", async () => {
    const doFetch = vi.fn(async () =>
      okJson({ error: { message: "sk-test leaked" } }, 401),
    );
    try {
      await transcribeDictationAudio(opts({ fetchImpl: doFetch }));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DictationError);
      expect((error as Error).message).not.toContain("sk-test");
    }
  });
});

describe("transcribeDictationAudio — Gemini", () => {
  it("classifies the Interactions array error envelope without leaking its message", async () => {
    await expect(transcribeDictationAudio(opts({
      provider: "gemini",
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
      provider: "gemini", model: "gemini-3.5-transcribe",
      fetchImpl: vi.fn(async () => okJson(body, 400)),
    }))).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.INVALID_AUDIO, upstreamStatus: 400 });
  });
  it("routes a dedicated transcription model to Interactions and preserves verbatim mode", async () => {
    const doFetch = vi.fn(async () => okJson({ status: "completed", output_text: "实际转写" }));
    await expect(transcribeDictationAudio(opts({ provider: "gemini", model: "models/gemini-3.5-transcribe", fetchImpl: doFetch,
      audio: { ...audio, mimeType: "audio/webm;codecs=opus" } }))).resolves.toBe("实际转写");
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(JSON.parse(init.body as string)).toMatchObject({ model: "gemini-3.5-transcribe", store: false,
      input: [{ type: "audio", mime_type: "audio/webm" }],
      generation_config: { transcription_config: { mode: { type: "verbatim" } } } });
  });

  it("rejects incomplete interactions even when partial text exists", async () => {
    await expect(transcribeDictationAudio(opts({ provider: "gemini", model: "gemini-3.5-transcribe",
      fetchImpl: vi.fn(async () => okJson({ status: "incomplete", output_text: "partial" })) })))
      .rejects.toMatchObject({ code: DICTATION_ERROR_CODES.PROVIDER_ERROR });
  });

  it("identifies Gemini key rejection without exposing the upstream message", async () => {
    await expect(transcribeDictationAudio(opts({ provider: "gemini", fetchImpl: vi.fn(async () => okJson({
      error: { message: "synthetic secret", details: [{ reason: "API_KEY_INVALID" }] },
    }, 400)) }))).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.AUTH_FAILED,
      message: "The transcription service rejected the configured API key" });
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
  it("sends inline audio to generateContent and joins the text parts", async () => {
    const doFetch = vi.fn(async () =>
      okJson({
        candidates: [
          { content: { parts: [{ text: "hello " }, { text: "world" }] } },
        ],
      }),
    );
    const text = await transcribeDictationAudio(
      opts({
        provider: "gemini",
        model: "gemini-2.5-flash",
        fetchImpl: doFetch,
      }),
    );
    expect(text).toBe("hello world");
    const [url, init] = doFetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect((init.headers as Record<string, string>)["x-goog-api-key"]).toBe(
      "sk-test",
    );
    const body = JSON.parse(init.body as string);
    const part = body.contents[0].parts[0];
    expect(part.inline_data.mime_type).toBe("audio/webm");
    expect(part.inline_data.data).toBe(audio.bytes.toString("base64"));
    // The key stays in a header, never in the URL.
    expect(url).not.toContain("sk-test");
  });

  it("reports an empty candidate list as EMPTY_RESULT", async () => {
    const doFetch = vi.fn(async () => okJson({ candidates: [] }));
    await expect(
      transcribeDictationAudio(
        opts({ provider: "gemini", model: "gemini-2.5-flash", fetchImpl: doFetch }),
      ),
    ).rejects.toMatchObject({ code: DICTATION_ERROR_CODES.EMPTY_RESULT });
  });
});

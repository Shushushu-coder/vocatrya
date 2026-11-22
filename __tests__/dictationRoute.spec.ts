// AWU-DICTATION transcription route: auth gate, multipart audio
// validation, upstream failure mapping and the client-cancel/timeout
// signal linkage. The settings store and provider adapter are mocked —
// their own specs cover resolution and wire mapping.
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (data: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => data,
    }),
  },
}));
vi.mock("@/lib/telemetry", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
const resolveDictationConfig = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dictation/settings.server", () => ({
  resolveDictationConfig,
}));
const transcribeDictationAudio = vi.hoisted(() => vi.fn());
vi.mock("@/lib/dictation/transcribe.server", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/dictation/transcribe.server")>();
  return { ...actual, transcribeDictationAudio };
});

import { POST } from "@/app/api/ai/dictation/route";
import { auth } from "@/auth";
import { DictationError } from "@/lib/dictation/transcribe.server";
import { DICTATION_ERROR_CODES } from "@/lib/dictation/config";
import { APP_CONSTANTS } from "@/lib/constants";

const CONFIGURED = {
  settings: {
    provider: "gemini",
    model: "gemini-3.5-flash-lite",
    credentialMode: "shared",
  },
  apiKey: "AIza-live",
};

// Duck-typed upload part — the route itself only requires this shape.
function audioPart(size = 4, type = "audio/webm") {
  return {
    name: "dictation.webm",
    size,
    type,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  };
}

function req(
  options: {
    audio?: unknown;
    contentLength?: number;
    signal?: AbortSignal;
  } = {},
) {
  const { audio = audioPart(), contentLength, signal } = options;
  return {
    headers: {
      get: (name: string) =>
        name === "content-length" && contentLength !== undefined
          ? String(contentLength)
          : null,
    },
    formData: async () => ({ get: (key: string) => (key === "audio" ? audio : null) }),
    signal: signal ?? new AbortController().signal,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  (auth as ReturnType<typeof vi.fn>).mockResolvedValue({
    user: { id: "user-1" },
  });
  resolveDictationConfig.mockResolvedValue(CONFIGURED);
  transcribeDictationAudio.mockResolvedValue("hello transcript");
});

describe("POST /api/ai/dictation", () => {
  it("returns 401 without a session", async () => {
    (auth as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(transcribeDictationAudio).not.toHaveBeenCalled();
  });

  it("transcribes a valid clip and returns only the text", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      text: "hello transcript",
    });
    expect(transcribeDictationAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "gemini",
        model: "gemini-3.5-flash-lite",
        apiKey: "AIza-live",
        audio: expect.objectContaining({
          mimeType: "audio/webm",
          fileName: "dictation.webm",
        }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("rejects a missing or empty audio part", async () => {
    for (const audio of [null, "not-a-file", audioPart(0)]) {
      const res = await POST(req({ audio }));
      expect(res.status).toBe(400);
    }
    expect(transcribeDictationAudio).not.toHaveBeenCalled();
  });

  it("rejects a non-audio mime type", async () => {
    const res = await POST(req({ audio: audioPart(4, "text/plain") }));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(DICTATION_ERROR_CODES.INVALID_AUDIO);
  });

  it("rejects an oversized upload by content-length before parsing", async () => {
    const formData = vi.fn();
    const res = await POST({
      headers: {
        get: (name: string) =>
          name === "content-length"
            ? String(
                APP_CONSTANTS.AGENT_DICTATION_MAX_AUDIO_BYTES + 128 * 1024,
              )
            : null,
      },
      formData,
      signal: new AbortController().signal,
    } as never);
    expect(res.status).toBe(413);
    expect(formData).not.toHaveBeenCalled();
  });

  it("rejects an oversized audio part", async () => {
    const res = await POST(
      req({
        audio: audioPart(APP_CONSTANTS.AGENT_DICTATION_MAX_AUDIO_BYTES + 1),
      }),
    );
    expect(res.status).toBe(413);
    expect(transcribeDictationAudio).not.toHaveBeenCalled();
  });

  it("maps NOT_CONFIGURED to 400 and never touches the adapter", async () => {
    resolveDictationConfig.mockRejectedValue(
      new DictationError(DICTATION_ERROR_CODES.NOT_CONFIGURED, "not set"),
    );
    const res = await POST(req());
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe(
      DICTATION_ERROR_CODES.NOT_CONFIGURED,
    );
    expect(transcribeDictationAudio).not.toHaveBeenCalled();
  });

  it("maps CREDENTIAL_UNAVAILABLE to 400 without key material", async () => {
    resolveDictationConfig.mockRejectedValue(
      new DictationError(
        DICTATION_ERROR_CODES.CREDENTIAL_UNAVAILABLE,
        "cannot read",
      ),
    );
    const res = await POST(req());
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(DICTATION_ERROR_CODES.CREDENTIAL_UNAVAILABLE);
    expect(JSON.stringify(body)).not.toContain("AIza-live");
  });

  it.each([
    [DICTATION_ERROR_CODES.AUTH_FAILED, 502],
    [DICTATION_ERROR_CODES.RATE_LIMITED, 429],
    [DICTATION_ERROR_CODES.TIMEOUT, 504],
    [DICTATION_ERROR_CODES.NETWORK, 502],
    [DICTATION_ERROR_CODES.PROVIDER_ERROR, 502],
    [DICTATION_ERROR_CODES.EMPTY_RESULT, 502],
  ])("maps %s to HTTP %i", async (code, status) => {
    transcribeDictationAudio.mockRejectedValue(
      new DictationError(code, "upstream"),
    );
    const res = await POST(req());
    expect(res.status).toBe(status);
    expect((await res.json()).code).toBe(code);
  });

  it("reports an unexpected adapter throw as a generic 500", async () => {
    transcribeDictationAudio.mockRejectedValue(new Error("AIza-live exploded"));
    const res = await POST(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe(DICTATION_ERROR_CODES.PROVIDER_ERROR);
    expect(JSON.stringify(body)).not.toContain("AIza-live");
  });

  // The client aborting — cancel, panel close, conversation switch — must
  // stop the upstream call instead of letting it run to completion.
  it("propagates a client disconnect to the upstream signal", async () => {
    const controller = new AbortController();
    transcribeDictationAudio.mockImplementation(
      () => new Promise(() => {}), // stays open — the test only checks the signal
    );
    void POST(req({ signal: controller.signal }));
    await vi.waitFor(() =>
      expect(transcribeDictationAudio).toHaveBeenCalled(),
    );
    const upstream = transcribeDictationAudio.mock.calls[0]![0] as {
      signal: AbortSignal;
    };
    expect(upstream.signal.aborted).toBe(false);
    controller.abort();
    expect(upstream.signal.aborted).toBe(true);
  });

  // A request that outlives the hard cap aborts the upstream fetch; an
  // adapter honoring the signal surfaces TIMEOUT (504) to the client.
  it("aborts the upstream call after the timeout budget", async () => {
    vi.useFakeTimers();
    try {
      transcribeDictationAudio.mockImplementation(
        ({ signal }: { signal: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(
                new DictationError(
                  DICTATION_ERROR_CODES.TIMEOUT,
                  "timed out",
                ),
              ),
            );
          }),
      );
      const pending = POST(req());
      await vi.advanceTimersByTimeAsync(
        APP_CONSTANTS.AGENT_DICTATION_TIMEOUT_MS + 1,
      );
      const res = await pending;
      expect(res.status).toBe(504);
      expect((await res.json()).code).toBe(DICTATION_ERROR_CODES.TIMEOUT);
    } finally {
      vi.useRealTimers();
    }
  });
});

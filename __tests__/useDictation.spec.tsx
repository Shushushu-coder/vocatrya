// AWU-DICTATION / D7 state machine: record → upload → draft insert.
// Covers cancel semantics, the single retained retry, the ownership
// (late-result) rule, the recording cap, and resource release. Media and
// transport seams are injected — nothing here touches real devices or the
// network.
import { act, renderHook, waitFor } from "@testing-library/react";
import type { Mock } from "vitest";
import { useDictation } from "@/lib/dictation/useDictation";
import { DictationClientError } from "@/lib/dictation/client";
import { DICTATION_ERROR_CODES } from "@/lib/dictation/config";
import type { MicAcquireResult } from "@/lib/audio/microphone";

interface FakeTrack {
  kind: "audio";
  readyState: "live" | "ended";
  stop: ReturnType<typeof vi.fn>;
  getSettings: () => { deviceId: string };
  onended: (() => void) | null;
}

function makeTrack(): FakeTrack {
  const track: FakeTrack = {
    kind: "audio",
    readyState: "live",
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
    getSettings: () => ({ deviceId: "dev-1" }),
    onended: null,
  };
  return track;
}

function makeStream(track: FakeTrack) {
  return {
    getTracks: () => [track],
    getAudioTracks: () => [track],
  };
}

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported = vi.fn((type: string) => type === "audio/webm");
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  start = vi.fn(() => {
    this.state = "recording";
  });
  stop = vi.fn(() => {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["audio-bytes"], { type: this.mimeType }),
    });
    this.onstop?.();
  });
  constructor(public stream: unknown) {
    FakeMediaRecorder.instances.push(this);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type TranscribeFn = (blob: Blob, signal: AbortSignal) => Promise<string>;

interface Harness {
  transcribe: Mock<TranscribeFn>;
  onTranscript: Mock<(text: string) => void>;
  track: FakeTrack;
  acquireStream: (preferDeviceId?: string | null) => Promise<MicAcquireResult>;
}

function installHarness(overrides: {
  acquire?: MicAcquireResult;
  transcribe?: Mock<TranscribeFn>;
} = {}) {
  const track = makeTrack();
  const acquireStream = vi.fn(
    async (): Promise<MicAcquireResult> =>
      overrides.acquire ?? { ok: true, stream: makeStream(track) as never },
  );
  const transcribe =
    overrides.transcribe ??
    vi.fn<TranscribeFn>(async () => "  transcript text  ");
  const onTranscript = vi.fn<(text: string) => void>();
  return { transcribe, onTranscript, track, acquireStream };
}

function renderDictation(harness: Harness, options: Record<string, unknown> = {}) {
  return renderHook(
    (props: { ownershipKey: string }) =>
      useDictation({
        ownershipKey: props.ownershipKey,
        onTranscript: harness.onTranscript,
        acquireStream: harness.acquireStream,
        transcribe: harness.transcribe,
        ...options,
      }),
    { initialProps: { ownershipKey: "job:conv-1" } },
  );
}

beforeEach(() => {
  localStorage.clear();
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.isTypeSupported.mockClear();
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useDictation — happy path", () => {
  it("records, uploads and delivers the trimmed transcript — nothing else", async () => {
    const harness = installHarness();
    const { result } = renderDictation(harness);

    act(() => result.current.start());
    expect(result.current.phase).toBe("acquiring");
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("idle"));

    // One upload, in-memory clip only, then the draft callback — the hook
    // has no send path at all.
    expect(harness.transcribe).toHaveBeenCalledTimes(1);
    const [blob, signal] = harness.transcribe.mock.calls[0]! as [
      Blob,
      AbortSignal,
    ];
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.size).toBeGreaterThan(0);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(harness.onTranscript).toHaveBeenCalledTimes(1);
    expect(harness.onTranscript).toHaveBeenCalledWith("transcript text");
    expect(harness.track.stop).toHaveBeenCalled();
  });

  it("auto-stops into transcription at the recording cap", async () => {
    const pending = deferred<string>();
    const harness = installHarness({
      transcribe: vi.fn<TranscribeFn>(() => pending.promise),
    });
    const { result } = renderDictation(harness, { maxDurationMs: 150 });
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    // No stop() click — the hard cap ends the take by itself.
    await waitFor(() => expect(result.current.phase).toBe("transcribing"));
    expect(harness.transcribe).toHaveBeenCalledTimes(1);
    await act(async () => {
      pending.resolve(" capped ");
    });
    expect(result.current.phase).toBe("idle");
    expect(harness.onTranscript).toHaveBeenCalledWith("capped");
  });
});

describe("useDictation — cancel", () => {
  it("cancel during recording discards the clip and releases the mic", async () => {
    const harness = installHarness();
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    act(() => result.current.cancel());
    expect(result.current.phase).toBe("idle");
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.onTranscript).not.toHaveBeenCalled();
    expect(harness.track.stop).toHaveBeenCalled();
    const recorder = FakeMediaRecorder.instances[0]!;
    expect(recorder.onstop).toBeNull();
  });

  it("Escape cancels an in-flight recording", async () => {
    const harness = installHarness();
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(result.current.phase).toBe("idle");
    expect(harness.transcribe).not.toHaveBeenCalled();
    expect(harness.track.stop).toHaveBeenCalled();
  });

  it("cancel during upload aborts the fetch and drops a late response", async () => {
    const pending = deferred<string>();
    const harness = installHarness({
      transcribe: vi.fn<TranscribeFn>(() => pending.promise),
    });
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("transcribing"));

    const signal = harness.transcribe.mock.calls[0]![1] as AbortSignal;
    act(() => result.current.cancel());
    expect(signal.aborted).toBe(true);
    expect(result.current.phase).toBe("idle");

    await act(async () => {
      pending.resolve("late text");
    });
    expect(harness.onTranscript).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });
});

describe("useDictation — failures and the single retained retry", () => {
  it("keeps the clip for exactly one retry after an upload failure", async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(
        new DictationClientError(DICTATION_ERROR_CODES.NETWORK, "down"),
      )
      .mockResolvedValueOnce("second try");
    const harness = installHarness({ transcribe });
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("error"));

    expect(result.current.error).toMatchObject({
      kind: "transcribe",
      code: DICTATION_ERROR_CODES.NETWORK,
    });
    expect(result.current.canRetry).toBe(true);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe("idle"));
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(harness.onTranscript).toHaveBeenCalledWith("second try");
  });

  it("a second upload failure is reported without another retry", async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValue(
        new DictationClientError(DICTATION_ERROR_CODES.TIMEOUT, "slow"),
      );
    const harness = installHarness({ transcribe });
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.canRetry).toBe(true);

    act(() => result.current.retry());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.canRetry).toBe(false);
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("dismiss drops the retained clip", async () => {
    const transcribe = vi
      .fn()
      .mockRejectedValue(
        new DictationClientError(DICTATION_ERROR_CODES.NETWORK, "down"),
      );
    const harness = installHarness({ transcribe });
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("error"));

    act(() => result.current.dismiss());
    expect(result.current.phase).toBe("idle");
    act(() => result.current.retry());
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("reports mic permission denial honestly", async () => {
    const harness = installHarness({
      acquire: { ok: false, kind: "denied" },
    });
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toMatchObject({
      kind: "mic",
      micKind: "denied",
    });
    expect(FakeMediaRecorder.instances).toHaveLength(0);
  });

  it("flags a mid-recording unplug as a lost mic and retains nothing", async () => {
    const harness = installHarness();
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    act(() => harness.track.onended?.());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toMatchObject({
      kind: "mic",
      micKind: "lost",
    });
    expect(result.current.canRetry).toBe(false);
    expect(harness.transcribe).not.toHaveBeenCalled();
  });

  it("treats an empty transcript as an error, never inserting it", async () => {
    const harness = installHarness({
      transcribe: vi.fn<TranscribeFn>(async () => "   "),
    });
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("error"));
    expect(result.current.error).toMatchObject({ kind: "empty" });
    expect(harness.onTranscript).not.toHaveBeenCalled();
  });
});

describe("useDictation — ownership and lifecycle", () => {
  it("drops a late response when the ownership key changes mid-upload", async () => {
    const pending = deferred<string>();
    const harness = installHarness({
      transcribe: vi.fn<TranscribeFn>(() => pending.promise),
    });
    const { result, rerender } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.stop());
    await waitFor(() => expect(result.current.phase).toBe("transcribing"));

    // Conversation/role switch: the in-flight upload is cancelled and its
    // eventual result can never reach the new draft.
    rerender({ ownershipKey: "job:conv-2" });
    expect(result.current.phase).toBe("idle");
    await act(async () => {
      pending.resolve("late text");
    });
    expect(harness.onTranscript).not.toHaveBeenCalled();
  });

  it("a new start supersedes the previous recording", async () => {
    const harness = installHarness();
    const { result } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));
    expect(harness.acquireStream).toHaveBeenCalledTimes(2);
    // The first stream was released with the first clip.
    expect(FakeMediaRecorder.instances).toHaveLength(2);
  });

  it("releases the mic, recorder and timers on unmount", async () => {
    const harness = installHarness();
    const { result, unmount } = renderDictation(harness);
    act(() => result.current.start());
    await waitFor(() => expect(result.current.phase).toBe("recording"));

    unmount();
    expect(harness.track.stop).toHaveBeenCalled();
    const recorder = FakeMediaRecorder.instances[0]!;
    expect(recorder.stop).toHaveBeenCalled();
    expect(harness.transcribe).not.toHaveBeenCalled();
  });

  it("stop is a no-op outside the recording phase", async () => {
    const harness = installHarness();
    const { result } = renderDictation(harness);
    act(() => result.current.stop());
    expect(result.current.phase).toBe("idle");
    expect(harness.transcribe).not.toHaveBeenCalled();
  });
});

/**
 * Shared microphone lifecycle primitives — extracted from AudioSettings so
 * the settings recording test and Agent dictation (AWU-DICTATION) run the
 * same permission classification, device persistence, recorder lifecycle and
 * cleanup rules. All of this module is client-side; nothing here is safe to
 * call during SSR (callers guard via event handlers / effects).
 */
import { APP_CONSTANTS } from "@/lib/constants";
import {
  getFromLocalStorage,
  saveToLocalStorage,
} from "@/utils/localstorage.utils";

// One honest state per failure surface; each keeps a retry path so a
// transient failure never strands the caller. `lost` is produced by
// consumers (track.onended), never by classification.
export type MicErrorKind =
  | "denied"
  | "no-device"
  | "busy"
  | "lost"
  | "unsupported"
  | "error";

export type MicAcquireResult =
  | { ok: true; stream: MediaStream }
  | { ok: false; kind: MicErrorKind; detail?: string };

export function micErrorName(err: unknown): string {
  if (err instanceof DOMException) return err.name;
  const named = err as { name?: unknown } | null;
  return typeof named?.name === "string"
    ? named.name
    : err instanceof Error
      ? err.message
      : String(err);
}

export function classifyMicError(err: unknown): MicErrorKind {
  switch (micErrorName(err)) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "no-device";
    case "NotReadableError":
    case "AbortError":
      return "busy";
    default:
      return "error";
  }
}

/** The device the settings page persisted for this machine, if any. */
export function readSavedMicDeviceId(): string | null {
  try {
    const saved: unknown = getFromLocalStorage(
      APP_CONSTANTS.AUDIO_INPUT_DEVICE_STORAGE_KEY,
      null,
    );
    return typeof saved === "string" && saved.length > 0 ? saved : null;
  } catch {
    return null;
  }
}

export function saveMicDeviceId(deviceId: string): void {
  saveToLocalStorage(APP_CONSTANTS.AUDIO_INPUT_DEVICE_STORAGE_KEY, deviceId);
}

/**
 * getUserMedia with the shared error taxonomy folded in. `preferDeviceId`
 * is requested as `ideal` so a vanished device falls back instead of
 * hard-failing — the same behavior the settings page always had.
 */
export async function acquireMicStream(
  preferDeviceId?: string | null,
): Promise<MicAcquireResult> {
  const media = navigator.mediaDevices;
  if (!media?.getUserMedia) {
    return { ok: false, kind: "unsupported" };
  }
  try {
    const stream = await media.getUserMedia({
      audio: preferDeviceId ? { deviceId: { ideal: preferDeviceId } } : true,
    });
    return { ok: true, stream };
  } catch (err) {
    const kind = classifyMicError(err);
    return kind === "error"
      ? { ok: false, kind, detail: micErrorName(err) }
      : { ok: false, kind };
  }
}

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

/**
 * Preferred MediaRecorder containers, most portable first. `audio/mp4`
 * (AAC) is the most portable type the transcription service accepts;
 * Chromium falls through to webm/opus, which Gemini also accepts.
 */
const RECORDING_MIME_CANDIDATES = [
  "audio/mp4",
  "audio/webm;codecs=opus",
  "audio/ogg;codecs=opus",
  "audio/webm",
] as const;

export function pickRecordingMimeType(): string | undefined {
  if (
    typeof MediaRecorder === "undefined" ||
    typeof MediaRecorder.isTypeSupported !== "function"
  ) {
    return undefined;
  }
  return RECORDING_MIME_CANDIDATES.find((candidate) =>
    MediaRecorder.isTypeSupported(candidate),
  );
}

/** File extension matching a recorded mime for upload naming. */
export function recordingExtensionForMime(mimeType: string): string {
  const base = mimeType.split(";")[0]?.trim().toLowerCase() ?? "";
  switch (base) {
    case "audio/mp4":
      return "mp4";
    case "audio/ogg":
      return "ogg";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}

export interface MicClipRecorderOptions {
  /** Preferred container; an unsupported value falls back to the default. */
  mimeType?: string;
  /** Recorder-side error hook (MediaRecorder.onerror). */
  onError?: (detail: string) => void;
}

/**
 * Minimal MediaRecorder lifecycle wrapper shared by the settings recording
 * test and dictation capture. Chunks live in memory only; `stop()` resolves
 * the assembled Blob (or null when nothing was captured) and `cancel()`
 * discards everything without producing a Blob. A recorder that stops on
 * its own — track ended, device unplugged — keeps the chunks it already
 * emitted so a late `stop()` still resolves them.
 */
export class MicClipRecorder {
  static get supported(): boolean {
    return typeof MediaRecorder !== "undefined";
  }

  private readonly recorder: MediaRecorder;
  private chunks: Blob[] = [];
  private stoppedBlob: Blob | null = null;
  private cancelled = false;
  private pendingStop: ((blob: Blob | null) => void) | null = null;

  constructor(stream: MediaStream, options: MicClipRecorderOptions = {}) {
    let recorder: MediaRecorder;
    if (options.mimeType) {
      try {
        recorder = new MediaRecorder(stream, { mimeType: options.mimeType });
      } catch {
        recorder = new MediaRecorder(stream);
      }
    } else {
      recorder = new MediaRecorder(stream);
    }
    this.recorder = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
      }
    };
    recorder.onstop = () => {
      const blob = this.assemble();
      this.pendingStop?.(blob);
      this.pendingStop = null;
    };
    recorder.onerror = () => {
      options.onError?.("MediaRecorder");
      this.pendingStop?.(null);
      this.pendingStop = null;
    };
  }

  get mimeType(): string {
    return this.recorder.mimeType || "audio/webm";
  }

  get recording(): boolean {
    return this.recorder.state !== "inactive";
  }

  private assemble(): Blob | null {
    const chunks = this.chunks;
    this.chunks = [];
    if (chunks.length === 0) return null;
    this.stoppedBlob = new Blob(chunks, { type: this.mimeType });
    return this.stoppedBlob;
  }

  start(): void {
    this.cancelled = false;
    this.stoppedBlob = null;
    this.chunks = [];
    this.recorder.start();
  }

  /** Resolve the captured clip; null when nothing was ever recorded. */
  stop(): Promise<Blob | null> {
    if (this.cancelled) return Promise.resolve(null);
    if (this.recorder.state === "inactive") {
      return Promise.resolve(this.stoppedBlob ?? this.assemble());
    }
    return new Promise((resolve) => {
      this.pendingStop = resolve;
      try {
        this.recorder.stop();
      } catch {
        this.pendingStop = null;
        resolve(this.stoppedBlob);
      }
    });
  }

  /** Drop the clip without producing a Blob; handlers detach before stop. */
  cancel(): void {
    this.cancelled = true;
    this.chunks = [];
    this.stoppedBlob = null;
    this.pendingStop?.(null);
    this.pendingStop = null;
    this.recorder.ondataavailable = null;
    this.recorder.onstop = null;
    this.recorder.onerror = null;
    if (this.recorder.state !== "inactive") {
      try {
        this.recorder.stop();
      } catch {
        // Already stopped.
      }
    }
  }
}

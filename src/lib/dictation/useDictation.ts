/**
 * Dictation state machine (AWU-DICTATION / D7).
 *
 * Click → permission → record (elapsed + hard cap) → stop → upload →
 * transcript text is handed to the mount site's `onTranscript` — the
 * hook never sends a message itself. Rules implemented here:
 *
 * - Audio is memory-only. Cancel discards; a failed upload keeps the clip
 *   for exactly one retry; the clip is released on retry, dismiss or a
 *   new recording.
 * - Escape cancels while acquiring / recording / transcribing.
 * - `ownershipKey` identifies the draft/session the recording belongs to;
 *   a change mid-flight cancels, and only a response that resolves while
 *   its generation is still current may insert (late responses after a
 *   conversation/role switch are dropped, never written elsewhere).
 * - The mic stream, recorder, timers, in-flight fetch and retained blob
 *   are all released on cancel/unmount.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  MicClipRecorder,
  acquireMicStream,
  micErrorName,
  pickRecordingMimeType,
  readSavedMicDeviceId,
  stopMediaStream,
  type MicAcquireResult,
  type MicErrorKind,
} from "@/lib/audio/microphone";
import { APP_CONSTANTS } from "@/lib/constants";
import { DICTATION_ERROR_CODES } from "@/lib/dictation/config";
import {
  DictationClientError,
  isDictationAbort,
  postDictationAudio,
} from "@/lib/dictation/client";

export type DictationPhase =
  | "idle"
  | "acquiring"
  | "recording"
  | "transcribing"
  | "error";

export type DictationFailure =
  | { kind: "mic"; micKind: MicErrorKind; detail?: string }
  | { kind: "record"; detail: string }
  | { kind: "transcribe"; code: string }
  | { kind: "empty" };

export interface UseDictationOptions {
  /**
   * Identity of the draft this dictation belongs to — e.g.
   * `${activeRole}:${conversationId ?? "draft"}`. Changing it mid-flight
   * cancels and drops any late response (D7 late-result rule).
   */
  ownershipKey: string;
  /** Delivers the transcript for insertion into the owned draft. */
  onTranscript: (text: string) => void;
  /** Recording hard cap; auto-stops into transcription when reached. */
  maxDurationMs?: number;
  /** Injectable seams for tests. */
  acquireStream?: (preferDeviceId?: string | null) => Promise<MicAcquireResult>;
  transcribe?: (blob: Blob, signal: AbortSignal) => Promise<string>;
  now?: () => number;
}

export interface UseDictation {
  phase: DictationPhase;
  elapsedMs: number;
  error: DictationFailure | null;
  /** True while the failed clip is still retained for one retry. */
  canRetry: boolean;
  start: () => void;
  stop: () => void;
  cancel: () => void;
  retry: () => void;
  dismiss: () => void;
}

const ELAPSED_TICK_MS = 250;

function transcribeErrorCode(error: unknown): string {
  if (error instanceof DictationClientError) return error.code;
  return DICTATION_ERROR_CODES.PROVIDER_ERROR;
}

export function useDictation(options: UseDictationOptions): UseDictation {
  const {
    ownershipKey,
    onTranscript,
    maxDurationMs = APP_CONSTANTS.AGENT_DICTATION_MAX_DURATION_MS,
    acquireStream = acquireMicStream,
    transcribe = postDictationAudio,
    now = () => Date.now(),
  } = options;

  const [phase, setPhase] = useState<DictationPhase>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<DictationFailure | null>(null);
  const [canRetry, setCanRetry] = useState(false);

  const generationRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const clipRef = useRef<MicClipRecorder | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<Blob | null>(null);
  const capTimerRef = useRef(0);
  const tickTimerRef = useRef(0);
  const startedAtRef = useRef(0);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const clearTimers = useCallback(() => {
    window.clearTimeout(capTimerRef.current);
    capTimerRef.current = 0;
    window.clearInterval(tickTimerRef.current);
    tickTimerRef.current = 0;
  }, []);

  const releaseMic = useCallback(() => {
    const clip = clipRef.current;
    clipRef.current = null;
    if (clip) clip.cancel();
    const stream = streamRef.current;
    streamRef.current = null;
    stopMediaStream(stream);
  }, []);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    clearTimers();
    abortRef.current?.abort();
    abortRef.current = null;
    releaseMic();
    audioRef.current = null;
    setCanRetry(false);
    setElapsedMs(0);
    setError(null);
    setPhase("idle");
  }, [clearTimers, releaseMic]);

  const fail = useCallback(
    (failure: DictationFailure, retainAudio: boolean) => {
      clearTimers();
      abortRef.current = null;
      releaseMic();
      if (!retainAudio) audioRef.current = null;
      setCanRetry(retainAudio && audioRef.current !== null);
      setError(failure);
      setPhase("error");
    },
    [clearTimers, releaseMic],
  );

  const uploadClip = useCallback(
    async (generation: number, blob: Blob) => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const text = await transcribe(blob, controller.signal);
        if (generation !== generationRef.current) return;
        abortRef.current = null;
        audioRef.current = null;
        setCanRetry(false);
        const trimmed = text.trim();
        if (!trimmed) {
          fail({ kind: "empty" }, false);
          return;
        }
        setElapsedMs(0);
        setPhase("idle");
        onTranscriptRef.current(trimmed);
      } catch (err) {
        if (generation !== generationRef.current) return;
        abortRef.current = null;
        if (isDictationAbort(err)) {
          // Cancel raced the response — the cancel path already reset.
          setPhase("idle");
          return;
        }
        fail(
          { kind: "transcribe", code: transcribeErrorCode(err) },
          audioRef.current !== null,
        );
      }
    },
    [fail, transcribe],
  );

  const finishRecording = useCallback(
    async (generation: number) => {
      const clip = clipRef.current;
      clipRef.current = null;
      // Idempotent: a second call (cap timer racing a stop click) is a
      // no-op — the in-flight upload keeps owning the generation.
      if (!clip) return;
      if (generation !== generationRef.current) return;
      setPhase("transcribing");
      const stream = streamRef.current;
      streamRef.current = null;
      const blob = clip ? await clip.stop() : null;
      stopMediaStream(stream);
      if (generation !== generationRef.current) return;
      if (!blob || blob.size === 0) {
        fail({ kind: "record", detail: "empty" }, false);
        return;
      }
      audioRef.current = blob;
      await uploadClip(generation, blob);
    },
    [fail, uploadClip],
  );

  const start = useCallback(() => {
    const generation = ++generationRef.current;
    clearTimers();
    abortRef.current?.abort();
    abortRef.current = null;
    releaseMic();
    audioRef.current = null;
    setCanRetry(false);
    setError(null);
    setElapsedMs(0);
    setPhase("acquiring");
    void (async () => {
      const result = await acquireStream(readSavedMicDeviceId());
      if (generation !== generationRef.current) {
        if (result.ok) stopMediaStream(result.stream);
        return;
      }
      if (!result.ok) {
        fail(
          result.kind === "error"
            ? { kind: "mic", micKind: "error", detail: result.detail }
            : { kind: "mic", micKind: result.kind },
          false,
        );
        return;
      }
      const stream = result.stream;
      streamRef.current = stream;
      const track = stream.getAudioTracks()[0];
      if (track) {
        track.onended = () => {
          if (generation !== generationRef.current) return;
          fail({ kind: "mic", micKind: "lost" }, false);
        };
      }
      if (!MicClipRecorder.supported) {
        releaseMic();
        fail({ kind: "record", detail: "unsupported" }, false);
        return;
      }
      let clip: MicClipRecorder;
      try {
        clip = new MicClipRecorder(stream, {
          mimeType: pickRecordingMimeType(),
          onError: (detail) => {
            if (generation !== generationRef.current) return;
            fail({ kind: "record", detail }, false);
          },
        });
        clip.start();
      } catch (err) {
        releaseMic();
        fail({ kind: "record", detail: micErrorName(err) }, false);
        return;
      }
      clipRef.current = clip;
      startedAtRef.current = now();
      setPhase("recording");
      tickTimerRef.current = window.setInterval(() => {
        setElapsedMs(Math.max(0, now() - startedAtRef.current));
      }, ELAPSED_TICK_MS);
      capTimerRef.current = window.setTimeout(() => {
        void finishRecording(generation);
      }, maxDurationMs);
    })();
  }, [
    acquireStream,
    clearTimers,
    fail,
    finishRecording,
    maxDurationMs,
    now,
    releaseMic,
  ]);

  const stop = useCallback(() => {
    if (phase !== "recording") return;
    clearTimers();
    void finishRecording(generationRef.current);
  }, [clearTimers, finishRecording, phase]);

  const retry = useCallback(() => {
    if (phase !== "error") return;
    const blob = audioRef.current;
    if (!blob) return;
    // The retained copy is released when the retry is initiated (D7): a
    // second failure is reported without a further retry offer.
    audioRef.current = null;
    setCanRetry(false);
    setError(null);
    setPhase("transcribing");
    void uploadClip(generationRef.current, blob);
  }, [phase, uploadClip]);

  const dismiss = useCallback(() => {
    if (phase !== "error") return;
    audioRef.current = null;
    setCanRetry(false);
    setError(null);
    setPhase("idle");
  }, [phase]);

  // Escape cancels an in-flight dictation. Bound only while active so the
  // composer keeps its own Esc semantics at other times.
  useEffect(() => {
    if (phase === "idle" || phase === "error") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [phase, cancel]);

  // Ownership switch (conversation/role/composer remount) cancels and drops
  // late results; unmount releases every held resource the same way.
  useEffect(() => {
    return () => {
      cancel();
    };
  }, [ownershipKey, cancel]);

  return {
    phase,
    elapsedMs,
    error,
    canRetry,
    start,
    stop,
    cancel,
    retry,
    dismiss,
  };
}

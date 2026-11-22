/**
 * Dictation provider adapters (AWU-DICTATION) — record-then-upload file
 * transcription only, no realtime/streaming surface in v1.
 *
 * Provider-facing error details never reach the response: adapters throw
 * DictationError with a stable wire code and a fixed English message safe
 * to echo. Raw provider bodies stay server-side (they can echo request
 * context). `fetchImpl` is injectable for tests.
 */
import "server-only";

import {
  DICTATION_ERROR_CODES,
  dictationProtocol,
  type DictationErrorCode,
  type DictationProvider,
} from "@/lib/dictation/config";
import { dictationFetch } from "@/lib/dictation/transport.server";

export class DictationError extends Error {
  readonly code: DictationErrorCode;
  /** Optional upstream status — logged, never part of the wire message. */
  readonly upstreamStatus?: number;

  constructor(code: DictationErrorCode, message: string, upstreamStatus?: number) {
    super(message);
    this.name = "DictationError";
    this.code = code;
    this.upstreamStatus = upstreamStatus;
  }
}

export interface DictationAudio {
  bytes: Buffer;
  mimeType: string;
  fileName: string;
}

export interface TranscribeOptions {
  provider: DictationProvider;
  model: string;
  apiKey: string;
  audio: DictationAudio;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

const GEMINI_GENERATE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

// Dictation prompt for the chat-style Gemini path: verbatim transcription,
// original language kept, no commentary.
const GEMINI_TRANSCRIBE_PROMPT =
  "Transcribe the audio verbatim. Preserve the original language(s) and " +
  "terminology. Output only the transcription text, with no commentary, " +
  "labels, or quotation marks.";

function upstreamError(err: unknown, signal?: AbortSignal): DictationError {
  if (signal?.aborted) {
    const cancelled = signal.reason instanceof Error && signal.reason.message === DICTATION_ERROR_CODES.CANCELLED;
    return new DictationError(cancelled ? DICTATION_ERROR_CODES.CANCELLED : DICTATION_ERROR_CODES.TIMEOUT,
      cancelled ? "Transcription was cancelled" : "The transcription request timed out");
  }
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || name === "TimeoutError" || /abort/i.test(message)) {
    return new DictationError(DICTATION_ERROR_CODES.TIMEOUT, "The transcription request timed out or was cancelled");
  }
  return new DictationError(DICTATION_ERROR_CODES.NETWORK, "Cannot reach the transcription service");
}

async function httpError(res: Response, signal?: AbortSignal): Promise<DictationError> {
  // Inspect only structured codes. Never echo upstream text or key material.
  try {
    // Interactions can wrap an error in an array; generateContent returns
    // a single object. Classify both through the same path.
    const parsed = await res.json();
    const body = Array.isArray(parsed) ? parsed[0] : parsed;
    if (res.status === 504 && body?.code === DICTATION_ERROR_CODES.TIMEOUT) return mapHttpStatus(504);
    if (res.status === 502 && body?.code === DICTATION_ERROR_CODES.NETWORK) {
      return new DictationError(DICTATION_ERROR_CODES.NETWORK, "Cannot reach the transcription service", 502);
    }
    const error = body?.error;
    const reasons = Array.isArray(error?.details) ? error.details.map((detail: { reason?: string }) => detail?.reason) : [];
    if (reasons.includes("API_KEY_INVALID") || ["invalid_api_key", "authentication_error"].includes(error?.code)) {
      return mapHttpStatus(401, res.status);
    }
    if (["model_not_found", "model_not_available"].includes(error?.code)) return mapHttpStatus(404, res.status);
  } catch (err) {
    if (signal?.aborted) throw upstreamError(err, signal);
    // A non-JSON error still has a usable HTTP status.
  }
  return mapHttpStatus(res.status);
}

function mapHttpStatus(status: number, upstreamStatus = status): DictationError {
  switch (status) {
    case 400:
      return new DictationError(DICTATION_ERROR_CODES.INVALID_AUDIO, "The transcription service rejected the audio", upstreamStatus);
    case 401:
    case 403:
      return new DictationError(DICTATION_ERROR_CODES.AUTH_FAILED, "The transcription service rejected the configured API key", upstreamStatus);
    case 404:
      return new DictationError(DICTATION_ERROR_CODES.MODEL_UNAVAILABLE, "The configured transcription model is not available", upstreamStatus);
    case 413:
      return new DictationError(DICTATION_ERROR_CODES.AUDIO_TOO_LARGE, "The audio is too large for the transcription service", upstreamStatus);
    case 429:
      return new DictationError(DICTATION_ERROR_CODES.RATE_LIMITED, "The transcription service is rate limiting the key", upstreamStatus);
    case 408:
    case 504:
      return new DictationError(DICTATION_ERROR_CODES.TIMEOUT, "The transcription request timed out", upstreamStatus);
    default:
      return new DictationError(
        DICTATION_ERROR_CODES.PROVIDER_ERROR,
        "The transcription service returned an error",
        upstreamStatus,
      );
  }
}

async function transcribeWithGemini(
  opts: TranscribeOptions,
  doFetch: typeof fetch,
): Promise<string> {
  const model = opts.model.replace(/^models\//, "");
  const interactions = dictationProtocol(model) === "gemini-interactions";
  const mimeType = opts.audio.mimeType.split(";")[0].trim().toLowerCase();
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: mimeType,
              data: opts.audio.bytes.toString("base64"),
            },
          },
          { text: GEMINI_TRANSCRIBE_PROMPT },
        ],
      },
    ],
    generationConfig: { temperature: 0 },
  };
  let res: Response;
  try {
    res = await doFetch(
      interactions ? "https://generativelanguage.googleapis.com/v1beta/interactions" : `${GEMINI_GENERATE_URL}/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header auth keeps the key out of URLs (logs/history surfaces).
          "x-goog-api-key": opts.apiKey,
        },
        body: JSON.stringify(interactions ? {
          model,
          input: [{ type: "audio", mime_type: mimeType, data: opts.audio.bytes.toString("base64") }],
          generation_config: { transcription_config: { mode: { type: "verbatim" } } },
          store: false,
        } : body),
        redirect: "error",
        signal: opts.signal ?? null,
      },
    );
  } catch (err) {
    throw upstreamError(err, opts.signal);
  }
  if (!res.ok) {
    throw await httpError(res, opts.signal);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch (err) {
    if (opts.signal?.aborted) throw upstreamError(err, opts.signal);
    throw new DictationError(DICTATION_ERROR_CODES.PROVIDER_ERROR, "The transcription service returned an unreadable response");
  }
  if (interactions) {
    const result = parsed as { status?: string; output_text?: unknown; steps?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
    if (result?.status !== "completed") {
      throw new DictationError(DICTATION_ERROR_CODES.PROVIDER_ERROR, "The transcription did not complete");
    }
    const text = typeof result.output_text === "string" ? result.output_text :
      (result.steps ?? []).flatMap(step => step.content ?? []).filter(part => part.type === "text").map(part => part.text ?? "").join(" ");
    if (!text.trim()) throw new DictationError(DICTATION_ERROR_CODES.EMPTY_RESULT, "The transcription service returned no text");
    return text;
  }
  const parts = (
    parsed as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: unknown }> };
      }>;
    }
  )?.candidates?.[0]?.content?.parts;
  const text = Array.isArray(parts)
    ? parts
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("")
        .trim()
    : "";
  if (!text) {
    throw new DictationError(DICTATION_ERROR_CODES.EMPTY_RESULT, "The transcription service returned no text");
  }
  return text;
}

/** Single entry point — provider dispatch per the resolved dictation config. */
export async function transcribeDictationAudio(
  opts: TranscribeOptions,
): Promise<string> {
  const doFetch = opts.fetchImpl ?? dictationFetch;
  switch (opts.provider) {
    case "gemini":
      return transcribeWithGemini(opts, doFetch);
    default:
      throw new DictationError(
        DICTATION_ERROR_CODES.NOT_CONFIGURED,
        "The configured dictation provider is not supported",
      );
  }
}

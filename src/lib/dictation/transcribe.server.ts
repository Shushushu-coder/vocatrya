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
  type DictationErrorCode,
  type DictationProvider,
} from "@/lib/dictation/config";

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

const OPENAI_TRANSCRIBE_URL =
  "https://api.openai.com/v1/audio/transcriptions";
const GEMINI_GENERATE_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";

// Dictation prompt for the chat-style Gemini path: verbatim transcription,
// original language kept, no commentary. OpenAI's dedicated endpoint needs
// no instruction text.
const GEMINI_TRANSCRIBE_PROMPT =
  "Transcribe the audio verbatim. Preserve the original language(s) and " +
  "terminology. Output only the transcription text, with no commentary, " +
  "labels, or quotation marks.";

function upstreamError(err: unknown): DictationError {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "AbortError" || name === "TimeoutError" || /abort/i.test(message)) {
    return new DictationError(DICTATION_ERROR_CODES.TIMEOUT, "The transcription request timed out or was cancelled");
  }
  return new DictationError(DICTATION_ERROR_CODES.NETWORK, "Cannot reach the transcription service");
}

async function readBodySnippet(res: Response): Promise<void> {
  // Drain briefly so the socket is freed; the body itself is deliberately
  // not surfaced anywhere (it may echo request context).
  try {
    await res.text();
  } catch {
    // Best effort only.
  }
}

function mapHttpStatus(status: number): DictationError {
  switch (status) {
    case 400:
      return new DictationError(DICTATION_ERROR_CODES.INVALID_AUDIO, "The transcription service rejected the audio", status);
    case 401:
    case 403:
      return new DictationError(DICTATION_ERROR_CODES.AUTH_FAILED, "The transcription service rejected the configured API key", status);
    case 404:
      return new DictationError(DICTATION_ERROR_CODES.MODEL_UNAVAILABLE, "The configured transcription model is not available", status);
    case 413:
      return new DictationError(DICTATION_ERROR_CODES.AUDIO_TOO_LARGE, "The audio is too large for the transcription service", status);
    case 429:
      return new DictationError(DICTATION_ERROR_CODES.RATE_LIMITED, "The transcription service is rate limiting the key", status);
    default:
      return new DictationError(
        status >= 500 ? DICTATION_ERROR_CODES.PROVIDER_ERROR : DICTATION_ERROR_CODES.PROVIDER_ERROR,
        "The transcription service returned an error",
        status,
      );
  }
}

async function transcribeWithOpenAi(
  opts: TranscribeOptions,
  doFetch: typeof fetch,
): Promise<string> {
  const form = new FormData();
  form.append("model", opts.model);
  form.append(
    "file",
    new Blob([new Uint8Array(opts.audio.bytes)], { type: opts.audio.mimeType }),
    opts.audio.fileName,
  );
  let res: Response;
  try {
    res = await doFetch(OPENAI_TRANSCRIBE_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.apiKey}` },
      body: form,
      signal: opts.signal ?? null,
    });
  } catch (err) {
    throw upstreamError(err);
  }
  if (!res.ok) {
    await readBodySnippet(res);
    throw mapHttpStatus(res.status);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new DictationError(DICTATION_ERROR_CODES.PROVIDER_ERROR, "The transcription service returned an unreadable response");
  }
  const text = (parsed as { text?: unknown })?.text;
  if (typeof text !== "string") {
    throw new DictationError(DICTATION_ERROR_CODES.PROVIDER_ERROR, "The transcription service returned no text");
  }
  return text;
}

async function transcribeWithGemini(
  opts: TranscribeOptions,
  doFetch: typeof fetch,
): Promise<string> {
  const body = {
    contents: [
      {
        role: "user",
        parts: [
          {
            inline_data: {
              mime_type: opts.audio.mimeType,
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
      `${GEMINI_GENERATE_URL}/${encodeURIComponent(opts.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // Header auth keeps the key out of URLs (logs/history surfaces).
          "x-goog-api-key": opts.apiKey,
        },
        body: JSON.stringify(body),
        signal: opts.signal ?? null,
      },
    );
  } catch (err) {
    throw upstreamError(err);
  }
  if (!res.ok) {
    await readBodySnippet(res);
    // Gemini reports an invalid key as 400 with reason API_KEY_INVALID.
    throw mapHttpStatus(res.status);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new DictationError(DICTATION_ERROR_CODES.PROVIDER_ERROR, "The transcription service returned an unreadable response");
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
  const doFetch = opts.fetchImpl ?? fetch;
  switch (opts.provider) {
    case "openai":
      return transcribeWithOpenAi(opts, doFetch);
    case "gemini":
      return transcribeWithGemini(opts, doFetch);
    default:
      throw new DictationError(
        DICTATION_ERROR_CODES.NOT_CONFIGURED,
        "The configured dictation provider is not supported",
      );
  }
}

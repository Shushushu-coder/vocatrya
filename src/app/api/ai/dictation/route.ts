import "server-only";

import { auth } from "@/auth";
import { NextRequest, NextResponse } from "next/server";
import { APP_CONSTANTS } from "@/lib/constants";
import {
  DICTATION_ERROR_CODES,
  type DictationErrorCode,
} from "@/lib/dictation/config";
import { resolveDictationConfig } from "@/lib/dictation/settings.server";
import {
  DictationError,
  transcribeDictationAudio,
} from "@/lib/dictation/transcribe.server";
import { log } from "@/lib/telemetry";

// The multipart body is a single recorded clip produced under
// AGENT_DICTATION_MAX_DURATION_MS — well under the provider request cap.
const MAX_AUDIO_BYTES = APP_CONSTANTS.AGENT_DICTATION_MAX_AUDIO_BYTES;
// Slightly above the audio cap for multipart overhead; rejects oversized
// uploads before the body is even parsed.
const MAX_CONTENT_LENGTH = MAX_AUDIO_BYTES + 64 * 1024;

const STATUS_BY_CODE: Partial<Record<DictationErrorCode, number>> = {
  [DICTATION_ERROR_CODES.NOT_CONFIGURED]: 400,
  [DICTATION_ERROR_CODES.CREDENTIAL_UNAVAILABLE]: 400,
  [DICTATION_ERROR_CODES.INVALID_AUDIO]: 400,
  [DICTATION_ERROR_CODES.AUDIO_TOO_LARGE]: 413,
  [DICTATION_ERROR_CODES.AUTH_FAILED]: 502,
  [DICTATION_ERROR_CODES.MODEL_UNAVAILABLE]: 502,
  [DICTATION_ERROR_CODES.RATE_LIMITED]: 429,
  [DICTATION_ERROR_CODES.TIMEOUT]: 504,
  [DICTATION_ERROR_CODES.CANCELLED]: 499,
  [DICTATION_ERROR_CODES.NETWORK]: 502,
  [DICTATION_ERROR_CODES.PROVIDER_ERROR]: 502,
  [DICTATION_ERROR_CODES.EMPTY_RESULT]: 502,
};

function failure(error: unknown) {
  if (error instanceof DictationError) {
    if (error.code !== DICTATION_ERROR_CODES.CANCELLED) {
      log.error("[dictation] transcribe failed", {
        code: error.code,
        upstreamStatus: error.upstreamStatus,
      });
    }
    return NextResponse.json(
      { success: false, code: error.code, error: error.message },
      { status: STATUS_BY_CODE[error.code] ?? 500 },
    );
  }
  log.error("[dictation] unexpected failure", {
    error: String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  return NextResponse.json(
    {
      success: false,
      code: DICTATION_ERROR_CODES.PROVIDER_ERROR,
      error: "The transcription request failed",
    },
    { status: 500 },
  );
}

/**
 * Link the provider fetch to the client connection and a hard timeout:
 * the user pressing cancel (or closing the panel) aborts the upstream
 * call instead of letting it run to completion.
 */
function linkedSignal(req: NextRequest): {
  signal: AbortSignal;
  release: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error("DICTATION_TIMEOUT"));
  }, APP_CONSTANTS.AGENT_DICTATION_TIMEOUT_MS);
  const onClientAbort = () => {
    controller.abort(new Error("DICTATION_CANCELLED"));
  };
  if (req.signal.aborted) {
    onClientAbort();
  } else {
    req.signal.addEventListener("abort", onClientAbort, { once: true });
  }
  return {
    signal: controller.signal,
    release: () => {
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onClientAbort);
    },
  };
}

// Duck-typed rather than instanceof File: undici's File class differs from
// the global one across runtimes, and either shape carries the upload.
function isAudioPart(value: FormDataEntryValue | null): value is File {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as File).arrayBuffer === "function" &&
    typeof (value as File).size === "number" &&
    (value as File).size > 0
  );
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json(
      { success: false, error: "Not authenticated" },
      { status: 401 },
    );
  }

  const contentLength = Number(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_CONTENT_LENGTH) {
    return NextResponse.json(
      {
        success: false,
        code: DICTATION_ERROR_CODES.AUDIO_TOO_LARGE,
        error: "The audio is too large",
      },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { success: false, error: "Audio file is required" },
      { status: 400 },
    );
  }
  const audio = form.get("audio");
  if (!isAudioPart(audio)) {
    return NextResponse.json(
      { success: false, error: "Audio file is required" },
      { status: 400 },
    );
  }
  if (audio.size > MAX_AUDIO_BYTES) {
    return NextResponse.json(
      {
        success: false,
        code: DICTATION_ERROR_CODES.AUDIO_TOO_LARGE,
        error: "The audio is too large",
      },
      { status: 413 },
    );
  }
  const mimeType = audio.type || "application/octet-stream";
  if (!/^audio\//i.test(mimeType) && mimeType !== "application/ogg") {
    return NextResponse.json(
      {
        success: false,
        code: DICTATION_ERROR_CODES.INVALID_AUDIO,
        error: "Only audio recordings are accepted",
      },
      { status: 400 },
    );
  }

  const { signal, release } = linkedSignal(req);
  try {
    const config = await resolveDictationConfig(session.user.id);
    const text = await transcribeDictationAudio({
      provider: config.settings.provider,
      model: config.settings.model,
      apiKey: config.apiKey,
      audio: {
        bytes: Buffer.from(await audio.arrayBuffer()),
        mimeType,
        fileName: audio.name || "audio.webm",
      },
      signal,
    });
    return NextResponse.json({ success: true, text });
  } catch (error) {
    return failure(error);
  } finally {
    release();
  }
}

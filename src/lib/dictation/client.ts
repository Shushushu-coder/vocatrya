/**
 * Dictation client transport — posts the in-memory clip to the app's
 * transcription route and maps the wire envelope to text or a stable code.
 */
import {
  DICTATION_ERROR_CODES,
  type DictationErrorCode,
} from "@/lib/dictation/config";
import { recordingExtensionForMime } from "@/lib/audio/microphone";

export class DictationClientError extends Error {
  readonly code: DictationErrorCode | "HTTP" | "BAD_RESPONSE";

  constructor(code: DictationClientError["code"], message: string) {
    super(message);
    this.name = "DictationClientError";
    this.code = code;
  }
}

export function isDictationAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || /abort/i.test(error.message))
  );
}

export async function postDictationAudio(
  blob: Blob,
  signal: AbortSignal,
): Promise<string> {
  const extension = recordingExtensionForMime(blob.type || "audio/webm");
  const file = new File([blob], `dictation.${extension}`, {
    type: blob.type || "audio/webm",
  });
  const form = new FormData();
  form.append("audio", file);

  let res: Response;
  try {
    res = await fetch("/api/ai/dictation", {
      method: "POST",
      body: form,
      signal,
    });
  } catch (err) {
    if (isDictationAbort(err)) throw err;
    throw new DictationClientError(
      DICTATION_ERROR_CODES.NETWORK,
      "Cannot reach the transcription service",
    );
  }

  let data: { success?: boolean; text?: unknown; code?: string; error?: string };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new DictationClientError(
      "BAD_RESPONSE",
      "The transcription response could not be read",
    );
  }
  if (data.success === true && typeof data.text === "string") {
    return data.text;
  }
  throw new DictationClientError(
    (data.code as DictationClientError["code"]) ?? "HTTP",
    typeof data.error === "string"
      ? data.error
      : "The transcription request failed",
  );
}

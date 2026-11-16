/**
 * Dictation client transport — posts the in-memory clip to the app's
 * transcription route and maps the wire envelope to text or a stable code.
 */
import {
  DICTATION_ERROR_CODES,
} from "@/lib/dictation/config";
import { recordingExtensionForMime } from "@/lib/audio/microphone";
import { prepareDictationAudio } from "./prepareAudio";

import { DictationClientError } from "./errors";
export { DictationClientError } from "./errors";

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
  blob = await prepareDictationAudio(blob);
  signal.throwIfAborted();
  const extension = recordingExtensionForMime(blob.type || "audio/webm");
  const file = new File([blob], `dictation.${extension}`, {
    type: blob.type || "audio/webm",
  });
  const form = new FormData();
  form.append("audio", file);
  const deadline = AbortSignal.timeout(75_000);
  const requestSignal = AbortSignal.any([signal, deadline]);

  let res: Response;
  try {
    res = await fetch("/api/ai/dictation", {
      method: "POST",
      body: form,
      signal: requestSignal,
    });
  } catch (err) {
    if (deadline.aborted && !signal.aborted) {
      throw new DictationClientError(DICTATION_ERROR_CODES.TIMEOUT, "The transcription request timed out");
    }
    if (isDictationAbort(err)) throw err;
    throw new DictationClientError(
      DICTATION_ERROR_CODES.NETWORK,
      "Cannot reach the transcription service",
    );
  }

  let data: { success?: boolean; text?: unknown; code?: string; error?: string };
  try {
    data = (await res.json()) as typeof data;
  } catch (err) {
    if (signal.aborted) throw err;
    if (deadline.aborted) throw new DictationClientError(DICTATION_ERROR_CODES.TIMEOUT, "The transcription request timed out");
    throw new DictationClientError(
      "BAD_RESPONSE",
      "The transcription response could not be read",
    );
  }
  if (res.ok && data?.success === true && typeof data.text === "string") {
    return data.text;
  }
  throw new DictationClientError(
    (data?.code as DictationClientError["code"]) ?? "HTTP",
    typeof data?.error === "string"
      ? data.error
      : "The transcription request failed",
  );
}

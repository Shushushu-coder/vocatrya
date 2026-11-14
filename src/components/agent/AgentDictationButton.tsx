"use client";

import { Loader2, Mic, Square, X } from "lucide-react";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { useI18n } from "@/i18n";
import {
  useDictation,
  type DictationFailure,
} from "@/lib/dictation/useDictation";
import { cn } from "@/lib/utils";

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Failure → i18n key. Mic surfaces reuse the AudioSettings taxonomy so a
// denied permission reads the same everywhere; upload failures map the
// wire code, never the raw provider message.
export function dictationErrorKey(error: DictationFailure): string {
  switch (error.kind) {
    case "mic":
      switch (error.micKind) {
        case "denied":
          return "dictation.micDenied";
        case "no-device":
          return "dictation.micNoDevice";
        case "busy":
          return "dictation.micBusy";
        case "lost":
          return "dictation.micLost";
        case "unsupported":
          return "dictation.micUnsupported";
        default:
          return "dictation.micError";
      }
    case "record":
      return error.detail === "unsupported"
        ? "dictation.recordUnsupported"
        : "dictation.recordError";
    case "empty":
      return "dictation.emptyResult";
    case "transcribe":
      switch (error.code) {
        case "DICTATION_NOT_CONFIGURED":
          return "dictation.errNotConfigured";
        case "DICTATION_CREDENTIAL_UNAVAILABLE":
          return "dictation.errCredentialUnavailable";
        case "DICTATION_AUTH_FAILED":
          return "dictation.errAuthFailed";
        case "DICTATION_RATE_LIMITED":
          return "dictation.errRateLimited";
        case "DICTATION_TIMEOUT":
        case "DICTATION_CANCELLED":
          return "dictation.errTimeout";
        case "DICTATION_AUDIO_TOO_LARGE":
          return "dictation.errAudioTooLarge";
        case "DICTATION_INVALID_AUDIO":
          return "dictation.errInvalidAudio";
        case "DICTATION_MODEL_UNAVAILABLE":
          return "dictation.errModelUnavailable";
        case "DICTATION_NETWORK":
          return "dictation.errNetwork";
        default:
          return "dictation.errProvider";
      }
  }
}

/**
 * Composer toolbar dictation control (AWU-DICTATION / D7). Click to record,
 * stop uploads the clip, the transcript goes to `insertText` — the mount
 * site (AgentChatInput toolbar) owns draft insertion, this component owns
 * the recording/cancel/upload lifecycle. Nothing is sent automatically.
 *
 * @param insertText  Mount-site callback that inserts the transcript into
 *                    the owned draft (cursor or append — see handoff).
 * @param ownershipKey  `${activeRole}:${conversationId ?? "draft"}` (add
 *                    `:composerNonce` if a remount should also cancel).
 * @param disabled    External gate (e.g. composer unavailable); recording
 *                    during generation is allowed — nothing auto-sends.
 */
export function AgentDictationButton({
  insertText,
  ownershipKey,
  disabled = false,
  compact = false,
}: {
  insertText: (text: string) => void;
  ownershipKey: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const dictation = useDictation({ ownershipKey, onTranscript: insertText });
  const { phase, elapsedMs, error, canRetry } = dictation;

  if (phase === "recording") {
    return (
      <span
        className="inline-flex items-center gap-1"
        data-testid="agent-dictation-active"
      >
        <span
          className="inline-flex items-center gap-1.5 text-xs text-destructive"
          role="status"
          aria-live="polite"
          data-testid="agent-dictation-timer"
        >
          <span className="size-2 animate-pulse rounded-full bg-destructive" />
          {formatElapsed(elapsedMs)}
        </span>
        <PromptInputButton
          aria-label={t("dictation.stop")}
          data-testid="agent-dictation-stop"
          onClick={dictation.stop}
        >
          <Square className="size-3.5" />
          {!compact ? <span className="text-xs">{t("dictation.stop")}</span> : null}
        </PromptInputButton>
        <PromptInputButton
          aria-label={t("dictation.cancel")}
          data-testid="agent-dictation-cancel"
          onClick={dictation.cancel}
        >
          <X className="size-3.5" />
          {!compact ? <span className="text-xs">{t("dictation.cancel")}</span> : null}
        </PromptInputButton>
      </span>
    );
  }

  if (phase === "acquiring" || phase === "transcribing") {
    return (
      <span
        className="inline-flex items-center gap-1"
        data-testid="agent-dictation-busy"
      >
        <span
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          role="status"
          aria-live="polite"
        >
          <Loader2 className="size-3 animate-spin" />
          {phase === "acquiring"
            ? t("dictation.requestingMic")
            : t("dictation.transcribing")}
        </span>
        <PromptInputButton
          aria-label={t("dictation.cancel")}
          data-testid="agent-dictation-cancel"
          onClick={dictation.cancel}
        >
          <X className="size-3.5" />
        </PromptInputButton>
      </span>
    );
  }

  if (phase === "error" && error) {
    return (
      <span
        className="inline-flex items-center gap-1"
        data-testid="agent-dictation-error"
      >
        <span
          className={cn("max-w-44 truncate text-xs text-destructive")}
          role="alert"
          title={t(dictationErrorKey(error))}
        >
          {t(dictationErrorKey(error))}
        </span>
        {canRetry ? (
          <PromptInputButton
            aria-label={t("dictation.retry")}
            data-testid="agent-dictation-retry"
            onClick={dictation.retry}
          >
            <span className="text-xs">{t("dictation.retry")}</span>
          </PromptInputButton>
        ) : null}
        <PromptInputButton
          aria-label={t("dictation.dismiss")}
          data-testid="agent-dictation-dismiss"
          onClick={dictation.dismiss}
        >
          <X className="size-3.5" />
        </PromptInputButton>
      </span>
    );
  }

  return (
    <PromptInputButton
      aria-label={t("dictation.start")}
      data-testid="agent-dictation-start"
      disabled={disabled}
      onClick={dictation.start}
    >
      <Mic className="size-3.5" />
    </PromptInputButton>
  );
}

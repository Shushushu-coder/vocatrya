"use client";

import { CheckIcon, CopyIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClipboardCopy } from "@/components/agent/useClipboardCopy";
import { useI18n } from "@/i18n";

// Action row for one assistant answer. Copy takes the text it was given at
// click time — during streaming that is the visible snapshot, which is the
// honest reading of "copy the answer's visible body". onRegenerate is only
// passed for the last answer of a settled conversation; the owner decides
// eligibility so a mid-history or write-bearing answer gets copy alone.
export function AgentAnswerActions({
  text,
  onRegenerate,
}: {
  text: string;
  onRegenerate?: () => void;
}) {
  const { t } = useI18n();
  const { copied, copy } = useClipboardCopy(t("agentAnswer.copyFailed"));

  const label = copied ? t("agentAnswer.copied") : t("agentAnswer.copy");
  const regenerateLabel = t("agentAnswer.regenerate");
  return (
    <div className="flex items-center gap-1">
      <Button
        aria-label={label}
        className="size-6 shrink-0"
        onClick={() => void copy(text)}
        size="icon"
        title={label}
        type="button"
        variant="ghost"
      >
        {copied ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </Button>
      {onRegenerate ? (
        <Button
          aria-label={regenerateLabel}
          className="size-6 shrink-0"
          onClick={onRegenerate}
          size="icon"
          title={regenerateLabel}
          type="button"
          variant="ghost"
        >
          <RotateCcwIcon className="size-3.5" />
        </Button>
      ) : null}
    </div>
  );
}

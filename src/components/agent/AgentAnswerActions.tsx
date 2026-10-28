"use client";

import { useEffect, useRef, useState } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";

// Action row for one assistant answer. Copy takes the text it was given at
// click time — during streaming that is the visible snapshot, which is the
// honest reading of "copy the answer's visible body".
export function AgentAnswerActions({ text }: { text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetRef.current) clearTimeout(resetRef.current);
      resetRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      // Failure feedback must be real: no check mark for a write that did
      // not happen, and the button stays armed so a denied clipboard is
      // retryable.
      setCopied(false);
      toastError(t("agentAnswer.copyFailed"));
    }
  };

  const label = copied ? t("agentAnswer.copied") : t("agentAnswer.copy");
  return (
    <div className="flex items-center gap-1">
      <Button
        aria-label={label}
        className="size-6 shrink-0"
        onClick={() => void copy()}
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
    </div>
  );
}

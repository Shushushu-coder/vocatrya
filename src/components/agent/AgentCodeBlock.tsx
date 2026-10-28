"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useClipboardCopy } from "@/components/agent/useClipboardCopy";
import { useI18n } from "@/i18n";

// One fenced code block from an assistant answer, rendered outside the
// shared rich-text viewer so it can own a copy action without touching the
// viewer's other consumers. `code` is the fence body markdown-it produced
// for the text on screen — during streaming it grows chunk by chunk, and a
// click copies exactly the body visible at that moment.
export function AgentCodeBlock({
  code,
  language,
}: {
  code: string;
  language: string;
}) {
  const { t } = useI18n();
  const { copied, copy } = useClipboardCopy(t("agentCodeBlock.copyFailed"));

  const label = copied ? t("agentCodeBlock.copied") : t("agentCodeBlock.copy");
  return (
    <div className="mt-2 overflow-hidden rounded-md border bg-muted/30 first:mt-0">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
        <span className="truncate text-xs text-muted-foreground">{language}</span>
        {/* An empty fence body leaves nothing meaningful to put on the
            clipboard, matching the no-action rule for empty answers. */}
        {code.length > 0 && (
          <Button
            aria-label={label}
            className="size-6 shrink-0"
            onClick={() => void copy(code)}
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
        )}
      </div>
      <pre className="overflow-x-auto p-3 text-xs leading-relaxed">
        <code className={language ? `language-${language}` : undefined}>
          {code}
        </code>
      </pre>
    </div>
  );
}

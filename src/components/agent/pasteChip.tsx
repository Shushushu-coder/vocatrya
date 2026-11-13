"use client";

import { XIcon } from "lucide-react";
import {
  Attachment,
  AttachmentInfo,
  AttachmentPreview,
  type AttachmentData,
} from "@/components/ai-elements/attachments";
import { Button } from "@/components/ui/button";
import type { AgentPastePartData } from "@/models/agent.model";
import { useI18n, type TranslateFn } from "@/i18n";

export function chipLabel(
  chip: AgentPastePartData,
  t: TranslateFn,
  formatChars: (n: number) => string,
): string {
  const chars = formatChars(chip.chars);
  return chip.truncated
    ? t("agent.pastedPostingTruncated", { chars })
    : t("agent.pastedPosting", { chars });
}

// Synthesized at render time only. The wire format stays the custom data part:
// a real FileUIPart is a standard type, so convertToModelMessages would carry
// the whole posting to the model and defeat head truncation.
export function chipAttachment(
  chip: AgentPastePartData,
  t: TranslateFn,
  formatChars: (n: number) => string,
): AttachmentData {
  return {
    type: "file",
    id: chip.id,
    mediaType: "text/plain",
    filename: chipLabel(chip, t, formatChars),
    url: "",
  };
}

// The unsent paste card, rendered in the unified composer card row alongside
// the context chips (AWU-COMPOSER). Removing it only clears the chip — the
// textarea draft is untouched.
export function AgentPasteChip({
  chip,
  onRemove,
}: {
  chip: AgentPastePartData;
  onRemove: () => void;
}) {
  const { t, formatNumber } = useI18n();
  return (
    <span data-testid="agent-paste-chip" className="inline-flex shrink-0">
      <Attachment data={chipAttachment(chip, t, (n) => formatNumber(n))}>
        <AttachmentPreview />
        <AttachmentInfo />
        {/* Not AttachmentRemove: it repeats its label in an sr-only span, so
            the chip's wording would appear twice. */}
        <Button
          aria-label={t("agent.removePasted")}
          className="size-5 shrink-0 rounded p-0 [&_svg]:size-2.5"
          onClick={onRemove}
          type="button"
          variant="ghost"
        >
          <XIcon />
        </Button>
      </Attachment>
    </span>
  );
}

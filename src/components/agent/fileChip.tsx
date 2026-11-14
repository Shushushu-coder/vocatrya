"use client";

import { FileTextIcon, Loader2Icon, XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { AgentFilePartData } from "@/models/agent.model";
import { agentFilePlaceholder, type AgentFileChip } from "@/lib/agent/agentFiles";
import { useI18n, type TranslateFn } from "@/i18n";

export function fileChipLabel(
  chip: Pick<AgentFileChip, "name" | "chars" | "status">,
  t: TranslateFn,
  formatChars: (n: number) => string,
): string {
  if (chip.status === "extracting") return t("agent.fileExtracting", { name: chip.name });
  if (chip.status === "error") return t("agent.fileErrorLabel", { name: chip.name });
  const chars = formatChars(chip.chars ?? 0);
  return t("agent.fileAttached", { name: chip.name, chars });
}

function errorCopyKey(code: string | undefined): string {
  switch (code) {
    case "FILE_TOO_LARGE":
      return "agent.fileTooLarge";
    case "TOO_MANY":
      return "agent.fileTooMany";
    case "UNSUPPORTED_FORMAT":
      return "agent.fileUnsupported";
    case "NO_TEXT":
      return "agent.fileNoText";
    case "ENCRYPTED":
      return "agent.fileEncrypted";
    default:
      return "agent.fileExtractFailed";
  }
}

// The unsent file card in the composer card row (AWU-FILES): extraction
// status is visible — extracting, ready (chars), or a removable error.
// Removing clears the chip only; the draft text is untouched.
export function AgentFileChipCard({
  chip,
  onRemove,
}: {
  chip: AgentFileChip;
  onRemove: () => void;
}) {
  const { t, formatNumber } = useI18n();
  const isError = chip.status === "error";
  return (
    <span
      data-testid="agent-file-chip"
      data-status={chip.status}
      className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
      title={isError ? t(errorCopyKey(chip.errorCode)) : undefined}
    >
      {chip.status === "extracting" ? (
        <Loader2Icon className="size-3 animate-spin text-muted-foreground" />
      ) : (
        <FileTextIcon className={isError ? "size-3 text-destructive" : "size-3 text-muted-foreground"} />
      )}
      <span className={isError ? "max-w-40 truncate text-destructive" : "max-w-40 truncate"}>
        {fileChipLabel(chip, t, (n) => formatNumber(n))}
      </span>
      <button
        type="button"
        aria-label={t("agent.fileRemove", { name: chip.name })}
        className="rounded-full p-0.5 hover:bg-muted"
        onClick={onRemove}
      >
        <XIcon className="h-3 w-3" />
      </button>
    </span>
  );
}

// The read-only card a persisted data-file part renders inside the
// transcript — reopening a conversation shows what was attached, the name
// and extracted size, without the remove affordance.
export function AgentFilePartCard({ data }: { data: AgentFilePartData }) {
  const { t, formatNumber } = useI18n();
  const chars = formatNumber(data.chars);
  return (
    <span
      data-testid="agent-file-part"
      className="inline-flex max-w-[85%] shrink-0 items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
      title={agentFilePlaceholder(data.name)}
    >
      <FileTextIcon className="size-3 shrink-0 text-muted-foreground" />
      <span className="truncate">
        {data.truncated
          ? t("agent.fileAttachedTruncated", { name: data.name, chars })
          : t("agent.fileAttached", { name: data.name, chars })}
      </span>
    </span>
  );
}


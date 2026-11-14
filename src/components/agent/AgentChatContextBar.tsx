"use client";

import { useEffect, useRef, useState } from "react";
import { Paperclip, Plus, X } from "lucide-react";
import { listAgentContextOptions } from "@/actions/agentChat.actions";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { AgentFileChipCard } from "@/components/agent/fileChip";
import { AgentPasteChip } from "@/components/agent/pasteChip";
import {
  Attachments,
} from "@/components/ai-elements/attachments";
import {
  PromptInputButton,
  usePromptInputController,
} from "@/components/ai-elements/prompt-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useI18n } from "@/i18n";

type ContextOption = {
  kind: "job" | "resume";
  id: string;
  label: string;
  secondary: string | null;
};

// The unified composer card row (AWU-COMPOSER): every added item — page/job/
// resume context plus an unsent paste — sits here above the input box, and
// each chip removes independently. Empty state renders nothing; the "add"
// affordance lives in the toolbar's AgentAddContextMenu.
export function AgentChatContextBar() {
  const { t } = useI18n();
  const {
    context,
    removeContextItem,
    pasteChip,
    setPasteChip,
    fileChips,
    removeFileChip,
  } = useAgentChat();

  if (context.items.length === 0 && !pasteChip && fileChips.length === 0)
    return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 overflow-x-auto pb-2">
      {context.items.map((item) => (
        <span
          key={`${item.kind}:${item.entityId}`}
          data-testid="agent-context-chip"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border bg-muted/40 px-2 py-0.5 text-xs"
        >
          <span className="max-w-40 truncate">{item.labelSnapshot}</span>
          {item.source === "AUTO" ? (
            <span className="text-muted-foreground">{t("agent.contextAuto")}</span>
          ) : null}
          <button
            type="button"
            aria-label={t("agent.contextRemove", { label: item.labelSnapshot })}
            className="rounded-full p-0.5 hover:bg-muted"
            onClick={() => removeContextItem(item.kind, item.entityId)}
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {pasteChip ? (
        <Attachments variant="inline">
          <AgentPasteChip chip={pasteChip} onRemove={() => setPasteChip(undefined)} />
        </Attachments>
      ) : null}
      {fileChips.map((chip) => (
        <AgentFileChipCard
          key={chip.id}
          chip={chip}
          onRemove={() => removeFileChip(chip.id)}
        />
      ))}
    </div>
  );
}

// The toolbar "add" entry (AWU-COMPOSER). Lists job/resume context options
// plus the file picker (AWU-FILES); dictation joins this menu in slice C.
export function AgentAddContextMenu({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const {
    addContextItem,
    contextPickerNonce,
  } = useAgentChat();
  // The hidden file input lives inside PromptInput; its provider registers
  // the opener so this menu can trigger the same dialog (AWU-FILES).
  const attachments = usePromptInputController().attachments;
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<ContextOption[]>([]);
  const [resumes, setResumes] = useState<ContextOption[]>([]);

  // The nonce is provider state and survives this component's remounts
  // (composerNonce remounts the toolbar on every conversation reset), so a
  // mount-time value is "already seen" — only a later bump re-opens the menu.
  const seenPickerNonceRef = useRef(contextPickerNonce);
  useEffect(() => {
    if (contextPickerNonce === seenPickerNonceRef.current) return;
    seenPickerNonceRef.current = contextPickerNonce;
    setOpen(true);
  }, [contextPickerNonce]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listAgentContextOptions().then((result) => {
      if (cancelled || !result.success || !result.data) return;
      setJobs(result.data.jobs);
      setResumes(result.data.resumes);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const attach = (option: ContextOption) => {
    addContextItem({
      kind: option.kind,
      entityId: option.id,
      labelSnapshot: option.secondary
        ? `${option.label} · ${option.secondary}`
        : option.label,
      source: "MANUAL",
    });
    setOpen(false);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <PromptInputButton
          aria-label={t("agent.addContent")}
          data-testid="agent-add-context"
        >
          <Plus className="size-4" />
          {compact ? null : <span>{t("agent.addContent")}</span>}
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-2">
        <div className="max-h-64 space-y-2 overflow-y-auto">
          <div>
            <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
              {t("agent.fileSection")}
            </p>
            <button
              type="button"
              data-testid="agent-add-file"
              className="flex w-full items-center gap-1.5 truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
              onClick={() => {
                setOpen(false);
                attachments.openFileDialog();
              }}
            >
              <Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
              {t("agent.addFile")}
            </button>
          </div>
          <OptionGroup
            title={t("agent.contextJobs")}
            empty={t("agent.contextEmpty")}
            options={jobs}
            onPick={attach}
          />
          <OptionGroup
            title={t("agent.contextResumes")}
            empty={t("agent.contextEmpty")}
            options={resumes}
            onPick={attach}
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function OptionGroup({
  title,
  empty,
  options,
  onPick,
}: {
  title: string;
  empty: string;
  options: ContextOption[];
  onPick: (option: ContextOption) => void;
}) {
  return (
    <div>
      <p className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
        {title}
      </p>
      {options.length === 0 ? (
        <p className="px-2 pb-1 text-xs text-muted-foreground">{empty}</p>
      ) : (
        options.map((option) => (
          <button
            key={`${option.kind}:${option.id}`}
            type="button"
            className="block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
            onClick={() => onPick(option)}
          >
            {option.label}
            {option.secondary ? (
              <span className="ml-1 text-xs text-muted-foreground">
                {option.secondary}
              </span>
            ) : null}
          </button>
        ))
      )}
    </div>
  );
}

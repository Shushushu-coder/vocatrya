"use client";

import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import { listAgentContextOptions } from "@/actions/agentChat.actions";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
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

export function AgentChatContextBar() {
  const { t } = useI18n();
  const {
    context,
    addContextItem,
    removeContextItem,
    contextPickerNonce,
  } = useAgentChat();
  const [open, setOpen] = useState(false);
  const [jobs, setJobs] = useState<ContextOption[]>([]);
  const [resumes, setResumes] = useState<ContextOption[]>([]);

  useEffect(() => {
    if (!contextPickerNonce) return;
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
    <div className="flex items-center gap-1.5 overflow-x-auto pb-2">
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
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            data-testid="agent-add-context"
            className="inline-flex shrink-0 items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted/40"
          >
            <Plus className="h-3 w-3" />
            {t("agent.addContext")}
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-2">
          <div className="max-h-64 space-y-2 overflow-y-auto">
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
    </div>
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

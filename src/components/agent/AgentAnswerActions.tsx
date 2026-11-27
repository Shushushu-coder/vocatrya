"use client";

import { CheckIcon, CopyIcon, RefreshCwIcon, RotateCcwIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentRoleAvatar } from "@/components/agent/AgentRoleAvatar";
import { useClipboardCopy } from "@/components/agent/useClipboardCopy";
import { useI18n } from "@/i18n";
import type { AgentRole } from "@/lib/agent/agentRoles";

const REANSWER_OPTIONS: ReadonlyArray<{
  role: AgentRole;
  labelKey: string;
}> = [
  { role: "pilot", labelKey: "agentAnswer.reanswerPilot" },
  { role: "insight", labelKey: "agentAnswer.reanswerInsight" },
  { role: "reflect", labelKey: "agentAnswer.reanswerReflect" },
];

// Action row for one assistant answer. Copy takes the text it was given at
// click time — during streaming that is the visible snapshot, which is the
// honest reading of "copy the answer's visible body". onRegenerate is only
// passed for the last answer of a settled conversation; onReanswer appends a
// fresh reply from the selected role without removing the original message or
// rolling back writes/approvals (D01/D05).
export function AgentAnswerActions({
  text,
  onRegenerate,
  onReanswer,
  currentRole,
}: {
  text: string;
  onRegenerate?: () => void;
  onReanswer?: (role: AgentRole) => void;
  currentRole?: AgentRole | null;
}) {
  const { t } = useI18n();
  const { copied, copy } = useClipboardCopy(t("agentAnswer.copyFailed"));

  const label = copied ? t("agentAnswer.copied") : t("agentAnswer.copy");
  const regenerateLabel = t("agentAnswer.regenerate");
  const reanswerLabel = t("agentAnswer.reanswer");
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
      {onReanswer ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={reanswerLabel}
              className="h-6 shrink-0 gap-1 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              data-testid="agent-reanswer-trigger"
              size="sm"
              title={reanswerLabel}
              type="button"
              variant="ghost"
            >
              <RefreshCwIcon className="size-3" />
              <span>{reanswerLabel}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {REANSWER_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.role}
                data-testid={`agent-reanswer-${option.role}`}
                className="gap-2 text-xs"
                onSelect={() => onReanswer(option.role)}
              >
                <AgentRoleAvatar role={option.role} size={18} />
                <span className="min-w-0 flex-1 truncate">
                  {t(option.labelKey)}
                </span>
                {currentRole === option.role ? (
                  <CheckIcon className="size-3 shrink-0 text-muted-foreground" />
                ) : null}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  );
}

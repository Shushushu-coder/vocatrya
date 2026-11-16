"use client";

import { useEffect, useState } from "react";
import { ShieldCheck, ChevronDown, Loader2 } from "lucide-react";
import { getAgentToolPermissions } from "@/actions/agentChat.actions";
import { useAgentChat } from "./AgentChatProvider";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useI18n } from "@/i18n";

import type { AgentToolPermissionSnapshot } from "@/lib/agent/chatTypes";
export function AgentPermissionChip({ compact = false }: { compact?: boolean }) {
  const { t } = useI18n();
  const { activeRole, conversationId, approvalPending } = useAgentChat();
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<AgentToolPermissionSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setData(null);
    void getAgentToolPermissions({ conversationId, agentRole: activeRole }).then(result => {
      if (!cancelled && result.success && result.data) setData(result.data);
    }).catch(() => undefined).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, conversationId, activeRole]);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={t("agent.permissionsTitle")} title={t("agent.permissionsTitle")}
          className="inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-2 text-xs text-muted-foreground hover:bg-muted">
          <ShieldCheck className="size-3.5" />
          {!compact && <span>{t("agent.permissionsLabel")}</span>}
          {approvalPending && <span className="size-1.5 rounded-full bg-amber-500" aria-label={t("agent.waitingOnApproval")} />}
          <ChevronDown className="size-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-4">
        <h3 className="text-sm font-medium">{t("agent.permissionsTitle")}</h3>
        <p className="text-xs text-muted-foreground">{t("agent.permissionsHint")}</p>
        {approvalPending && <p role="status" className="text-xs text-amber-600">{t("agent.waitingOnApproval")}</p>}
        {loading ? <Loader2 className="size-4 animate-spin" aria-label={t("common.loading")} /> : data ? (
          <ul className="max-h-64 space-y-2 overflow-y-auto text-xs">
            {data.tools.map(tool => <li key={tool.name} className="flex items-start justify-between gap-3">
              <span>{t(`agent.permissionTools.${tool.name}`)}</span>
              <span className="shrink-0 text-muted-foreground">{t(`agent.permissionApproval.${tool.approval}`)}</span>
            </li>)}
          </ul>
        ) : <p role="alert" className="text-xs text-muted-foreground">{t("agent.permissionsUnavailable")}</p>}
        <p className="border-t pt-3 text-xs text-muted-foreground">{t("agent.permissionsBoundary")}</p>
      </PopoverContent>
    </Popover>
  );
}

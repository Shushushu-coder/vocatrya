"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Lock } from "lucide-react";
import { listEligibleChatModels } from "@/actions/agentChat.actions";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useI18n } from "@/i18n";
import type { EligibleChatModel, ExplicitModelSelection } from "@/lib/agent/chatTypes";

export function AgentChatIdentity() {
  const { t } = useI18n();
  const {
    conversationId,
    identity,
    setDraftModel,
    startNewConversation,
    modelPickerNonce,
  } = useAgentChat();
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const [models, setModels] = useState<EligibleChatModel[]>([]);

  useEffect(() => {
    if (!modelPickerNonce) return;
    setPicking(true);
    setOpen(true);
  }, [modelPickerNonce]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void listEligibleChatModels().then((result) => {
      if (cancelled || !result.success || !result.data) return;
      setModels(result.data);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const locked = Boolean(conversationId) && identity.locked;
  const legacy = Boolean(conversationId) && identity.persistedLegacy;
  const label = legacy
    ? identity.model
      ? t("agent.legacyIdentity", { model: identity.model })
      : t("agent.legacyIdentityUnknown")
    : identity.model && identity.displayName
      ? t("agent.identityPair", {
          model: identity.model,
          connection: identity.displayName,
        })
      : (identity.model ?? t(identity.code === "AI_NOT_CONFIGURED" ? "agent.configureAi" : "agent.selectModel"));

  const choose = (model: EligibleChatModel) => {
    const selection: ExplicitModelSelection = {
      connectionId: model.connectionId,
      model: model.model,
    };
    setOpen(false);
    setPicking(false);
    if (conversationId) {
      void startNewConversation({ explicit: selection });
      return;
    }
    setDraftModel(selection);
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setPicking(false);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="agent-identity"
          className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground"
          aria-label={label || t("agent.selectModel")}
        >
          {locked ? <Lock className="h-3 w-3 shrink-0" aria-hidden /> : null}
          <span className="truncate font-mono">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2 p-3">
        {locked && !picking ? (
          <>
            <p className="text-sm">
              {t("agent.lockTitle", { model: identity.model ?? "" })}
            </p>
            <p className="text-xs text-muted-foreground">{t("agent.lockBody")}</p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPicking(true)}
            >
              {t("agent.useOtherModel")}
            </Button>
          </>
        ) : legacy && !picking ? (
          <p className="text-sm">{label}</p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {conversationId ? t("agent.useOtherModel") : t("agent.modelForNew")}
            </p>
            <div className="max-h-56 space-y-1 overflow-y-auto">
              {models.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("agent.noEligibleModels")}
                </p>
              ) : (
                models.map((model) => (
                  <button
                    key={`${model.connectionId}:${model.model}`}
                    type="button"
                    className="block w-full truncate rounded-sm px-2 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => choose(model)}
                  >
                    {t("agent.identityPair", {
                      model: model.model,
                      connection: model.displayName,
                    })}
                  </button>
                ))
              )}
            </div>
            {models.length === 0 && (
              <Button asChild size="sm" variant="outline">
                <Link href="/dashboard/settings?section=ai-services">{t("agent.goToAiSettings")}</Link>
              </Button>
            )}
          </>
        )}
      </PopoverContent>
    </Popover>
  );
}

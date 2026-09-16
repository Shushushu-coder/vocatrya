"use client";

import { MessageSquare, PanelRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { useI18n } from "@/i18n";

export function AgentChatTrigger() {
  const { isOpen, open, close, approvalPending } = useAgentChat();
  const { t } = useI18n();

  return (
    <Button
      variant="outline"
      className="relative gap-1.5"
      aria-label={isOpen ? t("nav.closeAssistant") : t("nav.openAssistant")}
      onClick={() => (isOpen ? close() : open())}
    >
      {isOpen ? (
        <PanelRight className="h-4 w-4" />
      ) : (
        <>
          <MessageSquare className="h-4 w-4" />
          <span>{t("agent.triggerLabel")}</span>
        </>
      )}
      {/* Deliberately no streaming state: nothing generates while the panel
          is closed, so there is no background activity to advertise. */}
      {approvalPending && (
        <span
          className="absolute right-1 top-1 h-2 w-2 rounded-full bg-primary"
          aria-label="Approval pending"
        />
      )}
    </Button>
  );
}

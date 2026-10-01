"use client";

import { useState } from "react";
import { History, Plus, Scan, X } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AgentChatContextBar } from "@/components/agent/AgentChatContextBar";
import { AgentChatEmptyState } from "@/components/agent/AgentChatEmptyState";
import { AgentChatHistory } from "@/components/agent/AgentChatHistory";
import { AgentChatIdentity } from "@/components/agent/AgentChatIdentity";
import { AgentChatInput } from "@/components/agent/AgentChatInput";
import { AgentChatMessages } from "@/components/agent/AgentChatMessages";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { useI18n } from "@/i18n";

export function AgentChatPanel() {
  const { t } = useI18n();
  const {
    isOpen,
    close,
    startNewConversation,
    messages,
    panelWidth: width,
    startResize,
    isPanelExpanded,
    togglePanelExpand,
  } = useAgentChat();
  const [historyOpen, setHistoryOpen] = useState(false);

  return (
    <Sheet
      open={isOpen}
      onOpenChange={(next) => {
        if (!next) close();
      }}
      modal={false}
    >
      <SheetContent
        overlay={false}
        onInteractOutside={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
        className="relative flex flex-col overflow-hidden p-0 [&>button:last-child]:hidden w-full max-w-full sm:max-w-full lg:w-(--agent-chat-w) lg:max-w-(--agent-chat-max)"
        style={
          {
            "--agent-chat-w": `${width}px`,
            "--agent-chat-max": "100vw",
          } as React.CSSProperties
        }
      >
        <div
          className="absolute left-0 top-0 z-10 hidden h-full w-1 cursor-col-resize group lg:block"
          onMouseDown={startResize}
        >
          <div className="h-full w-px bg-transparent transition-colors group-hover:bg-primary/50" />
        </div>

        <div className="flex shrink-0 items-center gap-2 border-b bg-muted/20 px-3 py-2.5">
          <SheetTitle className="m-0 shrink-0 text-[11px] font-bold uppercase leading-none tracking-[0.15em] text-foreground">
            {t("agent.panelTitle")}
          </SheetTitle>
          <AgentChatIdentity />
          <Button
            data-testid="agent-new-conversation"
            className="ml-auto h-6 shrink-0 rounded-sm px-2 text-xs"
            onClick={() => {
              setHistoryOpen(false);
              void startNewConversation();
            }}
            size="sm"
            variant="ghost"
          >
            <Plus className="h-3.5 w-3.5" />
            {t("agent.newConversation")}
          </Button>
          <Button
            data-testid="agent-history"
            aria-label={t("agent.history")}
            className="h-6 w-6 shrink-0 rounded-sm"
            onClick={() => setHistoryOpen(true)}
            size="icon"
            variant="ghost"
          >
            <History className="h-3.5 w-3.5" />
          </Button>
          <Button
            aria-label={
              isPanelExpanded ? t("agent.restorePanel") : t("agent.expandPanel")
            }
            className="hidden h-6 w-6 shrink-0 rounded-sm lg:inline-flex"
            onClick={togglePanelExpand}
            size="icon"
            variant="ghost"
          >
            <Scan className="h-3.5 w-3.5" />
          </Button>
          <Button
            aria-label={t("agent.closeChat")}
            className="h-6 w-6 shrink-0 rounded-sm"
            onClick={close}
            size="icon"
            variant="ghost"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col lg:mx-auto lg:w-full lg:max-w-6xl">
          {messages.length > 0 ? <AgentChatMessages /> : <AgentChatEmptyState />}
        </div>

        <div className="shrink-0 border-t p-3">
          <div className="lg:mx-auto lg:w-full lg:max-w-6xl">
            <AgentChatContextBar />
            <AgentChatInput />
          </div>
        </div>
        {historyOpen ? (
          <AgentChatHistory onClose={() => setHistoryOpen(false)} />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

"use client";

import { useState } from "react";
import { History, Plus, Scan, X } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { AgentChatContextBar } from "@/components/agent/AgentChatContextBar";
import { AgentChatEmptyState } from "@/components/agent/AgentChatEmptyState";
import { AgentChatHistory } from "@/components/agent/AgentChatHistory";
import { AgentChatInput } from "@/components/agent/AgentChatInput";
import { AgentChatMessages } from "@/components/agent/AgentChatMessages";
import { AgentProposalEntry } from "@/components/agent/AgentProposalStatus";
import { AgentRoleSwitcher } from "@/components/agent/AgentRoleSwitcher";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { copyFor, AGENT_ROLE_KEYS } from "@/lib/agent/roleCopy";
import { useI18n } from "@/i18n";
import { VocatryaMark } from "@/components/brand/VocatryaMark";
import { useAgentBrandState } from "@/components/brand/useAgentBrandState";

export function AgentChatPanel() {
  const { t, locale } = useI18n();
  const copy = copyFor(t, locale);
  const {
    isOpen,
    close,
    startNewConversation,
    messages,
    status,
    brandCompletion,
    conversationId,
    error,
    actionError,
    interruptedTurn,
    approvalPending,
    panelWidth: width,
    startResize,
    isPanelExpanded,
    togglePanelExpand,
    activeRole,
  } = useAgentChat();
  const [historyOpen, setHistoryOpen] = useState(false);
  // D7 shrink order: the icon group never shrinks; the role subtitle drops
  // with Identity under 480px, then the action labels; expand/close stays.
  const compactHeader = width < 480;
  const hasTranscript = messages.some(message => message.role === "user" || message.role === "assistant");
  const brandState = useAgentBrandState({
    status, brandCompletion, isOpen, conversationId,
    blocked: Boolean(error || actionError || interruptedTurn || approvalPending),
  });

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
        className="flex flex-col overflow-hidden p-0 [&>button:last-child]:hidden w-full max-w-full sm:max-w-full lg:w-(--agent-chat-w) lg:max-w-(--agent-chat-max) top-[var(--desktop-titlebar-height,0px)] h-[calc(100%-var(--desktop-titlebar-height,0px))]"
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
          <VocatryaMark
            key={conversationId ?? "draft"}
            size={26}
            animated={hasTranscript}
            state={hasTranscript ? brandState : "idle"}
          />
          <AgentRoleSwitcher />
          <SheetTitle className="m-0 flex min-w-0 shrink items-baseline gap-1.5 overflow-hidden whitespace-nowrap leading-none">
            <span className="overflow-hidden text-ellipsis text-[11px] font-bold uppercase tracking-[0.15em] text-foreground">
              {copy(AGENT_ROLE_KEYS.name[activeRole])}
            </span>
            {compactHeader ? null : (
              <span className="min-w-0 overflow-hidden text-ellipsis text-[10px] font-normal normal-case tracking-normal text-muted-foreground">
                {copy(AGENT_ROLE_KEYS.subtitle[activeRole])}
              </span>
            )}
          </SheetTitle>
          <Button
            data-testid="agent-new-conversation"
            aria-label={t("agent.newConversation")}
            className="ml-auto h-6 shrink-0 rounded-sm px-2 text-xs"
            onClick={() => {
              setHistoryOpen(false);
              void startNewConversation();
            }}
            size="sm"
            variant="ghost"
          >
            <Plus className="h-3.5 w-3.5" />
            {compactHeader ? null : t("agent.newConversation")}
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
          <AgentProposalEntry />
          {hasTranscript ? <AgentChatMessages /> : <AgentChatEmptyState state={brandState} />}
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

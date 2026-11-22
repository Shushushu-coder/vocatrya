"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, ChevronUp, Circle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { listAgentTaskCards, type AgentTaskCardDTO } from "@/actions/agentTask.actions";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { useOpenAgentTask } from "@/components/agent/useOpenAgentTask";
import { useI18n } from "@/i18n";

/**
 * Task progress card (card E). Lives at the top right of the Agent window and
 * only renders when the user has an in-progress task. Collapsed: name, stage,
 * done count. Expanded: acceptance items, blocked reason, next step and
 * "继续任务". A dropdown switches between tasks (at most one live task per
 * job). All state shown here is derived server-side from domain evidence.
 */
export function AgentTaskCard() {
  const { t } = useI18n();
  const { isOpen, conversationId, activeTaskId, selectedTaskId, setSelectedTaskId, status } = useAgentChat();
  const { openTask, pendingTaskId } = useOpenAgentTask();
  const [cards, setCards] = useState<AgentTaskCardDTO[]>([]);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const result = await listAgentTaskCards();
      if (result.success && result.data) setCards(result.data);
    } catch {
      // The card is supplementary; a failed refresh keeps the last view.
    }
  }, []);

  // Reload when the window opens, the open conversation changes, or a turn
  // settles (progress is persisted by then).
  useEffect(() => {
    if (!isOpen) return;
    if (status === "submitted" || status === "streaming") return;
    void refresh();
  }, [isOpen, conversationId, activeTaskId, status, refresh]);

  // A manual pick wins until the open conversation's bound task changes
  // (the provider resets it); otherwise the bound task, then the first.
  const current =
    cards.find((card) => card.task.id === selectedTaskId) ??
    cards.find((card) => card.task.id === activeTaskId) ??
    cards[0];
  if (!current) return null;

  const { task, nextAction } = current;
  const done = task.acceptanceItems.filter((item) => item.passes).length;
  const total = task.acceptanceItems.length;
  const blockedLabel = task.blockedReason
    ? t(`agentTask.blocked.${task.blockedReason}`)
    : null;
  const pending = pendingTaskId === task.id;

  return (
    <div
      data-testid="agent-task-card"
      className="ml-auto w-full max-w-sm rounded-md border bg-card text-xs shadow-sm"
    >
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        {cards.length > 1 ? (
          <select
            aria-label={t("agentTask.switchTask")}
            data-testid="agent-task-switch"
            className="min-w-0 max-w-[45%] shrink truncate rounded-sm border bg-background px-1 py-0.5 text-xs"
            value={task.id}
            onChange={(event) => setSelectedTaskId(event.target.value)}
          >
            {cards.map((card) => (
              <option key={card.task.id} value={card.task.id}>
                {card.task.title}
              </option>
            ))}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate font-medium" title={task.title}>
            {task.title}
          </span>
        )}
        <span className="shrink-0 text-muted-foreground" data-testid="agent-task-stage">
          {t(`agentTask.milestone.${task.milestone}`)}
        </span>
        <span className="ml-auto shrink-0 tabular-nums text-muted-foreground" data-testid="agent-task-count">
          {t("agentTask.progressCount", { done, total })}
        </span>
        <Button
          aria-label={expanded ? t("agentTask.collapse") : t("agentTask.expand")}
          aria-expanded={expanded}
          className="h-5 w-5 shrink-0 rounded-sm"
          onClick={() => setExpanded((value) => !value)}
          size="icon"
          variant="ghost"
        >
          {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </Button>
      </div>
      {expanded ? (
        <div className="space-y-2 border-t px-2.5 py-2" data-testid="agent-task-details">
          <div>
            <p className="mb-1 font-medium text-muted-foreground">{t("agentTask.acceptance")}</p>
            <ul className="space-y-0.5">
              {task.acceptanceItems.map((item) => (
                <li key={item.key} className="flex items-start gap-1.5">
                  {item.passes ? (
                    <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-600" aria-label="done" />
                  ) : (
                    <Circle className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" aria-label="todo" />
                  )}
                  <span className={item.passes ? "text-muted-foreground line-through" : undefined}>
                    {item.label}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          {blockedLabel ? (
            <p data-testid="agent-task-blocked">
              <span className="font-medium text-muted-foreground">{t("agentTask.blockedReason")}: </span>
              {blockedLabel}
            </p>
          ) : null}
          <p data-testid="agent-task-next">
            <span className="font-medium text-muted-foreground">{t("agentTask.nextStep")}: </span>
            {nextAction ?? t("agentTask.noNextStep")}
          </p>
          <Button
            data-testid="agent-task-continue"
            className="h-7 w-full text-xs"
            disabled={pending || status === "submitted" || status === "streaming"}
            onClick={() => void openTask(task.id).then(() => refresh())}
            size="sm"
          >
            {pending ? t("agentTask.continuing") : t("agentTask.continueTask")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

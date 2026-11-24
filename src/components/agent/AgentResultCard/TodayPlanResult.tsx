"use client";

import { useEffect, useState } from "react";
import { Check, Circle } from "lucide-react";

import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { undoTodayPlan } from "@/actions/todayPlan.actions";
import type {
  AgentTodayPlanReadResult,
  AgentTodayPlanWriteResult,
} from "@/models/agent.model";
import {
  TODAY_PLAN_CHANGED_EVENT,
  type TodayPlanItemView,
} from "@/lib/todayPlan/types";
import { cn } from "@/lib/utils";

function ItemLine({ item }: { item: TodayPlanItemView }) {
  return (
    <li className="flex items-center gap-2 text-sm">
      {item.completed ? (
        <Check className="h-3.5 w-3.5 shrink-0 text-primary" />
      ) : (
        <Circle className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          item.completed && "text-muted-foreground line-through",
        )}
      >
        {item.title}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground">
        {item.plannedOn}
      </span>
    </li>
  );
}

/** Read-tool output: the saved buckets plus the suggestion snapshot the
 *  model drafts from. Suggestions are a draft — nothing is saved until the
 *  user adopts a plan through the write tool's approval card. */
export function TodayPlanReadResult({
  output,
}: {
  output: AgentTodayPlanReadResult;
}) {
  const { t } = useI18n();
  if (output.status !== "ok") {
    return (
      <p className="text-sm text-muted-foreground">
        {t("todayPlan.cardUnavailable")}
      </p>
    );
  }
  const { buckets, suggestions } = output;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">
        {t("todayPlan.title")} · {output.today}
      </p>
      {buckets.today.length > 0 && (
        <ul className="space-y-1">
          {buckets.today.map((item) => (
            <ItemLine key={item.id} item={item} />
          ))}
        </ul>
      )}
      {buckets.overdue.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("todayPlan.overdueCount", {
            count: buckets.overdue.length,
          })}
        </p>
      )}
      {suggestions.openTasks.length +
        suggestions.upcoming.length +
        suggestions.awaitingReflection.count >
      0 ? (
        <div className="rounded-sm border bg-muted/20 p-2">
          <p className="text-xs font-medium text-muted-foreground">
            {t("todayPlan.draftTitle")}
          </p>
          <ul className="mt-1 space-y-1">
            {suggestions.upcoming.map((s, i) => (
              <li key={`u-${i}`} className="text-sm">
                <span>{s.label}</span>
                {s.date ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    · {s.date}
                  </span>
                ) : null}
              </li>
            ))}
            {suggestions.awaitingReflection.items.map((s, i) => (
              <li key={`r-${i}`} className="text-sm">
                {s.label}
              </li>
            ))}
            {suggestions.openTasks.map((s) => (
              <li key={s.taskId} className="text-sm">
                {s.title}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          {t("todayPlan.noSuggestions")}
        </p>
      )}
    </div>
  );
}

/** Write-tool output. A durable write receipt — renders the saved rows and
 *  offers undo while the operation stays revertible. Fires the changed
 *  event so the top-bar badge and an open popover resync. */
export function TodayPlanWriteResult({
  output,
}: {
  output: AgentTodayPlanWriteResult;
}) {
  const { t } = useI18n();
  const { conversationId } = useAgentChat();
  const [undone, setUndone] = useState(false);

  useEffect(() => {
    if (output.status === "ok" && output.saved && conversationId) {
      window.dispatchEvent(
        new CustomEvent(TODAY_PLAN_CHANGED_EVENT, {
          detail: { conversationId },
        }),
      );
    }
  }, [output, conversationId]);

  if (output.status === "ok") {
    return (
      <div className="space-y-2">
        <p className="text-xs font-medium text-muted-foreground">
          {t("todayPlan.saved")} · {t(`todayPlan.action.${output.action}`)}
        </p>
        {output.changed.length > 0 && (
          <ul className="space-y-1">
            {output.changed.map((item) => (
              <ItemLine key={item.id} item={item} />
            ))}
          </ul>
        )}
        {output.undoable && !undone && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={async () => {
              if (!conversationId) return;
              const res = await undoTodayPlan({
                conversationId,
                operationId: output.operationId,
              });
              if (res.success && res.data?.status === "ok") {
                setUndone(true);
                window.dispatchEvent(
                  new CustomEvent(TODAY_PLAN_CHANGED_EVENT, {
                    detail: { conversationId },
                  }),
                );
              }
            }}
          >
            {t("todayPlan.undo")}
          </Button>
        )}
        {undone && (
          <p className="text-xs text-muted-foreground">
            {t("todayPlan.undone")}
          </p>
        )}
      </div>
    );
  }

  if (output.status === "ambiguous") {
    return (
      <div className="space-y-1">
        <p className="text-sm text-muted-foreground">
          {t("todayPlan.ambiguous", { title: output.itemTitle ?? "" })}
        </p>
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {output.candidates.map((c) => (
            <li key={c.id}>
              {c.title} · {c.plannedOn}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <p className="text-sm text-muted-foreground">
      {t(`todayPlan.status.${output.status}`, {
        title: output.itemTitle ?? "",
      })}
    </p>
  );
}

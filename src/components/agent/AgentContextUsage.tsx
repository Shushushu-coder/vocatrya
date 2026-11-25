"use client";

import { useState } from "react";
import { Loader2, Minimize2 } from "lucide-react";
import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  computeContextUsagePercent,
  formatUsageK,
} from "@/lib/agent/contextUsage";
import { cn } from "@/lib/utils";
import { useI18n, type TranslateFn } from "@/i18n";

// Toolbar indicator for the active session's assembled context size (M1):
// displays dynamic-window progress bar, token breakdown, micro-compaction /
// structured-summary stats, and a controlled manual compaction entry.
export function AgentContextUsage() {
  const { t } = useI18n();
  const {
    contextUsage,
    busy = false,
    compacting = false,
    compactionFeedback = null,
    compactContext,
    clearCompactionFeedback,
    identity,
    conversationId,
    nativeSession = false,
  } = useAgentChat();
  const [focusNote, setFocusNote] = useState("");

  if (!contextUsage) return null;

  const used = formatUsageK(contextUsage.estimatedInputTokens);
  const budget = formatUsageK(contextUsage.budgets.assembledInputTokens);
  const percent = computeContextUsagePercent(
    contextUsage.estimatedInputTokens,
    contextUsage.budgets.assembledInputTokens,
  );
  const triggerThreshold = contextUsage.autoCompactTriggerTokens;
  const isDanger = percent >= 90;
  const isWarning =
    !isDanger &&
    (percent >= 75 ||
      (triggerThreshold !== undefined &&
        contextUsage.estimatedInputTokens >= triggerThreshold));
  const barTone = isDanger
    ? "bg-destructive"
    : isWarning
      ? "bg-amber-500"
      : "bg-primary";

  const canManualCompact = Boolean(
    conversationId &&
      !nativeSession &&
      identity?.kind !== "legacy" &&
      typeof compactContext === "function",
  );

  const handleCompact = async () => {
    if (!compactContext) return;
    const note = focusNote.trim();
    await compactContext(note || undefined);
    if (note) setFocusNote("");
  };

  return (
    <Popover
      onOpenChange={(open) => {
        if (!open) clearCompactionFeedback?.();
      }}
    >
      <PopoverTrigger asChild>
        <PromptInputButton
          aria-label={t("agent.contextUsageLabel")}
          className="gap-1.5 text-xs text-muted-foreground"
        >
          {compacting ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <span
              aria-hidden="true"
              className="inline-block h-1.5 w-6 overflow-hidden rounded-full bg-muted"
            >
              <span
                className={cn("block h-full transition-all", barTone)}
                style={{ width: `${percent}%` }}
              />
            </span>
          )}
          <span className="tabular-nums">
            {t("agent.contextUsageValue", { used, budget })}
          </span>
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-3">
        <div className="space-y-2.5">
          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <p className="text-xs font-medium">{t("agent.contextUsageLabel")}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {t("agent.contextUsageValue", { used, budget })} ·{" "}
                {t("agent.contextUsagePercent", { percent })}
              </p>
            </div>
            <div
              role="progressbar"
              aria-label={t("agent.contextUsageLabel")}
              aria-valuenow={percent}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
            >
              <div
                className={cn("h-full transition-all", barTone)}
                style={{ width: `${percent}%` }}
              />
            </div>
            {contextUsage.modelContextWindowTokens ? (
              <p className="text-[11px] text-muted-foreground">
                {t("agent.contextUsageWindowCap", {
                  window: formatUsageK(contextUsage.modelContextWindowTokens),
                  cap: budget,
                })}
                {triggerThreshold
                  ? ` · ${t("agent.contextUsageAutoTrigger", {
                      threshold: formatUsageK(triggerThreshold),
                    })}`
                  : ""}
              </p>
            ) : null}
          </div>

          <dl className="space-y-1 text-xs">
            <UsageRow
              label={t("agent.contextUsageSystem")}
              value={contextUsage.tokens.system}
              t={t}
            />
            <UsageRow
              label={t("agent.contextUsageCurrentUser")}
              value={contextUsage.tokens.currentUser}
              budget={contextUsage.budgets.currentUserTokens}
              t={t}
            />
            <UsageRow
              label={t("agent.contextUsageHistory")}
              value={contextUsage.tokens.history}
              budget={contextUsage.budgets.historyTokens}
              t={t}
            />
            <UsageRow
              label={t("agent.contextUsageExplicit")}
              value={contextUsage.tokens.explicitContext}
              budget={contextUsage.budgets.explicitContextTokens}
              t={t}
            />
            <UsageRow
              label={t("agent.contextUsageToolResult")}
              value={contextUsage.tokens.toolResult}
              budget={contextUsage.budgets.historicalToolTokens}
              t={t}
            />
            <UsageRow
              label={t("agent.contextUsageSummary")}
              value={contextUsage.tokens.summary}
              budget={contextUsage.budgets.summaryTokens}
              t={t}
            />
            {contextUsage.tokens.businessAnchor &&
            contextUsage.tokens.businessAnchor > 0 ? (
              <UsageRow
                label={t("agent.contextUsageBusinessAnchor")}
                value={contextUsage.tokens.businessAnchor}
                budget={contextUsage.budgets.businessAnchorTokens}
                t={t}
              />
            ) : null}
          </dl>

          <p className="text-xs text-muted-foreground">
            {t("agent.contextUsageDynamic", {
              value: formatUsageK(contextUsage.tokens.dynamic),
              budget: formatUsageK(contextUsage.budgets.dynamicTokens),
            })}
          </p>

          {(contextUsage.microCompactedToolCount ?? 0) > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t("agent.contextUsageMicroCompacted", {
                count: contextUsage.microCompactedToolCount ?? 0,
              })}
            </p>
          ) : null}

          {(contextUsage.compactedTurnCount ?? 0) > 0 ? (
            <p className="text-[11px] text-muted-foreground">
              {t("agent.contextUsageCompactedTurns", {
                count: contextUsage.compactedTurnCount ?? 0,
              })}
            </p>
          ) : null}

          {contextUsage.droppedTurnCount > 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t("agent.contextUsageDropped", {
                count: contextUsage.droppedTurnCount,
              })}
            </p>
          ) : null}

          {contextUsage.circuitBreakerOpen ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t("agent.contextCompactCircuitOpen")}
            </p>
          ) : null}

          {canManualCompact ? (
            <div className="space-y-1.5 border-t pt-2">
              <label className="block space-y-1">
                <span className="text-[11px] font-medium text-muted-foreground">
                  {t("agent.contextCompactFocusLabel")}
                </span>
                <Input
                  aria-label={t("agent.contextCompactFocusLabel")}
                  className="h-7 px-2 text-xs"
                  disabled={compacting || busy}
                  maxLength={240}
                  onChange={(event) => setFocusNote(event.target.value)}
                  placeholder={t("agent.contextCompactFocusPlaceholder")}
                  value={focusNote}
                />
              </label>
              <Button
                className="h-7 w-full gap-1.5 text-xs"
                disabled={compacting || busy}
                onClick={() => void handleCompact()}
                size="sm"
                type="button"
                variant="outline"
              >
                {compacting ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Minimize2 className="size-3.5" />
                )}
                <span>
                  {compacting
                    ? t("agent.contextCompactRunning")
                    : t("agent.contextCompactAction")}
                </span>
              </Button>
              {compactionFeedback ? (
                <p
                  role="status"
                  className={cn(
                    "text-[11px]",
                    compactionFeedback.kind === "error"
                      ? "text-destructive"
                      : compactionFeedback.kind === "busy"
                        ? "text-amber-600 dark:text-amber-500"
                        : "text-muted-foreground",
                  )}
                >
                  {compactionFeedback.kind === "success"
                    ? t("agent.contextCompactSuccess")
                    : compactionFeedback.kind === "skipped"
                      ? t("agent.contextCompactSkipped")
                      : compactionFeedback.kind === "busy"
                        ? t("agent.contextCompactBusy")
                        : t("agent.contextCompactFailed")}
                </p>
              ) : null}
            </div>
          ) : null}

          <p className="text-[11px] text-muted-foreground">
            {t("agent.contextUsageHint")}{" "}
            {canManualCompact ? "" : t("agent.contextUsageManaged")}
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function UsageRow({
  label,
  value,
  budget,
  t,
}: {
  label: string;
  value: number;
  /** Only segments the budgeter caps individually get a denominator. */
  budget?: number;
  t: TranslateFn;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">
        {budget === undefined
          ? formatUsageK(value)
          : t("agent.contextUsageValue", {
              used: formatUsageK(value),
              budget: formatUsageK(budget),
            })}
      </dd>
    </div>
  );
}

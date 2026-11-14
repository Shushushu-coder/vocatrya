"use client";

import { useAgentChat } from "@/components/agent/AgentChatProvider";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatUsageK } from "@/lib/agent/contextUsage";
import { useI18n, type TranslateFn } from "@/i18n";

// Toolbar indicator for the last turn's assembled context size (AWU-CONTEXT,
// D2: read-only, inline hint + expandable detail). The number is the app's
// character-density assembly estimate — it is NOT the model's context
// window and never claims to be. When the server cannot produce a real
// size (Legacy conversations), nothing renders rather than a made-up one.
export function AgentContextUsage() {
  const { t } = useI18n();
  const { contextUsage } = useAgentChat();

  if (!contextUsage) return null;

  const used = formatUsageK(contextUsage.estimatedInputTokens);
  const budget = formatUsageK(contextUsage.budgets.assembledInputTokens);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <PromptInputButton
          aria-label={t("agent.contextUsageLabel")}
          className="text-xs text-muted-foreground"
        >
          <span>{t("agent.contextUsageValue", { used, budget })}</span>
        </PromptInputButton>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 p-3">
        <div className="space-y-2">
          <div className="flex items-baseline justify-between gap-2">
            <p className="text-xs font-medium">{t("agent.contextUsageLabel")}</p>
            <p className="text-xs text-muted-foreground">
              {t("agent.contextUsageValue", { used, budget })}
            </p>
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
          </dl>
          <p className="text-xs text-muted-foreground">
            {t("agent.contextUsageDynamic", {
              value: formatUsageK(contextUsage.tokens.dynamic),
              budget: formatUsageK(contextUsage.budgets.dynamicTokens),
            })}
          </p>
          {contextUsage.droppedTurnCount > 0 ? (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t("agent.contextUsageDropped", {
                count: contextUsage.droppedTurnCount,
              })}
            </p>
          ) : null}
          <p className="text-[11px] text-muted-foreground">
            {t("agent.contextUsageHint")} {t("agent.contextUsageManaged")}
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

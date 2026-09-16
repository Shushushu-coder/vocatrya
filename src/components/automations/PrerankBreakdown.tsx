"use client";

import { Badge } from "@/components/ui/badge";
import { APP_CONSTANTS } from "@/lib/constants";
import type { PrerankComponents } from "@/models/ai.schemas";
import { useI18n } from "@/i18n";

interface PrerankBreakdownProps {
  prerankScore: number;
  components?: PrerankComponents;
}

// Surfaces the internal lexical pre-rank score next to the LLM match so the
// two can be compared for tuning. The lexical score is never an AI %.
export function PrerankBreakdown({
  prerankScore,
  components,
}: PrerankBreakdownProps) {
  const { t } = useI18n();
  const rows = components
    ? [
        {
          label: t("common.title"),
          weight: APP_CONSTANTS.ATS_TITLE_WEIGHT,
          score: components.titleScore,
          hits: components.titleHits,
        },
        {
          label: t("automations.keywords"),
          weight: APP_CONSTANTS.ATS_SKILL_WEIGHT,
          score: components.keywordScore,
          hits: components.keywordHits,
        },
      ]
    : [];

  return (
    <div className="rounded-md border border-dashed p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{t("automations.lexicalPrerank")}</span>
        <span className="font-mono text-sm">
          {Math.round(prerankScore * 100)}%
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t("automations.prerankDescription")}
      </p>
      {rows.map((row) => (
        <div key={row.label} className="text-xs">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">
              {row.label} <span className="opacity-60">(×{row.weight})</span>
            </span>
            <span className="font-mono">
              {row.score.toFixed(2)} → +
              {(row.score * row.weight * 100).toFixed(1)}%
            </span>
          </div>
          {row.hits.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {row.hits.map((hit) => (
                <Badge key={hit} variant="secondary" className="text-[10px]">
                  {hit}
                </Badge>
              ))}
            </div>
          )}
        </div>
      ))}
      {components && (
        <div className="text-xs text-muted-foreground">
          {components.locScore > 0
            ? t("automations.locationMatches")
            : t("automations.locationNotScored")}
        </div>
      )}
    </div>
  );
}

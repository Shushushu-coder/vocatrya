"use client";

import { useI18n } from "@/i18n";

type RecordsCountProps = {
  count: number;
  total?: number;
  label?: string;
};

export function RecordsCount({
  count,
  total,
  label,
}: RecordsCountProps) {
  const { t } = useI18n();
  const resolvedLabel = label ?? t("common.records");
  const range =
    total !== undefined
      ? t("common.showingRangeOf", { from: 1, to: count, total })
      : t("common.showingRange", { from: 1, to: count });

  return (
    <div className="text-xs text-muted-foreground whitespace-nowrap">
      {range} {resolvedLabel}
    </div>
  );
}

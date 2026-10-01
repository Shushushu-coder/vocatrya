"use client";

import { Clock } from "lucide-react";
import { useI18n } from "@/i18n";

export const SlowResponseWarning = () => {
  const { t } = useI18n();
  return (
    <p className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
      <Clock className="h-3 w-3 shrink-0" />
      <span>{t("agent.slowResponse")}</span>
    </p>
  );
};

"use client";

import { useI18n } from "@/i18n";

export function NoResumesNotice() {
  const { t } = useI18n();
  return <p className="text-sm">{t("agent.noResumes")}</p>;
}

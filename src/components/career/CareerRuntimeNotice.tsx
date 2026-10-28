"use client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CAREER_RUNTIME_MODE } from "@/lib/career/identities";
import { useI18n } from "@/i18n";

type CareerRuntimeNoticeProps = {
  mode: string;
  jobMutationsEnabled?: boolean;
};

export function CareerRuntimeNotice({ mode, jobMutationsEnabled = true }: CareerRuntimeNoticeProps) {
  const { t } = useI18n();
  if (mode === CAREER_RUNTIME_MODE.LEGACY_ONLY) return null;
  if (mode === CAREER_RUNTIME_MODE.AB_ENABLED) {
    if (jobMutationsEnabled) return null;
    return (
      <Alert className="mb-4">
        <AlertTitle>{t("career.jobsReadOnlyTitle")}</AlertTitle>
        <AlertDescription>{t("career.jobsReadOnlyDescription")}</AlertDescription>
      </Alert>
    );
  }

  const blocked = mode === CAREER_RUNTIME_MODE.BLOCKED;
  return (
    <Alert variant={blocked ? "destructive" : "default"} className="mb-4">
      <AlertTitle>
        {blocked ? t("career.runtimeBlockedTitle") : t("career.runtimeReadyTitle")}
      </AlertTitle>
      <AlertDescription>
        {blocked
          ? t("career.runtimeBlockedDescription")
          : t("career.runtimeReadyDescription")}
      </AlertDescription>
    </Alert>
  );
}

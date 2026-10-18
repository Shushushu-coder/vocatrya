"use client";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useI18n } from "@/i18n";

// Explicit degraded state for dashboard sections whose jobs read is blocked:
// the area announces itself instead of rendering fabricated counts.
export default function JobsUnavailableNotice({
  className,
}: {
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <Alert
      variant="destructive"
      className={className}
      data-testid="jobs-unavailable-notice"
    >
      <AlertTitle>{t("dashboard.jobsUnavailableTitle")}</AlertTitle>
      <AlertDescription>
        {t("dashboard.jobsUnavailableDescription")}
      </AlertDescription>
    </Alert>
  );
}

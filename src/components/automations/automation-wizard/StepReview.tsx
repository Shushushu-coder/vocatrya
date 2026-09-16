"use client";

import { APP_CONSTANTS } from "@/lib/constants";
import type { CreateAutomationInput } from "@/models/automation.schema";
import type { AtsConfigValue } from "../AtsSearchStep";
import type { WizardResume } from "./wizardConfig";
import { useI18n } from "@/i18n";

export function StepReview({
  formValues,
  atsConfig,
  selectedResume,
}: {
  formValues: CreateAutomationInput;
  atsConfig: AtsConfigValue;
  selectedResume?: WizardResume;
}) {
  const { t } = useI18n();
  return (
    <div className="rounded-lg border p-4 space-y-3">
      <div className="flex justify-between">
        <span className="text-muted-foreground">{t("common.name")}</span>
        <span className="font-medium">{formValues.name || "-"}</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">{t("automations.jobBoard")}</span>
        <span className="font-medium capitalize">
          {formValues.jobBoard || "-"}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{t("automations.companies")}</span>
        <span className="font-medium text-right">
          {atsConfig.companies?.length
            ? atsConfig.companies.map((c) => c.name).join(", ")
            : "-"}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{t("automations.targetTitles")}</span>
        <span className="font-medium text-right">
          {atsConfig.targetTitles?.length
            ? atsConfig.targetTitles.join(", ")
            : t("automations.any")}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{t("automations.locations")}</span>
        <span className="font-medium text-right">
          {atsConfig.locations?.length
            ? `${atsConfig.locations.join(", ")}${
                atsConfig.strictLocation ? t("automations.strictSuffix") : ""
              }`
            : t("automations.anyLocation")}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{t("automations.jobsAnalyzedPerRun")}</span>
        <span className="font-medium text-right">
          {atsConfig.topK ?? APP_CONSTANTS.MAX_JOBS_PER_RUN}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">{t("automations.saveAdditionalListings")}</span>
        <span className="font-medium text-right">
          {atsConfig.saveUnanalyzed !== false ? t("common.yes") : t("common.no")}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">{t("automations.resume")}</span>
        <span className="font-medium">
          {selectedResume?.title || t("automations.notSelected")}
        </span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">{t("automations.matchThresholdLabel")}</span>
        <span className="font-medium">{formValues.matchThreshold ?? 80}%</span>
      </div>
      <div className="flex justify-between">
        <span className="text-muted-foreground">{t("automations.schedule")}</span>
        <span className="font-medium">
          {t("automations.dailyAtTime", {
            time: `${(formValues.scheduleHour ?? 8).toString().padStart(2, "0")}:00`,
          })}
        </span>
      </div>
    </div>
  );
}

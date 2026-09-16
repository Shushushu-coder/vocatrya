"use client";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { APP_CONSTANTS } from "@/lib/constants";
import type { AtsConfigValue } from "./types";
import { useI18n } from "@/i18n";

interface RunOptionsFieldsProps {
  value: AtsConfigValue;
  onChange: (next: AtsConfigValue) => void;
}

export function RunOptionsFields({ value, onChange }: RunOptionsFieldsProps) {
  const { t } = useI18n();
  return (
    <>
      <div className="space-y-2">
        <Label>
          {t("automations.jobsAnalyzedPerRunValue", {
            value: value.topK ?? APP_CONSTANTS.MAX_JOBS_PER_RUN,
          })}
        </Label>
        <Slider
          min={1}
          max={APP_CONSTANTS.ATS_LISTING_CAP}
          step={1}
          value={[value.topK ?? APP_CONSTANTS.MAX_JOBS_PER_RUN]}
          onValueChange={(next) => onChange({ ...value, topK: next[0] })}
        />
        <p className="text-sm text-muted-foreground">
          {t("automations.jobsAnalyzedDescription")}
        </p>
      </div>

      <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
        <div className="space-y-1">
          <Label>{t("automations.saveAdditionalRelevant")}</Label>
          <p className="text-sm text-muted-foreground">
            {t("automations.saveUnanalyzedDescription")}
          </p>
        </div>
        <Switch
          checked={value.saveUnanalyzed !== false}
          onCheckedChange={(checked) =>
            onChange({ ...value, saveUnanalyzed: checked })
          }
        />
      </div>
    </>
  );
}

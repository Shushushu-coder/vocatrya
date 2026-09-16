"use client";

import { Button } from "@/components/ui/button";
import {
  DisclosureGroup,
  SelectRow,
  StepperRow,
} from "@/components/pdf-export/settings-rows";
import {
  formatSettingValue,
  PDF_FONT_LABELS,
} from "@/models/pdfExport.model";
import {
  type ResumeExportSettings,
  type ResumeNumericSetting,
} from "@/models/resumeExport.model";
import { useI18n } from "@/i18n";

type ExportSettingsPanelProps = {
  settings: ResumeExportSettings;
  onChange: (settings: ResumeExportSettings) => void;
  onReset?: () => void;
  isDefault?: boolean;
};

const ID_PREFIX = "resume-export";

export function ExportSettingsPanel({
  settings,
  onChange,
  onReset,
  isDefault,
}: ExportSettingsPanelProps) {
  const { t } = useI18n();
  const setNumber = (field: ResumeNumericSetting) => (value: number) =>
    onChange({ ...settings, [field]: value });

  const layoutLabels = {
    simple: t("resume.simple"),
    professional: t("resume.professional"),
  } as const;

  const typographySummary = [
    PDF_FONT_LABELS[settings.font],
    formatSettingValue("fontSize", settings.fontSize),
    t("resume.lineSuffix", {
      value: formatSettingValue("lineHeight", settings.lineHeight),
    }),
  ].join(" • ");

  const layoutSummary = [
    t("resume.ptMargins", {
      v: settings.marginVertical,
      h: settings.marginHorizontal,
    }),
    t("resume.ptSpacing", {
      section: settings.sectionSpacing,
      entry: settings.entrySpacing,
    }),
  ].join(" • ");

  return (
    <div className="flex flex-col gap-4">
      {/* Template reshapes everything below it, so it never folds away. */}
      <div className="rounded-lg border bg-muted/40">
        <SelectRow
          id={`${ID_PREFIX}-template`}
          label={t("resume.template")}
          value={settings.template}
          labels={layoutLabels}
          onSelect={(template) => onChange({ ...settings, template })}
        />
      </div>

      <DisclosureGroup title={t("resume.typography")} summary={typographySummary}>
        <SelectRow
          id={`${ID_PREFIX}-font`}
          label={t("resume.font")}
          value={settings.font}
          labels={PDF_FONT_LABELS}
          onSelect={(font) => onChange({ ...settings, font })}
        />
        <StepperRow
          idPrefix={ID_PREFIX}
          field="fontSize"
          value={settings.fontSize}
          onCommit={setNumber("fontSize")}
        />
        <StepperRow
          idPrefix={ID_PREFIX}
          field="lineHeight"
          value={settings.lineHeight}
          onCommit={setNumber("lineHeight")}
        />
      </DisclosureGroup>

      <DisclosureGroup title={t("resume.layout")} summary={layoutSummary}>
        <StepperRow
          idPrefix={ID_PREFIX}
          field="marginVertical"
          value={settings.marginVertical}
          onCommit={setNumber("marginVertical")}
        />
        <StepperRow
          idPrefix={ID_PREFIX}
          field="marginHorizontal"
          value={settings.marginHorizontal}
          onCommit={setNumber("marginHorizontal")}
        />
        <StepperRow
          idPrefix={ID_PREFIX}
          field="sectionSpacing"
          value={settings.sectionSpacing}
          onCommit={setNumber("sectionSpacing")}
        />
        <StepperRow
          idPrefix={ID_PREFIX}
          field="entrySpacing"
          value={settings.entrySpacing}
          onCommit={setNumber("entrySpacing")}
        />
      </DisclosureGroup>

      {onReset && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onReset}
            disabled={isDefault}
          >
            {t("resume.resetToDefaults")}
          </Button>
        </div>
      )}
    </div>
  );
}

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
import type {
  CoverLetterExportSettings,
  CoverLetterNumericSetting,
} from "@/models/coverLetterExport.model";
import { useI18n } from "@/i18n";

type CoverLetterSettingsPanelProps = {
  settings: CoverLetterExportSettings;
  onChange: (settings: CoverLetterExportSettings) => void;
  onReset?: () => void;
  isDefault?: boolean;
  /** False once the lookup has resolved and found no contact info. */
  hasLetterhead: boolean;
};

const ID_PREFIX = "cover-letter-export";

export function CoverLetterSettingsPanel({
  settings,
  onChange,
  onReset,
  isDefault,
  hasLetterhead,
}: CoverLetterSettingsPanelProps) {
  const { t } = useI18n();
  const setNumber = (field: CoverLetterNumericSetting) => (value: number) =>
    onChange({ ...settings, [field]: value });

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
    t("resume.ptParagraphs", { value: settings.paragraphSpacing }),
  ].join(" • ");

  return (
    <div className="flex flex-col gap-4">
      {/* No Template row: a cover letter has exactly one style. */}
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
          field="paragraphSpacing"
          value={settings.paragraphSpacing}
          onCommit={setNumber("paragraphSpacing")}
        />
      </DisclosureGroup>

      {/* A page with no name on it otherwise reads as a bug, and the fix is
          not discoverable from this dialog. */}
      {!hasLetterhead && (
        <p className="text-xs text-muted-foreground">
          {t("resume.noLetterhead")}
        </p>
      )}

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

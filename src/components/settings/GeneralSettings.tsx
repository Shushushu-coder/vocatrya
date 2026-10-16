"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { useI18n } from "@/i18n";
import type { Locale } from "@/i18n";

// Application-level preferences. The locale switch used to live in the app
// header; it persists via I18nContext (cookie + localStorage) and applies to
// UI chrome only — user-entered business data is never re-rendered away.
function GeneralSettings() {
  const { locale, setLocale, t } = useI18n();

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-lg font-medium">{t("settings.general")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("settings.generalDescription")}
        </p>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium leading-none">
          {t("settings.language")}
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.languageDescription")}
        </p>
        <Select
          value={locale}
          onValueChange={(value) => setLocale(value as Locale)}
        >
          <SelectTrigger
            className="w-56"
            aria-label={t("settings.language")}
            data-testid="settings-language-select"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zh-CN">简体中文</SelectItem>
            <SelectItem value="en">English</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

export default GeneralSettings;

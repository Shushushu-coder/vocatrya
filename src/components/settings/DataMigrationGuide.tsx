"use client";

import { useEffect, useState } from "react";
import { Check, Lock } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { useI18n } from "@/i18n";
import { isDesktopShell } from "../desktop/desktopShell";

const STEP_KEYS = [
  "settings.migrationStep1",
  "settings.migrationStep2",
  "settings.migrationStep3",
  "settings.migrationStep4",
] as const;

export default function DataMigrationGuide() {
  const { t } = useI18n();
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    setDesktop(isDesktopShell());
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg font-medium">
          {t("settings.migrationTitle")}
        </CardTitle>
        <CardDescription>
          {t("settings.migrationDescription")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <ol className="space-y-2.5">
          {STEP_KEYS.map((key, index) => (
            <li key={key} className="flex items-start gap-3 text-sm">
              <span
                aria-hidden
                className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary"
              >
                {index + 1}
              </span>
              <span>{t(key)}</span>
            </li>
          ))}
        </ol>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5 rounded-md border p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Check className="h-4 w-4 text-green-600 dark:text-green-500" />
              {t("settings.migrationIncludedLabel")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("settings.migrationIncludedDetail")}
            </p>
          </div>
          <div className="space-y-1.5 rounded-md border p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Lock className="h-4 w-4" />
              {t("settings.migrationExcludedLabel")}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("settings.migrationExcludedDetail")}
            </p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("settings.migrationSensitiveHint")}
        </p>
        {desktop && (
          <p className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground">
            {t("settings.migrationDesktopLocationNote")}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

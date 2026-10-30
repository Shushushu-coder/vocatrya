"use client";

import { useState, type ReactNode } from "react";
import { useI18n } from "@/i18n";
import {
  updateInputPreferences,
  useInputPreferences,
  type EditEntryStrategy,
  type EnterBehavior,
  type HintMode,
  type InputPreferences,
} from "@/lib/inputPreferences";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";

function SettingRow({
  name,
  description,
  aside,
}: {
  name: string;
  description: string;
  aside: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium leading-none break-words">
          {name}
        </div>
        <p className="mt-1 text-sm text-muted-foreground break-words">
          {description}
        </p>
      </div>
      <div className="shrink-0">{aside}</div>
    </div>
  );
}

const ENTER_BEHAVIORS: readonly EnterBehavior[] = ["newline", "next"];
const EDIT_ENTRIES: readonly EditEntryStrategy[] = [
  "click",
  "end",
  "select-all",
];
const HINT_MODES: readonly HintMode[] = ["always", "focus", "off"];

// SET-INPUT-PREFERENCES: the four device-local input preferences. Values
// persist under a single localStorage snapshot and mounted fields react via
// the change event, so edits apply without a restart.
export default function InputPreferencesSettings() {
  const { t } = useI18n();
  const prefs = useInputPreferences();
  const [saveError, setSaveError] = useState(false);
  function update(patch: Partial<InputPreferences>) {
    try {
      updateInputPreferences(patch);
      setSaveError(false);
    } catch {
      setSaveError(true);
    }
  }

  return (
    <div className="space-y-4" data-testid="input-prefs-settings">
      <div>
        <h3 className="text-lg font-medium">{t("inputPrefs.title")}</h3>
        <p className="text-sm text-muted-foreground break-words">
          {t("inputPrefs.description")}
        </p>
      </div>

      {saveError && (
        <p role="alert" className="text-sm text-destructive">
          {t("inputPrefs.saveFailed")}
        </p>
      )}
      <div className="divide-y">
        <SettingRow
          name={t("inputPrefs.enterBehavior")}
          description={t("inputPrefs.enterBehaviorDescription")}
          aside={
            <Select
              value={prefs.enterBehavior}
              onValueChange={(v) =>
                update({
                  enterBehavior: v as EnterBehavior,
                })
              }
            >
              <SelectTrigger
                className="w-44"
                aria-label={t("inputPrefs.enterBehavior")}
                data-testid="input-prefs-enter"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENTER_BEHAVIORS.map((v) => (
                  <SelectItem
                    key={v}
                    value={v}
                    data-testid={`input-prefs-enter-${v}`}
                  >
                    {v === "newline"
                      ? t("inputPrefs.enterNewline")
                      : t("inputPrefs.enterNext")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          name={t("inputPrefs.editEntry")}
          description={t("inputPrefs.editEntryDescription")}
          aside={
            <Select
              value={prefs.editEntry}
              onValueChange={(v) =>
                update({ editEntry: v as EditEntryStrategy })
              }
            >
              <SelectTrigger
                className="w-44"
                aria-label={t("inputPrefs.editEntry")}
                data-testid="input-prefs-entry"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EDIT_ENTRIES.map((v) => (
                  <SelectItem
                    key={v}
                    value={v}
                    data-testid={`input-prefs-entry-${v}`}
                  >
                    {v === "click"
                      ? t("inputPrefs.entryClick")
                      : v === "end"
                        ? t("inputPrefs.entryEnd")
                        : t("inputPrefs.entrySelectAll")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          name={t("inputPrefs.hints")}
          description={t("inputPrefs.hintsDescription")}
          aside={
            <Select
              value={prefs.hintMode}
              onValueChange={(v) =>
                update({ hintMode: v as HintMode })
              }
            >
              <SelectTrigger
                className="w-44"
                aria-label={t("inputPrefs.hints")}
                data-testid="input-prefs-hints"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {HINT_MODES.map((v) => (
                  <SelectItem
                    key={v}
                    value={v}
                    data-testid={`input-prefs-hints-${v}`}
                  >
                    {v === "always"
                      ? t("inputPrefs.hintsAlways")
                      : v === "focus"
                        ? t("inputPrefs.hintsOnFocus")
                        : t("inputPrefs.hintsOff")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          name={t("inputPrefs.autoFocus")}
          description={t("inputPrefs.autoFocusDescription")}
          aside={
            <Switch
              checked={prefs.autoFocus}
              onCheckedChange={(checked) =>
                update({ autoFocus: checked })
              }
              aria-label={t("inputPrefs.autoFocus")}
              data-testid="input-prefs-autofocus"
            />
          }
        />
      </div>

      <div
        className="rounded-md border p-3 text-xs text-muted-foreground"
        data-testid="input-prefs-footer"
      >
        <div>{t("inputPrefs.footerKeys")}</div>
        <div>{t("inputPrefs.footerIme")}</div>
        <div>
          {prefs.enterBehavior === "next"
            ? t("inputPrefs.footerEnterNext")
            : t("inputPrefs.footerEnterNewline")}
        </div>
      </div>
    </div>
  );
}

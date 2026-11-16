"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { toastError } from "@/lib/toast";
import { useTheme } from "next-themes";
import { Check, Loader2 } from "lucide-react";
import {
  getUserSettings,
  updateDisplaySettings,
} from "@/actions/userSettings.actions";
import { useI18n } from "@/i18n";
import {
  SaveStatusProvider,
  useSaveStatus,
} from "@/context/SaveStatusContext";
import { SaveStatusIndicator } from "@/components/SaveStatusIndicator";
import { cn } from "@/lib/utils";
import type { DisplaySettings as DisplaySettingsData } from "@/models/userSettings.model";

type ThemeValue = DisplaySettingsData["theme"];

const THEME_OPTIONS: { value: ThemeValue; labelKey: string }[] = [
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "system", labelKey: "settings.themeSystem" },
];

function isThemeValue(value: unknown): value is ThemeValue {
  return (
    value === "light" || value === "dark" || value === "system"
  );
}

// The page-scoped provider keeps this card's save status independent from the
// dashboard-wide SaveStatusContext used by the resume workspace — the same
// semantics (stale completions never downgrade a newer in-flight save, "saved"
// fades on its own, failures stay visible) without cross-surface bleed.
export default function DisplaySettings() {
  return (
    <SaveStatusProvider>
      <DisplaySettingsPanel />
    </SaveStatusProvider>
  );
}

function DisplaySettingsPanel() {
  const { t } = useI18n();
  const { setTheme, theme, systemTheme } = useTheme();
  const { begin, finish } = useSaveStatus();
  const [isLoading, setIsLoading] = useState(true);
  const [selected, setSelected] = useState<ThemeValue>("system");

  // `confirmed` is the last value the server actually persisted; `selection`
  // is what is applied right now. They diverge while a save is in flight and
  // again after a failed save rolls back to the confirmed value.
  const confirmedRef = useRef<ThemeValue>("system");
  const selectionRef = useRef<ThemeValue>("system");
  const pendingIntentRef = useRef<ThemeValue | null>(null);
  const pumpingRef = useRef(false);
  const setThemeRef = useRef(setTheme);
  setThemeRef.current = setTheme;
  const tRef = useRef(t);
  tRef.current = t;

  const applyTheme = useCallback((value: ThemeValue) => {
    selectionRef.current = value;
    setSelected(value);
    setThemeRef.current(value);
  }, []);

  // Saves run strictly serial and coalesce to the latest intent: a parallel
  // fire-and-forget could let an older request be the last write the DB
  // completes, leaving persisted state behind the user's actual choice.
  const queueSave = useCallback(() => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    void (async () => {
      try {
        while (pendingIntentRef.current !== null) {
          const intent = pendingIntentRef.current;
          pendingIntentRef.current = null;
          const seq = begin();
          let persisted = false;
          try {
            const result = await updateDisplaySettings({ theme: intent });
            // "Saved" requires the persisted document to echo the intent back —
            // a local state change or a bare success flag alone is not proof.
            persisted =
              result?.success === true &&
              result?.data?.settings?.display?.theme === intent;
          } catch (error) {
            console.error("Error saving display settings:", error);
          }
          finish(seq, persisted);
          if (persisted) {
            confirmedRef.current = intent;
          } else {
            toastError(tRef.current("settings.saveDisplayFailed"));
            // Roll back only when the failed intent is still what the user is
            // looking at. A newer queued selection wins over this stale
            // failure and must not be reverted underneath them. Restoring the
            // confirmed value through setTheme also rolls the native window
            // theme back via the provider's existing bridge sync.
            if (
              pendingIntentRef.current === null &&
              selectionRef.current === intent
            ) {
              applyTheme(confirmedRef.current);
            }
          }
        }
      } finally {
        pumpingRef.current = false;
      }
    })();
  }, [applyTheme, begin, finish]);

  const handleSelect = useCallback(
    (value: string) => {
      if (!isThemeValue(value)) return;
      // Re-selecting what is already applied needs no write: the value is
      // either confirmed or its save is already in flight.
      if (value === selectionRef.current && pendingIntentRef.current === null) {
        return;
      }
      applyTheme(value);
      pendingIntentRef.current = value;
      queueSave();
    },
    [applyTheme, queueSave],
  );

  useEffect(() => {
    let cancelled = false;
    const fetchSettings = async () => {
      setIsLoading(true);
      try {
        const result = await getUserSettings();
        const savedTheme = result?.data?.settings?.display?.theme;
        // display.theme is the only authority: when the read yields a valid
        // value it overrides whatever next-themes cached locally.
        if (result?.success && isThemeValue(savedTheme)) {
          if (cancelled) return;
          confirmedRef.current = savedTheme;
          applyTheme(savedTheme);
        } else if (isThemeValue(theme)) {
          if (cancelled) return;
          confirmedRef.current = theme;
          applyTheme(theme);
        }
      } catch (error) {
        console.error("Error fetching display settings:", error);
        if (!cancelled && isThemeValue(theme)) {
          confirmedRef.current = theme;
          applyTheme(theme);
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchSettings();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">{t("settings.appearance")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("settings.appearanceDescription")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("settings.loadingSettings")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div>
          <h3 className="text-lg font-medium">{t("settings.appearance")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("settings.appearanceDescription")}
          </p>
        </div>
        <SaveStatusIndicator />
      </div>
      <div className="@container">
        <div className="space-y-1">
          <p className="text-sm font-medium leading-none">
            {t("settings.theme")}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("settings.selectThemeDescription")}
          </p>
          <RadioGroup
            value={selected}
            onValueChange={handleSelect}
            className="grid max-w-lg @md:grid-cols-3 gap-8 pt-2"
          >
            {THEME_OPTIONS.map(({ value, labelKey }) => (
              <label
                key={value}
                className="relative block cursor-pointer font-normal [&:has([data-state=checked])>div]:border-primary"
              >
                <RadioGroupItem
                  value={value}
                  aria-label={t(labelKey)}
                  className="sr-only"
                />
                {value === "system" ? (
                  systemTheme === "dark" ? (
                    <DarkThemeElement />
                  ) : (
                    <LightThemeElement />
                  )
                ) : value === "dark" ? (
                  <DarkThemeElement />
                ) : (
                  <LightThemeElement />
                )}
                <span className="block w-full p-2 text-center">
                  {t(labelKey)}
                </span>
                {selected === value && (
                  <span
                    className={cn(
                      "absolute right-2 top-2 flex h-5 w-5 items-center justify-center",
                      "rounded-full bg-primary text-primary-foreground shadow-sm",
                    )}
                  >
                    <Check className="h-3 w-3" aria-hidden="true" />
                  </span>
                )}
              </label>
            ))}
          </RadioGroup>
        </div>
      </div>
    </div>
  );
}

function LightThemeElement() {
  return (
    <div className="cursor-pointer items-center rounded-md border-2 border-muted p-1 hover:border-accent">
      <div className="space-y-2 rounded-sm bg-[#ecedef] p-2">
        <div className="space-y-2 rounded-md bg-white p-2 shadow-xs">
          <div className="h-2 w-4/5 rounded-lg bg-[#ecedef]" />
          <div className="h-2 w-full rounded-lg bg-[#ecedef]" />
        </div>
        <div className="flex items-center space-x-2 rounded-md bg-white p-2 shadow-xs">
          <div className="h-4 w-4 rounded-full bg-[#ecedef]" />
          <div className="h-2 w-full rounded-lg bg-[#ecedef]" />
        </div>
        <div className="flex items-center space-x-2 rounded-md bg-white p-2 shadow-xs">
          <div className="h-4 w-4 rounded-full bg-[#ecedef]" />
          <div className="h-2 w-full rounded-lg bg-[#ecedef]" />
        </div>
      </div>
    </div>
  );
}
function DarkThemeElement() {
  return (
    <div className="cursor-pointer items-center rounded-md border-2 border-muted bg-popover p-1 hover:bg-accent hover:text-accent-foreground">
      <div className="space-y-2 rounded-sm bg-zinc-950 p-2">
        <div className="space-y-2 rounded-md bg-zinc-800 p-2 shadow-xs">
          <div className="h-2 w-4/5 rounded-lg bg-zinc-400" />
          <div className="h-2 w-full rounded-lg bg-zinc-400" />
        </div>
        <div className="flex items-center space-x-2 rounded-md bg-zinc-800 p-2 shadow-xs">
          <div className="h-4 w-4 rounded-full bg-zinc-400" />
          <div className="h-2 w-full rounded-lg bg-zinc-400" />
        </div>
        <div className="flex items-center space-x-2 rounded-md bg-zinc-800 p-2 shadow-xs">
          <div className="h-4 w-4 rounded-full bg-zinc-400" />
          <div className="h-2 w-full rounded-lg bg-zinc-400" />
        </div>
      </div>
    </div>
  );
}

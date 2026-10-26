"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { toastError } from "@/lib/toast";
import {
  getUserSettings,
  updateSettingsLocale,
} from "@/actions/userSettings.actions";
import { useI18n } from "@/i18n";
import { isValidLocale, type Locale } from "@/i18n";
import {
  SaveStatusProvider,
  useSaveStatus,
} from "@/context/SaveStatusContext";
import { SaveStatusIndicator } from "@/components/SaveStatusIndicator";
import DesktopPreferencesSettings from "@/components/settings/DesktopPreferencesSettings";

// Application-level preferences. Selecting a language applies instantly
// through I18nContext (state + cookie + localStorage + refresh) and, for
// signed-in users, additionally persists to the account-level
// settings.general.locale through the C-01.P atomic patch path
// (updateSettingsLocale). The page-scoped provider keeps this card's save
// status independent from other surfaces — same semantics as
// DisplaySettings.
function GeneralSettings() {
  return (
    <SaveStatusProvider>
      <GeneralSettingsPanel />
    </SaveStatusProvider>
  );
}

function GeneralSettingsPanel() {
  const { locale, setLocale, t } = useI18n();
  const { begin, finish } = useSaveStatus();
  const [isLoading, setIsLoading] = useState(true);

  // `confirmed` is the last locale the server actually persisted;
  // `selection` mirrors what is applied right now. They diverge while a save
  // is in flight and again after a failed save rolls back to confirmed.
  const confirmedRef = useRef<Locale>(locale);
  const selectionRef = useRef<Locale>(locale);
  const pendingIntentRef = useRef<Locale | null>(null);
  const pumpingRef = useRef(false);
  const setLocaleRef = useRef(setLocale);
  setLocaleRef.current = setLocale;
  const tRef = useRef(t);
  tRef.current = t;

  // The provider-level account reconcile and any other locale writer apply
  // through the same context — keep the selection mirror honest so a stale
  // failure never rolls back an externally applied value.
  useEffect(() => {
    selectionRef.current = locale;
  }, [locale]);

  const applyLocale = useCallback((value: Locale) => {
    selectionRef.current = value;
    setLocaleRef.current(value);
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
            const result = await updateSettingsLocale(intent);
            // "Saved" requires the persisted document to echo the intent
            // back — a bare success flag alone is not proof.
            persisted =
              result?.success === true &&
              result?.data?.settings?.settings?.general?.locale === intent;
          } catch (error) {
            console.error("Error saving general settings:", error);
          }
          finish(seq, persisted);
          if (persisted) {
            confirmedRef.current = intent;
          } else {
            toastError(tRef.current("common.saveFailed"));
            // Roll back only when the failed intent is still what the user
            // is looking at. A newer queued selection wins over this stale
            // failure and must not be reverted underneath them; restoring
            // through setLocale rolls cookie/localStorage back in step.
            if (
              pendingIntentRef.current === null &&
              selectionRef.current === intent
            ) {
              applyLocale(confirmedRef.current);
            }
          }
        }
      } finally {
        pumpingRef.current = false;
      }
    })();
  }, [applyLocale, begin, finish]);

  const handleSelect = useCallback(
    (value: string) => {
      if (!isValidLocale(value)) return;
      // Re-selecting what is already applied needs no write: the value is
      // either confirmed or its save is already in flight.
      if (
        value === selectionRef.current &&
        pendingIntentRef.current === null
      ) {
        return;
      }
      applyLocale(value);
      pendingIntentRef.current = value;
      queueSave();
    },
    [applyLocale, queueSave],
  );

  useEffect(() => {
    let cancelled = false;
    const readBaseline = selectionRef.current;
    const fetchSettings = async () => {
      setIsLoading(true);
      try {
        const result = await getUserSettings();
        const persistedLocale =
          result?.data?.settings?.settings?.general?.locale;
        if (cancelled) return;
        if (result?.success === true && isValidLocale(persistedLocale)) {
          confirmedRef.current = persistedLocale;
          // Reconcile only when the user has not moved on since the read
          // started — a late read must never override a fresher choice.
          // The provider-level reconcile converges on the same document, so
          // applying here is idempotent.
          if (
            pendingIntentRef.current === null &&
            selectionRef.current === readBaseline &&
            persistedLocale !== readBaseline
          ) {
            applyLocale(persistedLocale);
          }
        } else {
          // Invalid or missing persisted value: whatever is already applied
          // stays the confirmed baseline without reporting an error.
          confirmedRef.current = selectionRef.current;
        }
      } catch (error) {
        console.error("Error fetching general settings:", error);
        if (!cancelled) {
          confirmedRef.current = selectionRef.current;
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchSettings();
    return () => {
      cancelled = true;
    };
  }, [applyLocale]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div>
          <h3 className="text-lg font-medium">{t("settings.general")}</h3>
          <p className="text-sm text-muted-foreground break-words">
            {t("settings.generalDescription")}
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
          <h3 className="text-lg font-medium">{t("settings.general")}</h3>
          <p className="text-sm text-muted-foreground break-words">
            {t("settings.generalDescription")}
          </p>
        </div>
        <SaveStatusIndicator />
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium leading-none break-words">
          {t("settings.language")}
        </div>
        <p className="text-sm text-muted-foreground break-words">
          {t("settings.languageDescription")}
        </p>
        <Select value={locale} onValueChange={handleSelect}>
          <SelectTrigger
            className="w-full max-w-56"
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
      {/* Device-scope desktop lifecycle preferences live in the Electron
          bridge, not the account settings document — the component renders
          its own availability state outside the desktop shell. */}
      <DesktopPreferencesSettings />
    </div>
  );
}

export default GeneralSettings;

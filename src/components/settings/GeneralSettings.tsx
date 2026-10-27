"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Button } from "../ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../ui/popover";
import { cn } from "@/lib/utils";
import { toastError } from "@/lib/toast";
import {
  getUserSettings,
  updateSettingsLocale,
  updateSettingsTimeZone,
} from "@/actions/userSettings.actions";
import {
  isSupportedTimeZone,
  listSupportedTimeZones,
  storedUserTimeZone,
  timeZoneOffsetLabel,
} from "@/lib/userSettings/timeZone";
import { runtimeTimeZone } from "@/lib/datetime";
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
// (updateSettingsLocale). The P-TZ time zone picker persists
// settings.general.timeZone through the same path; "follow system"
// writes `undefined`, which deletes the key. The page-scoped provider
// keeps this card's save status independent from other surfaces — same
// semantics as DisplaySettings.
function GeneralSettings() {
  return (
    <SaveStatusProvider>
      <GeneralSettingsPanel />
    </SaveStatusProvider>
  );
}

// One serial pump serves both preferences: locale and timeZone patch the
// same settings document, so interleaving their writes would race the
// CAS token. A discriminated intent keeps every write ordered.
type SaveIntent =
  | { kind: "locale"; value: Locale }
  | { kind: "timeZone"; value: string | undefined };

// Searchable IANA zone picker (OD-C). Options come from
// Intl.supportedValuesOf via listSupportedTimeZones — canonical IDs only,
// so every selectable value passes isSupportedTimeZone on the server.
// The first entry clears the key back to "follow system".
function TimeZoneCombobox({
  value,
  onSelect,
}: {
  value: string | undefined;
  onSelect: (zone: string | undefined) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const systemZone = useMemo(() => runtimeTimeZone(), []);
  const options = useMemo(() => {
    const now = new Date();
    return listSupportedTimeZones().map((zone) => {
      const offset = timeZoneOffsetLabel(zone, now);
      return { id: zone, label: offset ? `${zone} (${offset})` : zone };
    });
  }, []);
  const followSystemLabel = t("settings.timeZoneFollowSystem");
  const displayValue =
    value === undefined
      ? `${followSystemLabel} (${systemZone})`
      : (options.find((option) => option.id === value)?.label ?? value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={t("settings.timeZone")}
          data-testid="settings-timezone-select"
          className="w-full max-w-72 justify-between font-normal"
        >
          <span className="min-w-0 truncate">{displayValue}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-(--radix-popover-trigger-width) p-0"
        align="start"
      >
        <Command
          filter={(candidate, search) =>
            candidate.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput
            placeholder={t("settings.timeZoneSearchPlaceholder")}
            data-testid="settings-timezone-search"
          />
          <CommandList>
            <CommandEmpty>{t("settings.timeZoneNoMatch")}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={`${followSystemLabel} ${systemZone}`}
                data-testid="settings-timezone-option-system"
                onSelect={() => {
                  onSelect(undefined);
                  setOpen(false);
                }}
              >
                <Check
                  className={cn(
                    "mr-2 h-4 w-4",
                    value === undefined ? "opacity-100" : "opacity-0",
                  )}
                />
                {followSystemLabel} ({systemZone})
              </CommandItem>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={option.label}
                  data-testid={`settings-timezone-option-${option.id}`}
                  onSelect={() => {
                    onSelect(option.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value === option.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  {option.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function GeneralSettingsPanel() {
  const { locale, setLocale, t } = useI18n();
  const { begin, finish } = useSaveStatus();
  const [isLoading, setIsLoading] = useState(true);

  // `confirmed` is the last locale the server actually persisted;
  // `selection` mirrors what is applied right now. They diverge while a save
  // is in flight and again after a failed save rolls back to confirmed.
  // The timeZone pair works identically; `undefined` means "follow system".
  const confirmedRef = useRef<Locale>(locale);
  const selectionRef = useRef<Locale>(locale);
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const confirmedTzRef = useRef<string | undefined>(undefined);
  const tzSelectionRef = useRef<string | undefined>(undefined);
  const pendingIntentRef = useRef<SaveIntent[]>([]);
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

  const applyTimeZone = useCallback((value: string | undefined) => {
    tzSelectionRef.current = value;
    setTimeZone(value);
  }, []);

  // Saves run strictly serial and coalesce to the latest intent per field: a parallel
  // fire-and-forget could let an older request be the last write the DB
  // completes, leaving persisted state behind the user's actual choice.
  const queueSave = useCallback(() => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    void (async () => {
      try {
        while (pendingIntentRef.current.length > 0) {
          const intent = pendingIntentRef.current.shift()!;
          const seq = begin();
          let persisted = false;
          try {
            if (intent.kind === "locale") {
              const result = await updateSettingsLocale(intent.value);
              // "Saved" requires the persisted document to echo the intent
              // back — a bare success flag alone is not proof.
              persisted =
                result?.success === true &&
                result?.data?.settings?.settings?.general?.locale ===
                  intent.value;
            } else {
              const result = await updateSettingsTimeZone(intent.value);
              persisted =
                result?.success === true &&
                result?.data?.settings?.settings?.general?.timeZone ===
                  intent.value;
            }
          } catch (error) {
            console.error("Error saving general settings:", error);
          }
          finish(seq, persisted);
          if (persisted) {
            if (intent.kind === "locale") {
              confirmedRef.current = intent.value;
            } else {
              confirmedTzRef.current = intent.value;
            }
          } else {
            toastError(tRef.current("common.saveFailed"));
            // Roll back only when the failed intent is still what the user
            // is looking at. A newer queued selection wins over this stale
            // failure and must not be reverted underneath them; restoring
            // through setLocale rolls cookie/localStorage back in step.
            if (
              intent.kind === "locale" &&
              !pendingIntentRef.current.some((pending) => pending.kind === intent.kind) &&
              selectionRef.current === intent.value
            ) {
              applyLocale(confirmedRef.current);
            }
            if (
              intent.kind === "timeZone" &&
              !pendingIntentRef.current.some((pending) => pending.kind === intent.kind) &&
              tzSelectionRef.current === intent.value
            ) {
              applyTimeZone(confirmedTzRef.current);
            }
          }
        }
      } finally {
        pumpingRef.current = false;
      }
    })();
  }, [applyLocale, applyTimeZone, begin, finish]);

  const handleSelect = useCallback(
    (value: string) => {
      if (!isValidLocale(value)) return;
      // Re-selecting what is already applied needs no write: the value is
      // either confirmed or its save is already in flight.
      if (
        value === selectionRef.current &&
        pendingIntentRef.current.length === 0
      ) {
        return;
      }
      applyLocale(value);
      pendingIntentRef.current = pendingIntentRef.current.filter(
        (pending) => pending.kind !== "locale",
      );
      pendingIntentRef.current.push({ kind: "locale", value });
      queueSave();
    },
    [applyLocale, queueSave],
  );

  const handleSelectTimeZone = useCallback(
    (zone: string | undefined) => {
      // The picker only offers canonical IDs; this guard keeps any future
      // entry point honest too — invalid zones never apply or persist.
      if (zone !== undefined && !isSupportedTimeZone(zone)) return;
      if (
        zone === tzSelectionRef.current &&
        pendingIntentRef.current.length === 0
      ) {
        return;
      }
      applyTimeZone(zone);
      pendingIntentRef.current = pendingIntentRef.current.filter(
        (pending) => pending.kind !== "timeZone",
      );
      pendingIntentRef.current.push({ kind: "timeZone", value: zone });
      queueSave();
    },
    [applyTimeZone, queueSave],
  );

  useEffect(() => {
    let cancelled = false;
    const readBaseline = selectionRef.current;
    const tzBaseline = tzSelectionRef.current;
    const fetchSettings = async () => {
      setIsLoading(true);
      try {
        const result = await getUserSettings();
        const persistedLocale =
          result?.data?.settings?.settings?.general?.locale;
        const persistedTimeZone =
          result?.success === true
            ? (storedUserTimeZone(result?.data?.settings) ?? undefined)
            : undefined;
        if (cancelled) return;
        if (result?.success === true && isValidLocale(persistedLocale)) {
          confirmedRef.current = persistedLocale;
          // Reconcile only when the user has not moved on since the read
          // started — a late read must never override a fresher choice.
          // The provider-level reconcile converges on the same document, so
          // applying here is idempotent.
          if (
            pendingIntentRef.current.length === 0 &&
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
        if (result?.success === true) {
          // A stored value that fails isSupportedTimeZone reads back as
          // unset: the picker honestly shows "follow system" instead of
          // echoing a zone the account can no longer resolve.
          confirmedTzRef.current = persistedTimeZone;
          if (
            pendingIntentRef.current.length === 0 &&
            tzSelectionRef.current === tzBaseline &&
            persistedTimeZone !== tzBaseline
          ) {
            applyTimeZone(persistedTimeZone);
          }
        } else {
          confirmedTzRef.current = tzSelectionRef.current;
        }
      } catch (error) {
        console.error("Error fetching general settings:", error);
        if (!cancelled) {
          confirmedRef.current = selectionRef.current;
          confirmedTzRef.current = tzSelectionRef.current;
        }
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchSettings();
    return () => {
      cancelled = true;
    };
  }, [applyLocale, applyTimeZone]);

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
      <div className="space-y-2">
        <div className="text-sm font-medium leading-none break-words">
          {t("settings.timeZone")}
        </div>
        <p className="text-sm text-muted-foreground break-words">
          {t("settings.timeZoneDescription")}
        </p>
        <TimeZoneCombobox value={timeZone} onSelect={handleSelectTimeZone} />
      </div>
      {/* Device-scope desktop lifecycle preferences live in the Electron
          bridge, not the account settings document — the component renders
          its own availability state outside the desktop shell. */}
      <DesktopPreferencesSettings />
    </div>
  );
}

export default GeneralSettings;

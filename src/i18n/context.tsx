"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  LOCALE_STORAGE_KEY,
  type Locale,
  normalizeLocale,
} from "./config";
import type { I18nContextValue, TranslationParams } from "./types";
import {
  formatDate as formatWithLocale,
  formatDateTime as formatDateTimeWithLocale,
  formatMonthYear as formatMonthYearWithLocale,
  formatNumber as formatNumberWithLocale,
} from "./formatters";
import { translate } from "./translate";

const I18nContext = createContext<I18nContextValue | null>(null);

export interface I18nProviderProps {
  children: React.ReactNode;
  initialLocale?: Locale;
}

export function I18nProvider({
  children,
  initialLocale = DEFAULT_LOCALE,
}: I18nProviderProps) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const router = useRouter();

  // Cookie is the SSR source of truth. localStorage only fills in when the
  // cookie is missing so the first paint does not flash from default zh-CN.
  useEffect(() => {
    try {
      const hasCookie = document.cookie
        .split(";")
        .some((part) => part.trim().startsWith(`${LOCALE_COOKIE_NAME}=`));
      if (hasCookie) return;
      const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
      if (stored && normalizeLocale(stored) !== locale) {
        const nextLocale = normalizeLocale(stored);
        setLocaleState(nextLocale);
        document.documentElement.lang = nextLocale;
        document.cookie = `${LOCALE_COOKIE_NAME}=${nextLocale}; path=/; max-age=31536000; SameSite=Lax`;
      }
    } catch {
      // Ignore storage errors in restricted contexts
    }
    // Mount-only: cookie already applied via initialLocale.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setLocale = useCallback(
    (newLocale: Locale) => {
      const validated = normalizeLocale(newLocale);
      setLocaleState(validated);

      try {
        if (typeof document !== "undefined") {
          document.documentElement.lang = validated;
          document.cookie = `${LOCALE_COOKIE_NAME}=${validated}; path=/; max-age=31536000; SameSite=Lax`;
        }
        if (typeof localStorage !== "undefined") {
          localStorage.setItem(LOCALE_STORAGE_KEY, validated);
        }
      } catch {
        // Ignore cookie/storage errors
      }

      try {
        router?.refresh();
      } catch {
        // Ignore router refresh errors in test or SSR contexts
      }
    },
    [router]
  );

  const t = useCallback(
    (key: string, params?: TranslationParams) => translate(locale, key, params),
    [locale]
  );

  const formatDate = useCallback(
    (
      date: Date | string | number | null | undefined,
      options?: Intl.DateTimeFormatOptions
    ) => formatWithLocale(date, locale, options),
    [locale]
  );

  const formatMonthYear = useCallback(
    (date: Date | string | number | null | undefined) =>
      formatMonthYearWithLocale(date, locale),
    [locale]
  );

  const formatDateTime = useCallback(
    (
      date: Date | string | number | null | undefined,
      options?: Intl.DateTimeFormatOptions
    ) => formatDateTimeWithLocale(date, locale, options),
    [locale]
  );

  const formatNumber = useCallback(
    (
      num: number | null | undefined,
      options?: Intl.NumberFormatOptions
    ) => formatNumberWithLocale(num, locale, options),
    [locale]
  );

  const value = useMemo(
    () => ({
      locale,
      setLocale,
      t,
      formatDate,
      formatMonthYear,
      formatDateTime,
      formatNumber,
    }),
    [
      locale,
      setLocale,
      t,
      formatDate,
      formatMonthYear,
      formatDateTime,
      formatNumber,
    ]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

const FALLBACK_LOCALE: Locale = "en";

const FALLBACK_I18N: I18nContextValue = {
  locale: FALLBACK_LOCALE,
  setLocale: () => {},
  t: (key: string, params?: TranslationParams) =>
    translate(FALLBACK_LOCALE, key, params),
  formatDate: (date, options) =>
    formatWithLocale(date, FALLBACK_LOCALE, options),
  formatMonthYear: (date) => formatMonthYearWithLocale(date, FALLBACK_LOCALE),
  formatDateTime: (date, options) =>
    formatDateTimeWithLocale(date, FALLBACK_LOCALE, options),
  formatNumber: (num, options) =>
    formatNumberWithLocale(num, FALLBACK_LOCALE, options),
};

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) {
    // Production always wraps I18nProvider (default zh-CN from cookie).
    // Unwrapped usage is tests: keep English so existing assertions stay stable.
    return FALLBACK_I18N;
  }
  return context;
}

import { cookies } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  type Locale,
  normalizeLocale,
} from "./config";
import { translate } from "./translate";
import {
  formatDate as formatWithLocale,
  formatDateTime as formatDateTimeWithLocale,
  formatMonthYear as formatMonthYearWithLocale,
  formatNumber as formatNumberWithLocale,
} from "./formatters";

export async function getServerLocale(): Promise<Locale> {
  try {
    const cookieStore = await cookies();
    const cookie = cookieStore.get(LOCALE_COOKIE_NAME);
    return normalizeLocale(cookie?.value, DEFAULT_LOCALE);
  } catch {
    return DEFAULT_LOCALE;
  }
}

export async function getServerI18n() {
  const locale = await getServerLocale();
  return {
    locale,
    t: (key: string, params?: Record<string, string | number>) =>
      translate(locale, key, params),
    formatDate: (
      date: Date | string | number | null | undefined,
      options?: Intl.DateTimeFormatOptions
    ) => formatWithLocale(date, locale, options),
    formatMonthYear: (date: Date | string | number | null | undefined) =>
      formatMonthYearWithLocale(date, locale),
    formatDateTime: (
      date: Date | string | number | null | undefined,
      options?: Intl.DateTimeFormatOptions
    ) => formatDateTimeWithLocale(date, locale, options),
    formatNumber: (
      num: number | null | undefined,
      options?: Intl.NumberFormatOptions
    ) => formatNumberWithLocale(num, locale, options),
  };
}

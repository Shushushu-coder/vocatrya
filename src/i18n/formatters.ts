import type { Locale } from "./config";

export function toDate(input: Date | string | number | null | undefined): Date | null {
  if (!input) return null;
  const d = input instanceof Date ? input : new Date(input);
  return isNaN(d.getTime()) ? null : d;
}

export function formatDate(
  date: Date | string | number | null | undefined,
  locale: Locale = "zh-CN",
  options?: Intl.DateTimeFormatOptions
): string {
  const d = toDate(date);
  if (!d) return "";

  const defaultOptions: Intl.DateTimeFormatOptions =
    locale === "zh-CN"
      ? { year: "numeric", month: "long", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" };

  return new Intl.DateTimeFormat(locale, options ?? defaultOptions).format(d);
}

export function formatMonthYear(
  date: Date | string | number | null | undefined,
  locale: Locale = "zh-CN"
): string {
  const d = toDate(date);
  if (!d) return "";

  const options: Intl.DateTimeFormatOptions =
    locale === "zh-CN"
      ? { year: "numeric", month: "long" }
      : { year: "numeric", month: "short" };

  return new Intl.DateTimeFormat(locale, options).format(d);
}

export function formatDateTime(
  date: Date | string | number | null | undefined,
  locale: Locale = "zh-CN",
  options?: Intl.DateTimeFormatOptions
): string {
  const d = toDate(date);
  if (!d) return "";

  const defaultOptions: Intl.DateTimeFormatOptions =
    locale === "zh-CN"
      ? {
          year: "numeric",
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }
      : {
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        };

  return new Intl.DateTimeFormat(locale, options ?? defaultOptions).format(d);
}

export function formatNumber(
  num: number | null | undefined,
  locale: Locale = "zh-CN",
  options?: Intl.NumberFormatOptions
): string {
  if (num === null || num === undefined || isNaN(num)) return "0";
  return new Intl.NumberFormat(locale, options).format(num);
}

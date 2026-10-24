import { dateOnlyParts } from "./dateOnly";
import { requireInstantIso } from "./instant";
import type { DateOnlyString, InstantIso } from "./types";
import { assertValidTimeZone } from "./zoneMath";

/**
 * Locale-aware display helpers. Pure functions — locale is a parameter, so
 * these stay usable before the i18n host (src/i18n/formatters.ts, shared
 * ownership) is touched. Defaults mirror the existing zh-CN/en conventions.
 */

export type DateTimeLocale = "zh-CN" | "en" | (string & {});

function dateOnlyAnchor(date: DateOnlyString): Date {
  // Internal rendering anchor only — a DateOnly must reach Intl through a
  // fixed zone so every viewer sees the same calendar day. UTC midnight +
  // timeZone:"UTC" is the only safe anchor; this Date never escapes.
  const { year, month, day } = dateOnlyParts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

/** Format a calendar date identically in every timezone. */
export function formatDateOnly(
  date: DateOnlyString,
  locale: DateTimeLocale = "zh-CN",
  options?: Intl.DateTimeFormatOptions,
): string {
  const anchor = dateOnlyAnchor(date);
  const defaults: Intl.DateTimeFormatOptions =
    locale === "zh-CN"
      ? { year: "numeric", month: "long", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale, {
    ...defaults,
    ...options,
    timeZone: "UTC",
  }).format(anchor);
}

/**
 * Format an instant. `timeZone` selects the viewing zone; without it the
 * runtime zone is used — matching how the app renders instants today, while
 * making the dependency explicit at the call site.
 */
export function formatInstant(
  iso: InstantIso,
  locale: DateTimeLocale = "zh-CN",
  timeZone?: string,
  options?: Intl.DateTimeFormatOptions,
): string {
  const checked = requireInstantIso(iso);
  if (timeZone !== undefined) assertValidTimeZone(timeZone);
  const defaults: Intl.DateTimeFormatOptions =
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
  return new Intl.DateTimeFormat(locale, {
    ...defaults,
    ...options,
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(checked));
}

/** Month-Year rendering for a DateOnly (resume-style fields). */
export function formatDateOnlyMonthYear(
  date: DateOnlyString,
  locale: DateTimeLocale = "zh-CN",
): string {
  const anchor = dateOnlyAnchor(date);
  const options: Intl.DateTimeFormatOptions =
    locale === "zh-CN"
      ? { year: "numeric", month: "long", timeZone: "UTC" }
      : { year: "numeric", month: "short", timeZone: "UTC" };
  return new Intl.DateTimeFormat(locale, options).format(anchor);
}

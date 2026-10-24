import type { DateOnlyParts, DateOnlyString } from "./types";
import { DateTimeContractError } from "./types";
import { wallPartsInZone } from "./zoneMath";

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAY_MS = 24 * 60 * 60 * 1000;

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  // Validating through the UTC timeline keeps the check immune to the
  // runtime timezone: a DateOnly must never round through a local Date.
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

export function isDateOnly(input: unknown): input is DateOnlyString {
  if (typeof input !== "string") return false;
  const m = DATE_ONLY_RE.exec(input);
  return m !== null && isRealCalendarDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Strict `YYYY-MM-DD` parse. Returns null on any shape deviation or impossible
 * calendar date — callers map null to their own validation error.
 */
export function parseDateOnly(input: unknown): DateOnlyString | null {
  return isDateOnly(input) ? input : null;
}

/** Same as parseDateOnly but throws `DATETIME_INVALID_DATE_ONLY`. */
export function requireDateOnly(input: unknown): DateOnlyString {
  const parsed = parseDateOnly(input);
  if (parsed === null) {
    throw new DateTimeContractError(
      "DATETIME_INVALID_DATE_ONLY",
      `Expected a real YYYY-MM-DD calendar date, received ${JSON.stringify(input)}`,
    );
  }
  return parsed;
}

export function dateOnlyParts(date: DateOnlyString): DateOnlyParts {
  const checked = requireDateOnly(date);
  return {
    year: Number(checked.slice(0, 4)),
    month: Number(checked.slice(5, 7)),
    day: Number(checked.slice(8, 10)),
  };
}

/** Ordinal day number (UTC-millis / day) usable for +N day arithmetic. */
export function dateOnlyToEpochDay(date: DateOnlyString): number {
  const { year, month, day } = dateOnlyParts(date);
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function epochDayToDateOnly(epochDay: number): DateOnlyString {
  const d = new Date(epochDay * DAY_MS);
  return formatUtcParts(
    d.getUTCFullYear(),
    d.getUTCMonth() + 1,
    d.getUTCDate(),
  );
}

export function addDaysToDateOnly(date: DateOnlyString, days: number): DateOnlyString {
  return epochDayToDateOnly(dateOnlyToEpochDay(date) + days);
}

export function compareDateOnly(a: DateOnlyString, b: DateOnlyString): number {
  const pa = dateOnlyToEpochDay(a);
  const pb = dateOnlyToEpochDay(b);
  return pa === pb ? 0 : pa < pb ? -1 : 1;
}

export function formatUtcParts(year: number, month: number, day: number): DateOnlyString {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${String(year).padStart(4, "0")}-${pad(month)}-${pad(day)}`;
}

/**
 * The calendar day "today" in a zone, derived from Intl so the result does not
 * depend on how the host constructs Dates.
 */
export function todayDateOnly(timeZone: string, now: Date = new Date()): DateOnlyString {
  const parts = wallPartsInZone(now.getTime(), timeZone);
  return formatUtcParts(parts.year, parts.month, parts.day);
}


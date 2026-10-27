import { requireDateOnly } from "./dateOnly";
import { formatDateOnly, formatInstant, type DateTimeLocale } from "./format";
import { requireInstantIso, toInstantIso } from "./instant";
import type {
  BusinessTimeValue,
  InstantIso,
} from "./types";
import { DateTimeContractError } from "./types";
import { dateOnlyUtcWindow } from "./zoned";
import { assertValidTimeZone } from "./zoneMath";

/**
 * Consumer-facing helpers for the paired `*On` / instant / precision column
 * triples (ApplicationProcessStep deadline, JobOpportunity deadline,
 * Task due). Pure functions — callers resolve the account time zone once at
 * their entry point and pass it explicitly.
 */

export type BusinessTimeColumns = {
  /** TEXT column carrying "YYYY-MM-DD" (deadlineOn / dueOn), null when unset. */
  dateOnly: string | null | undefined;
  /** Instant carrier (deadlineAt / deadline / dueDate): Date or ISO string. */
  instant: Date | string | null | undefined;
  /** Declared precision sidecar; NULL/invalid means "unknown" for instants. */
  precision: string | null | undefined;
};

/**
 * Deterministic row -> BusinessTimeValue rule (frozen contract §3.2):
 * 1. `*On` present + precision "dateOnly" + valid calendar date -> dateOnly.
 * 2. Otherwise an instant value wins — including the contradictory
 *    `*On` + instant pair whose precision does not declare dateOnly
 *    (the instant stays the historical fact; nothing is repaired).
 * 3. Without a declared DateOnly or an instant, return null. A lone `*On`
 *    never establishes precision by itself. Invalid declared DateOnly text
 *    raises a data error; undeclared/shadowed text is not interpreted.
 */
export function businessTimeFromColumns(
  input: BusinessTimeColumns,
): BusinessTimeValue | null {
  const on = input.dateOnly ?? null;
  const at = input.instant ?? null;
  if (on !== null && input.precision === "dateOnly") {
    return { kind: "dateOnly", date: requireDateOnly(on) };
  }
  if (at !== null) {
    const iso = at instanceof Date ? toInstantIso(at) : requireInstantIso(at);
    const declared = input.precision;
    return {
      kind: "instant",
      iso,
      precision:
        declared === "minute" || declared === "fullInstant"
          ? declared
          : "unknown",
    };
  }
  return null;
}

/**
 * Representative instant used for attention sorting/prompts: a dateOnly is
 * worth attention from the *start* of its calendar day in `timeZone`.
 */
export function businessTimeAttentionIso(
  value: BusinessTimeValue | null,
  timeZone: string,
): InstantIso | null {
  if (value === null) return null;
  if (value.kind === "dateOnly") {
    return dateOnlyUtcWindow(value.date, timeZone).startIso;
  }
  return value.iso;
}

/**
 * Due-sorting key (contract §5.2): a dateOnly ranks at the *end* of its
 * calendar day in `timeZone` so same-day timed instants sort first. NULL
 * values return null and must be sorted last by the caller.
 */
export function businessTimeDueSortKey(
  value: BusinessTimeValue | null,
  timeZone: string,
): InstantIso | null {
  if (value === null) return null;
  if (value.kind === "dateOnly") {
    return dateOnlyUtcWindow(value.date, timeZone).endIsoExclusive;
  }
  return value.iso;
}

/**
 * Unified display dispatch (contract §6.2):
 * - dateOnly -> formatDateOnly (UTC anchor, never drifts)
 * - instant with declared precision -> date + time in `timeZone`
 * - instant with unknown precision -> date part only in `timeZone`
 *   (a historical midnight must not render a fake "00:00")
 */
export function formatBusinessTime(
  value: BusinessTimeValue | null,
  locale: DateTimeLocale,
  timeZone: string,
): string {
  if (value === null) return "";
  assertValidTimeZone(timeZone);
  if (value.kind === "dateOnly") {
    return formatDateOnly(value.date, locale);
  }
  if (value.precision === "unknown") {
    const dateOnlyOptions: Intl.DateTimeFormatOptions =
      locale === "zh-CN"
        ? {
            year: "numeric",
            month: "long",
            day: "numeric",
            hour: undefined,
            minute: undefined,
          }
        : {
            year: "numeric",
            month: "short",
            day: "numeric",
            hour: undefined,
            minute: undefined,
          };
    return formatInstant(value.iso, locale, timeZone, dateOnlyOptions);
  }
  return formatInstant(value.iso, locale, timeZone);
}

/**
 * Inverse of `parseTimeOfDay12h`: renders integer hour/minute as the
 * "hh:mm AM" wire form the TimePicker edits. Used to backfill edit forms
 * with a stored instant's wall time without inventing precision.
 */
export function formatTimeOfDay12h(hour: number, minute: number): string {
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(minute) ||
    hour < 0 ||
    hour > 23 ||
    minute < 0 ||
    minute > 59
  ) {
    throw new DateTimeContractError(
      "DATETIME_INVALID_WALL_TIME",
      `Time-of-day must be integer hour 0-23 / minute 0-59, received ${hour}:${minute}`,
    );
  }
  const meridiem = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${String(hour12).padStart(2, "0")}:${String(minute).padStart(2, "0")} ${meridiem}`;
}

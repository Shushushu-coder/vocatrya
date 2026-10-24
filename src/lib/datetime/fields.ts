import { isDateOnly, parseDateOnly, requireDateOnly } from "./dateOnly";
import {
  isOnMinuteBoundary,
  isUtcMidnight,
  parseInstantIso,
  toInstantIso,
} from "./instant";
import type {
  BusinessTimeValue,
  DateOnlyString,
  InstantIso,
  WallTime,
} from "./types";
import { DateTimeContractError } from "./types";
import { dateOnlyUtcWindow, wallTimeToInstant } from "./zoned";
import { runtimeTimeZone } from "./zoneMath";

/**
 * Business-field contracts (contract section E). These functions are the only
 * sanctioned way to turn user input into the three process-step time fields,
 * and to turn stored values back into display/compare semantics.
 */

export const BUSINESS_TIME_FIELD = {
  scheduledAt: "scheduledAt",
  deadlineAt: "deadlineAt",
  completedAt: "completedAt",
} as const;

export type BusinessTimeField =
  (typeof BUSINESS_TIME_FIELD)[keyof typeof BUSINESS_TIME_FIELD];

/** What each field accepts and means — mirrors the contract table. */
export const FIELD_TIME_CONTRACT = {
  scheduledAt: {
    kind: "datetime" as const,
    inputPrecision: "minute" as const,
    description: "planned wall-clock time; requires an explicit zone",
  },
  deadlineAt: {
    kind: "dateOnlyOrDatetime" as const,
    inputPrecision: "dateOnly" as const,
    description:
      "a due day (dateOnly, interval semantics) or a due moment (minute)",
  },
  completedAt: {
    kind: "instant" as const,
    inputPrecision: "fullInstant" as const,
    description: "system-recorded completion fact; server clock only",
  },
} as const;

// ---------------------------------------------------------------------------
// Write path — input → BusinessTimeValue
// ---------------------------------------------------------------------------

/**
 * scheduledAt: wall-clock intent at minute precision. A bare calendar date is
 * rejected — "scheduled" without a time is not representable without faking
 * a time-of-day.
 */
export function parseScheduledAtInput(
  wall: WallTime,
  timeZone: string,
): BusinessTimeValue {
  const resolved = wallTimeToInstant(wall, timeZone);
  return { kind: "instant", iso: resolved.iso, precision: "minute" };
}

/**
 * deadlineAt: a dateOnly keeps interval semantics ("the whole calendar day");
 * a wall time becomes a minute-precision instant. Never produces a faked
 * 23:59/00:00 instant for a date-only deadline.
 */
export function parseDeadlineAtInput(
  input: DateOnlyString | WallTime,
  timeZone: string,
): BusinessTimeValue {
  if (typeof input === "string") {
    return { kind: "dateOnly", date: requireDateOnly(input) };
  }
  const resolved = wallTimeToInstant(input, timeZone);
  return { kind: "instant", iso: resolved.iso, precision: "minute" };
}

/**
 * completedAt: a system fact. The only legitimate writer is the server clock;
 * callers may pass a clock for tests. Precision stays full — system facts are
 * not truncated to minutes.
 */
export function completedAtNow(now: Date = new Date()): BusinessTimeValue {
  return { kind: "instant", iso: toInstantIso(now), precision: "fullInstant" };
}

// ---------------------------------------------------------------------------
// Read path — stored value → typed boundary value
// ---------------------------------------------------------------------------

export type StoredInstantClassification = {
  /** "absent" (null) is a known fact: nothing was recorded. Distinct from
   *  "instant with unknown precision". */
  kind: "absent" | "instant";
  iso: InstantIso | null;
  /** Historical values carry no declared precision — always "unknown". */
  precision: "unknown";
  /** Informational markers only. `utcMidnight` means the value *might* be a
   *  fabricated date-only write; a real midnight event looks identical, so
   *  this must never be used to re-interpret the value. */
  utcMidnight: boolean;
  onMinuteBoundary: boolean;
};

/**
 * Classify a stored DATETIME without changing its semantics: every stored
 * non-null value stays an instant of unknown precision. We only attach
 * informational markers for audit/migration decisions.
 */
export function classifyStoredInstant(
  value: Date | string | null | undefined,
): StoredInstantClassification {
  if (value === null || value === undefined) {
    return {
      kind: "absent",
      iso: null,
      precision: "unknown",
      utcMidnight: false,
      onMinuteBoundary: false,
    };
  }
  const iso =
    value instanceof Date ? toInstantIso(value) : parseInstantIso(value);
  if (iso === null) {
    throw new DateTimeContractError(
      "DATETIME_INVALID_INSTANT",
      `Stored value is not a readable instant: ${JSON.stringify(value)}`,
    );
  }
  return {
    kind: "instant",
    iso,
    precision: "unknown",
    utcMidnight: isUtcMidnight(iso),
    onMinuteBoundary: isOnMinuteBoundary(iso),
  };
}

/**
 * Read a stored DATETIME into the boundary type. Precision stays "unknown" —
 * the honest answer for every value written before this contract existed.
 */
export function readStoredInstantAsBusinessTime(
  value: Date | string | null | undefined,
): BusinessTimeValue | null {
  const c = classifyStoredInstant(value);
  if (c.kind === "absent") return null;
  return { kind: "instant", iso: c.iso!, precision: "unknown" };
}

// ---------------------------------------------------------------------------
// Deadline semantics — interval, not a fake 23:59 instant
// ---------------------------------------------------------------------------

/**
 * Overdue rule (contract E1):
 * - dateOnly deadline: overdue once `now` reaches the *exclusive* end of that
 *   calendar day in `timeZone` (default: runtime zone, the only tz source
 *   available until the D-TZ-* decision items land).
 * - instant deadline: overdue once `now` is strictly after the instant.
 * - absent deadline: never overdue.
 */
export function isDeadlineOverdue(
  deadline: BusinessTimeValue | Date | string | null | undefined,
  now: Date = new Date(),
  timeZone: string = runtimeTimeZone(),
): boolean {
  if (deadline === null || deadline === undefined) return false;
  const value = toBusinessTimeValue(deadline);
  if (value.kind === "dateOnly") {
    const window = dateOnlyUtcWindow(value.date, timeZone);
    return now.getTime() >= Date.parse(window.endIsoExclusive);
  }
  return now.getTime() > Date.parse(value.iso);
}

/** Coerce any stored/wire shape into the typed boundary value. */
export function toBusinessTimeValue(
  input: BusinessTimeValue | Date | string,
): BusinessTimeValue {
  if (typeof input === "object" && input !== null && "kind" in input) {
    return input;
  }
  if (input instanceof Date) {
    return { kind: "instant", iso: toInstantIso(input), precision: "unknown" };
  }
  if (isDateOnly(input)) {
    return { kind: "dateOnly", date: input };
  }
  const iso = parseInstantIso(input);
  if (iso !== null) return { kind: "instant", iso, precision: "unknown" };
  throw new DateTimeContractError(
    "DATETIME_INVALID_BUSINESS_TIME",
    `Not a DateOnly or instant: ${JSON.stringify(input)}`,
  );
}

// ---------------------------------------------------------------------------
// Serialization — precision must survive the DTO boundary
// ---------------------------------------------------------------------------

export type SerializedBusinessTime = {
  value: DateOnlyString | InstantIso;
  precision: "dateOnly" | "minute" | "fullInstant" | "unknown";
};

export function serializeBusinessTime(
  value: BusinessTimeValue,
): SerializedBusinessTime {
  return value.kind === "dateOnly"
    ? { value: value.date, precision: "dateOnly" }
    : { value: value.iso, precision: value.precision };
}

export function parseBusinessTimeValue(
  input: SerializedBusinessTime,
): BusinessTimeValue {
  if (input.precision === "dateOnly") {
    const date = parseDateOnly(input.value);
    if (date === null) {
      throw new DateTimeContractError(
        "DATETIME_INVALID_BUSINESS_TIME",
        `precision=dateOnly but value is not YYYY-MM-DD: ${JSON.stringify(input.value)}`,
      );
    }
    return { kind: "dateOnly", date };
  }
  const iso = parseInstantIso(input.value);
  if (iso === null) {
    throw new DateTimeContractError(
      "DATETIME_INVALID_BUSINESS_TIME",
      `Expected instant for precision=${input.precision}, received ${JSON.stringify(input.value)}`,
    );
  }
  return { kind: "instant", iso, precision: input.precision };
}

// ---------------------------------------------------------------------------
// UI bridges — how existing picker output enters the contract honestly
// ---------------------------------------------------------------------------

const TIME_OF_DAY_12H = /^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/i;

/**
 * Parse the TimePicker wire form ("hh:mm AM") into 24h parts.
 * Returns null on any shape violation — callers surface a validation error.
 */
export function parseTimeOfDay12h(
  input: string,
): { hour: number; minute: number } | null {
  const m = TIME_OF_DAY_12H.exec(input.trim());
  if (!m) return null;
  const rawHour = Number(m[1]);
  if (rawHour < 1 || rawHour > 12) return null;
  const minute = Number(m[2]);
  const pm = m[3].toUpperCase() === "PM";
  return { hour: (rawHour % 12) + (pm ? 12 : 0), minute };
}

/**
 * Extract the calendar day a date picker captured. Picker components produce
 * a `Date` anchored at runtime-local midnight; the *date parts* (not the
 * instant) are the user's intent, so we read local y/m/d into a DateOnly.
 */
export function dateOnlyFromPickerDate(picked: Date): DateOnlyString {
  if (!(picked instanceof Date) || Number.isNaN(picked.getTime())) {
    throw new DateTimeContractError(
      "DATETIME_INVALID_DATE_ONLY",
      "Picker did not produce a valid date",
    );
  }
  return `${String(picked.getFullYear()).padStart(4, "0")}-${String(
    picked.getMonth() + 1,
  ).padStart(2, "0")}-${String(picked.getDate()).padStart(2, "0")}`;
}

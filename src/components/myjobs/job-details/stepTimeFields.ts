import {
  dateOnlyFromPickerDate,
  formatTimeOfDay12h,
  instantToWallTime,
  parseTimeOfDay12h,
  type DateOnlyString,
} from "@/lib/datetime";
import type { StepTimeInput } from "@/lib/career/applicationTimeline";

/**
 * The raw picker pair a step-time form field holds: the calendar day the
 * DatePicker captured plus the TimePicker's "hh:mm AM" wire string ("" = no
 * time chosen).
 */
export type StepTimeFieldValue = {
  date: Date | null;
  time: string;
};

const EMPTY_FIELD: StepTimeFieldValue = { date: null, time: "" };

/** Rebuilds a picker Date from a DateOnly using local y/m/d — the inverse
 *  of dateOnlyFromPickerDate, so the calendar opens on the same day. */
export function pickerDateFromDateOnly(date: DateOnlyString): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/**
 * Backfills a picker pair from a stored step value.
 * - dateOnly deadline -> the calendar day, no time.
 * - minute/fullInstant -> day + wall time in the current account zone.
 *   The stored zone is input provenance, never the editing zone.
 * - unknown -> the day only: pre-filling a clock would invent precision the
 *   record does not have.
 */
export function stepTimeFieldFromStored(
  stored: {
    iso: string | null;
    precision: string | null;
    dateOnly: string | null;
    zone: string | null;
  },
  fallbackZone: string,
): StepTimeFieldValue {
  if (stored.dateOnly != null && stored.precision === "dateOnly") {
    return { date: pickerDateFromDateOnly(stored.dateOnly), time: "" };
  }
  if (stored.iso == null) return EMPTY_FIELD;
  const wall = instantToWallTime(stored.iso, fallbackZone);
  if (stored.precision === "minute" || stored.precision === "fullInstant") {
    return {
      date: pickerDateFromDateOnly(wall.date),
      time: formatTimeOfDay12h(wall.hour, wall.minute),
    };
  }
  return { date: pickerDateFromDateOnly(wall.date), time: "" };
}

export type StepTimeFieldResult =
  | { ok: true; value: StepTimeInput }
  | { ok: false; reason: "time-required" | "date-required" | "invalid-time" };

/**
 * Converts the picker pair into the wire contract. `scheduledAt` always
 * needs a time of day (a bare day is not a schedule); `deadlineAt` accepts
 * a bare calendar day and stays a DateOnly. A clock time without a day is
 * rejected instead of silently clearing the stored value.
 */
export function stepTimeInputFromField(
  field: "scheduledAt" | "deadlineAt",
  input: StepTimeFieldValue,
): StepTimeFieldResult {
  if (input.date == null) {
    return input.time.trim() === ""
      ? { ok: true, value: null }
      : { ok: false, reason: "date-required" };
  }
  const date = dateOnlyFromPickerDate(input.date);
  const rawTime = input.time.trim();
  if (rawTime === "") {
    if (field === "scheduledAt") return { ok: false, reason: "time-required" };
    return { ok: true, value: { kind: "dateOnly", date } };
  }
  const parsed = parseTimeOfDay12h(rawTime);
  if (parsed === null) return { ok: false, reason: "invalid-time" };
  return {
    ok: true,
    value: { kind: "wallTime", date, hour: parsed.hour, minute: parsed.minute },
  };
}

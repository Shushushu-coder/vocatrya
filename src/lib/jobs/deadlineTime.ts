import {
  businessTimeFromColumns,
  formatBusinessTime,
  instantToWallTime,
  dateOnlyParts,
  type BusinessTimeValue,
  type DateOnlyString,
  type DateTimeLocale,
  type TimePrecision,
} from "@/lib/datetime";

/**
 * P-JO deadline contract (DATETIME_CONSUMER_CONTRACT_PROPOSAL §5, applied to
 * JobOpportunity.deadline / .deadlineOn / .deadlinePrecision).
 *
 * `deadlineOn` XOR `deadline`, declared by `deadlinePrecision`: a `"dateOnly"`
 * sidecar on `deadlineOn` declares a calendar day; otherwise a stored
 * `deadline` is an instant fact (precision NULL or unrecognised reads as
 * `unknown`). A `deadlineOn` without the dateOnly declaration is a
 * contradictory write — the instant stays the historical fact.
 *
 * On the Job DTO the instant carrier is projected as `dueDate` (legacy field
 * name); a pure dateOnly row projects `dueDate = null`.
 */
export type JobDeadlineFields = {
  deadlineOn?: string | null;
  /** Instant carrier — opportunity.deadline, projected as Job.dueDate. */
  dueDate?: Date | string | null;
  deadlinePrecision?: string | null;
};

/** The single deterministic row → BusinessTimeValue rule (§3.2). Throws on a
 *  declared-but-corrupt DateOnly (data-plane error, not a silent downgrade). */
export function jobDeadlineBusinessValue(
  row: JobDeadlineFields,
): BusinessTimeValue | null {
  return businessTimeFromColumns({
    dateOnly: row.deadlineOn,
    instant: row.dueDate,
    precision: row.deadlinePrecision,
  });
}

/** Normalized precision for the DTO boundary; null when no carrier exists. */
export function jobDeadlinePrecision(
  row: JobDeadlineFields,
): TimePrecision | null {
  const value = jobDeadlineBusinessValue(row);
  if (!value) return null;
  return value.kind === "dateOnly" ? "dateOnly" : value.precision;
}

/** The calendar day the deadline occupies in the account zone. */
export function jobDeadlineCalendarDay(
  row: JobDeadlineFields,
  timeZone: string,
): DateOnlyString | null {
  const value = jobDeadlineBusinessValue(row);
  if (!value) return null;
  return value.kind === "dateOnly"
    ? value.date
    : instantToWallTime(value.iso, timeZone).date;
}

/** Local-midnight `Date` for the picker — never `Date.parse("YYYY-MM-DD")`,
 *  which UTC-anchors and shifts the day in negative-offset zones. */
export function jobDeadlinePickerDate(
  row: JobDeadlineFields,
  timeZone: string,
): Date | undefined {
  const day = jobDeadlineCalendarDay(row, timeZone);
  if (!day) return undefined;
  const { year, month, day: d } = dateOnlyParts(day);
  return new Date(year, month - 1, d);
}

/** Deadline display: DateOnly renders verbatim; a timed instant shows
 *  date+time; a historical `unknown` instant shows only its account-zone
 *  wall date. null when no deadline exists. */
export function formatJobDeadline(
  row: JobDeadlineFields,
  locale: string,
  timeZone: string,
): string | null {
  const value = jobDeadlineBusinessValue(row);
  if (!value) return null;
  return formatBusinessTime(value, locale as DateTimeLocale, timeZone);
}

/** CSV cell: DateOnly exports verbatim (no tz drift); an instant exports its
 *  ISO-8601 UTC form; absent → "". */
export function jobDeadlineCsvCell(row: JobDeadlineFields): string {
  const value = jobDeadlineBusinessValue(row);
  if (!value) return "";
  return value.kind === "dateOnly" ? value.date : value.iso;
}

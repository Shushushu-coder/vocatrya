import {
  compareDateOnly,
  dateOnlyParts,
  dateOnlyToEpochDay,
  dateOnlyUtcWindow,
  formatDateOnly,
  formatInstant,
  instantToWallTime,
  parseDateOnly,
  requireDateOnly,
  requireInstantIso,
  toInstantIso,
  todayDateOnly,
  type BusinessTimeValue,
  type DateOnlyString,
  type InstantIso,
  type TimePrecision,
} from "@/lib/datetime";

/**
 * P-TASK due contract (DATETIME_CONSUMER_CONTRACT_PROPOSAL §5).
 *
 * `dueOn` XOR `dueDate`, declared by `duePrecision`: a `"dateOnly"` sidecar on
 * a `dueOn` value declares a calendar day; otherwise a stored `dueDate` is an
 * instant fact (precision NULL or unrecognised reads as `unknown`). A `dueOn`
 * without the dateOnly declaration is a contradictory/dirty write with no
 * valid carrier — it has no due value and is never reinterpreted.
 */
export type TaskDuePrecision = TimePrecision;

export type TaskDueFields = {
  dueOn?: string | null;
  dueDate?: Date | string | null;
  duePrecision?: string | null;
};

function storedInstantIso(value: Date | string): InstantIso {
  return value instanceof Date ? toInstantIso(value) : requireInstantIso(value);
}

/** The single deterministic row → BusinessTimeValue rule. Throws on a
 *  declared-but-corrupt DateOnly (contract: a data-plane error, not a silent
 *  downgrade). */
export function taskDueBusinessValue(
  row: TaskDueFields,
): BusinessTimeValue | null {
  const { dueOn, dueDate, duePrecision } = row;
  if (dueOn != null && duePrecision === "dateOnly") {
    return { kind: "dateOnly", date: requireDateOnly(dueOn) };
  }
  if (dueDate != null) {
    return {
      kind: "instant",
      iso: storedInstantIso(dueDate),
      precision:
        duePrecision === "minute" || duePrecision === "fullInstant"
          ? duePrecision
          : "unknown",
    };
  }
  return null;
}

/** Normalized precision for the Task DTO; null when no due carrier exists. */
export function taskDuePrecision(row: TaskDueFields): TaskDuePrecision | null {
  const value = taskDueBusinessValue(row);
  if (!value) return null;
  return value.kind === "dateOnly" ? "dateOnly" : value.precision;
}

/** Stored precision is normalized once at the DTO boundary: a valid declared
 *  value wins, anything else on a real carrier reads "unknown", no carrier
 *  reads null (§5.1). A declared-but-corrupt DateOnly throws — data-plane
 *  error. The stored row itself is never rewritten. */
export function withDueDto<
  T extends { dueOn?: string | null; dueDate?: Date | null; duePrecision?: string | null },
>(row: T): T {
  return { ...row, duePrecision: taskDuePrecision(row) } as T;
}

/** §5.2 due sort key: instant → itself; dateOnly → the exclusive end of that
 *  calendar day in the account zone; absent → null (NULL sorts last by
 *  contract, never by the SQLite default). */
export function taskDueSortKeyIso(
  row: TaskDueFields,
  timeZone: string,
): InstantIso | null {
  const value = taskDueBusinessValue(row);
  if (!value) return null;
  return value.kind === "dateOnly"
    ? dateOnlyUtcWindow(value.date, timeZone).endIsoExclusive
    : value.iso;
}

/** §5.2/§5.3 deterministic total order: sortKey asc (NULL last) → priority
 *  desc → id asc. The id tie-break is what makes offset pagination exact. */
export function orderTasksByDue<
  T extends TaskDueFields & { id: string; priority: number },
>(rows: T[], timeZone: string): T[] {
  // Rows often share a due day. Resolve its zone boundary once per sort;
  // keeping the cache local also makes account-zone changes take effect.
  const dayEnds = new Map<DateOnlyString, InstantIso>();
  const decorated = rows.map((row) => {
    const value = taskDueBusinessValue(row);
    let key: InstantIso | null = null;
    if (value?.kind === "dateOnly") {
      key = dayEnds.get(value.date) ?? null;
      if (key === null) {
        key = dateOnlyUtcWindow(value.date, timeZone).endIsoExclusive;
        dayEnds.set(value.date, key);
      }
    } else if (value?.kind === "instant") {
      key = value.iso;
    }
    return { row, key };
  });
  decorated.sort((a, b) => {
    if (a.key === null && b.key === null) {
      // no sort key either way — fall through to the tie-break chain
    } else if (a.key === null) {
      return 1;
    } else if (b.key === null) {
      return -1;
    } else if (a.key !== b.key) {
      // both keys are canonical toISOString() output: lexical == chronological
      return a.key < b.key ? -1 : 1;
    }
    if (a.row.priority !== b.row.priority) {
      return b.row.priority - a.row.priority;
    }
    return a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0;
  });
  return decorated.map((entry) => entry.row);
}

/** The calendar day a due value occupies in the account zone — the grouping
 *  key for the dueDate bucketing. */
export function taskDueCalendarDay(
  row: TaskDueFields,
  timeZone: string,
): DateOnlyString | null {
  const value = taskDueBusinessValue(row);
  if (!value) return null;
  return value.kind === "dateOnly"
    ? value.date
    : instantToWallTime(value.iso, timeZone).date;
}

export type TaskDueDateGroup =
  | "Overdue"
  | "Today"
  | "Tomorrow"
  | "This Week"
  | "Later"
  | "No Due Date";

/** Due-date bucket on the account-zone calendar. An instant is overdue the
 *  moment it is reached — including earlier the same day; a DateOnly stays
 *  valid for the whole local day and only turns overdue once its day fully
 *  ends (its sort key, `endIsoExclusive`, is passed). "This Week" keeps the
 *  previous Sunday-start semantics (epoch day 0 = Thursday → (day+4)%7). */
export function taskDueDateGroup(
  row: TaskDueFields,
  timeZone: string,
  now: Date = new Date(),
): TaskDueDateGroup {
  const value = taskDueBusinessValue(row);
  if (!value) return "No Due Date";
  if (value.kind === "instant" && Date.parse(value.iso) <= now.getTime()) {
    return "Overdue";
  }
  const today = dateOnlyToEpochDay(todayDateOnly(timeZone, now));
  const due = dateOnlyToEpochDay(taskDueCalendarDay(row, timeZone)!);
  if (due < today) return "Overdue";
  if (due === today) return "Today";
  if (due === today + 1) return "Tomorrow";
  if (due <= today + (6 - ((today + 4) % 7))) return "This Week";
  return "Later";
}

/** Local-midnight `Date` for the picker — never `Date.parse("YYYY-MM-DD")`,
 *  which UTC-anchors and shifts the day in negative-offset zones. */
export function taskDuePickerDate(
  row: TaskDueFields,
  timeZone: string,
): Date | undefined {
  const day = taskDueCalendarDay(row, timeZone);
  if (!day) return undefined;
  const { year, month, day: d } = dateOnlyParts(day);
  return new Date(year, month - 1, d);
}

/** Due display: DateOnly renders verbatim; a timed instant shows date+time;
 *  a historical `unknown` instant shows only its account-zone wall date. */
export function formatTaskDue(
  row: TaskDueFields,
  locale: string,
  timeZone: string,
): string | null {
  const value = taskDueBusinessValue(row);
  if (!value) return null;
  if (value.kind === "dateOnly") {
    return formatDateOnly(value.date, locale);
  }
  if (value.precision === "unknown") {
    return formatDateOnly(instantToWallTime(value.iso, timeZone).date, locale);
  }
  return formatInstant(value.iso, locale, timeZone);
}

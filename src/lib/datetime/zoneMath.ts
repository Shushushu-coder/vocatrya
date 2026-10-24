import { DateTimeContractError } from "./types";

/**
 * Internal zone math, shared by dateOnly.ts and zoned.ts.
 * Everything here is pure: given an instant (ms) and an IANA zone, derive the
 * wall-clock parts through Intl — the only authoritative tz database available
 * without adding a dependency.
 */

export type ZoneWallParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  // ECMA-402 treats { timeZone: undefined } as "use the runtime zone" — the
  // contract requires an explicit IANA zone, so missing/empty/non-string
  // input is rejected here at the funnel every zone lookup passes through.
  if (typeof timeZone !== "string" || timeZone.length === 0) {
    throw new DateTimeContractError(
      "DATETIME_INVALID_TIMEZONE",
      `An explicit IANA time zone is required, received ${JSON.stringify(timeZone)}`,
    );
  }
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    try {
      fmt = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        fractionalSecondDigits: 3,
      });
    } catch {
      throw new DateTimeContractError(
        "DATETIME_INVALID_TIMEZONE",
        `Not an IANA time zone: ${JSON.stringify(timeZone)}`,
      );
    }
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function assertValidTimeZone(timeZone: string): string {
  formatterFor(timeZone);
  return timeZone;
}

export function runtimeTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** Wall-clock parts that `instantMs` shows in `timeZone`. */
export function wallPartsInZone(instantMs: number, timeZone: string): ZoneWallParts {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const read = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    if (!p) {
      throw new DateTimeContractError(
        "DATETIME_ZONE_FORMAT_UNSUPPORTED",
        `Intl part ${type} unavailable for ${timeZone}`,
      );
    }
    return p.value;
  };
  const secondRaw = read("second");
  const dot = secondRaw.indexOf(".");
  const second = dot === -1 ? Number(secondRaw) : Number(secondRaw.slice(0, dot));
  // Modern ICU (Node 24) emits "fractionalSecond" as its own part ("123");
  // older builds embed the fraction inside "second" as "ss.sss". If neither
  // source exists the millisecond is unknowable — a fabricated 0 is not a
  // trustworthy exact value, so fail loudly like any other missing part.
  const fractionalPart = parts.find((x) => x.type === "fractionalSecond");
  let millisecond: number;
  if (fractionalPart) {
    millisecond = Number(
      fractionalPart.value.replace(/\D/g, "").padEnd(3, "0").slice(0, 3),
    );
  } else if (dot !== -1) {
    millisecond = Number(secondRaw.slice(dot + 1).padEnd(3, "0").slice(0, 3));
  } else {
    throw new DateTimeContractError(
      "DATETIME_ZONE_FORMAT_UNSUPPORTED",
      `Intl fractionalSecond part unavailable for ${timeZone}`,
    );
  }
  let hour = Number(read("hour"));
  // Defensive: some ICU builds return "24" at midnight despite hourCycle h23.
  if (hour === 24) hour = 0;
  return {
    year: Number(read("year")),
    month: Number(read("month")),
    day: Number(read("day")),
    hour,
    minute: Number(read("minute")),
    second,
    millisecond,
  };
}

/** UTC offset (ms) of `timeZone` at `instantMs`: wallAsUtc - instant. */
export function offsetMsAt(instantMs: number, timeZone: string): number {
  const w = wallPartsInZone(instantMs, timeZone);
  const wallAsUtc = Date.UTC(
    w.year,
    w.month - 1,
    w.day,
    w.hour,
    w.minute,
    w.second,
    w.millisecond,
  );
  return wallAsUtc - instantMs;
}

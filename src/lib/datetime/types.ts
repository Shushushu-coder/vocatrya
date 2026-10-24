/**
 * DateTime V1 — core types.
 *
 * The contract distinguishes a calendar date (DateOnly) from a point on the
 * timeline (Instant). A DateOnly is never a `Date` object and is never
 * silently converted into one; see .wave1-runtime evidence NEXT-DATETIME-01
 * DATETIME_V1_CONTRACT.md for the full semantics this module implements.
 */

/** Canonical calendar date: `YYYY-MM-DD`. Carries no time-of-day, no zone. */
export type DateOnlyString = string;

/**
 * Canonical instant: ISO-8601 in UTC as produced by `Date.prototype.toISOString`
 * (`YYYY-MM-DDTHH:mm:ss.sssZ`).
 */
export type InstantIso = string;

/** Declared precision of a business time value. Never inferred back from a value. */
export type TimePrecision = "dateOnly" | "minute" | "fullInstant" | "unknown";

/** A wall-clock intent: calendar day + hour/minute in a specific IANA zone. */
export type WallTime = {
  date: DateOnlyString;
  /** 0-23 */
  hour: number;
  /** 0-59 */
  minute: number;
};

/** A business time value with its kind and precision made explicit. */
export type BusinessTimeValue =
  | { kind: "dateOnly"; date: DateOnlyString }
  | { kind: "instant"; iso: InstantIso; precision: Exclude<TimePrecision, "dateOnly"> };

export type DateOnlyParts = { year: number; month: number; day: number };

/** Result of resolving a wall time to an instant inside one IANA zone. */
export type WallTimeResolution = {
  iso: InstantIso;
  /** How the zone rules affected the result — always reported, never hidden. */
  disambiguation: "none" | "fold-earlier" | "fold-later" | "gap-shifted";
  /** The wall time the returned instant actually maps back to. */
  wall: WallTime;
};

export class DateTimeContractError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "DateTimeContractError";
    this.code = code;
  }
}

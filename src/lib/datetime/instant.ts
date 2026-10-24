import type { InstantIso } from "./types";
import { DateTimeContractError } from "./types";

/**
 * Strict instant parsing. An instant on the wire must carry an explicit UTC
 * marker or numeric offset — `2026-10-25T14:30` without a suffix is a wall
 * time, not an instant, and is rejected here on purpose.
 */
const INSTANT_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** True when the string is shaped like an instant (offset/Z suffix present). */
export function isInstantShape(input: unknown): boolean {
  return typeof input === "string" && INSTANT_RE.test(input);
}

/**
 * Parse to a canonical InstantIso (`...ss.sssZ`), or null when invalid.
 * Regex pins the shape; `Date.parse` plus a round-trip pins the calendar.
 */
export function parseInstantIso(input: unknown): InstantIso | null {
  if (typeof input !== "string") return null;
  const m = INSTANT_RE.exec(input);
  if (!m) return null;
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = m[6] === undefined ? 0 : Number(m[6]);
  if (hour > 23 || minute > 59 || second > 59) return null;
  const ms = Date.parse(input);
  if (Number.isNaN(ms)) return null;
  const iso = new Date(ms).toISOString();
  // Round-trip the calendar fields in the instant's own zone so impossible
  // dates (2026-02-30) never pass even if the engine normalized them.
  const rt = INSTANT_RE.exec(iso);
  if (!rt || rt[1] !== m[1] || rt[2] !== m[2] || rt[3] !== m[3]) {
    // A numeric offset legitimately shifts the UTC calendar fields; verify
    // against the *declared* zone instead.
    if (m[8] === "Z") return null;
    const shifted = new Date(ms + offsetMinutes(m[8]) * 60_000).toISOString();
    const rs = INSTANT_RE.exec(shifted);
    if (!rs || rs[1] !== m[1] || rs[2] !== m[2] || rs[3] !== m[3]) return null;
    if (Number(rs[4]) !== hour || Number(rs[5]) !== minute) return null;
    if (Number(rs[6] ?? 0) !== second) return null;
  }
  return iso;
}

function offsetMinutes(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const hh = Number(offset.slice(1, 3));
  const mm = Number(offset.slice(4, 6));
  return sign * (hh * 60 + mm);
}

export function requireInstantIso(input: unknown): InstantIso {
  const parsed = parseInstantIso(input);
  if (parsed === null) {
    throw new DateTimeContractError(
      "DATETIME_INVALID_INSTANT",
      `Expected ISO-8601 instant with Z or numeric offset, received ${JSON.stringify(input)}`,
    );
  }
  return parsed;
}

/** Canonical serialization for an instant. Throws on an invalid Date. */
export function toInstantIso(date: Date): InstantIso {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new DateTimeContractError(
      "DATETIME_INVALID_INSTANT",
      "Cannot serialize an invalid Date",
    );
  }
  return date.toISOString();
}

/**
 * Whether a serialized instant sits exactly on a minute boundary
 * (seconds and milliseconds zero). Informational only.
 */
export function isOnMinuteBoundary(iso: InstantIso): boolean {
  const ms = Date.parse(requireInstantIso(iso));
  return ms % 60_000 === 0;
}

/**
 * Whether the instant is exactly `T00:00:00.000Z` — the signature a faked
 * date-only value tends to carry. Informational only; a real midnight event
 * produces the same signature, so callers must not re-interpret the value.
 */
export function isUtcMidnight(iso: InstantIso): boolean {
  const ms = Date.parse(requireInstantIso(iso));
  return ms % 86_400_000 === 0;
}

/**
 * Contract B1: user-facing wall/instant input is minute-precision. An instant
 * carrying non-zero seconds or milliseconds is rejected rather than silently
 * truncated, so precision facts are never lost without the caller knowing.
 */
export function assertMinutePrecision(iso: InstantIso): InstantIso {
  const checked = requireInstantIso(iso);
  const ms = Date.parse(checked);
  if (ms % 60_000 !== 0) {
    throw new DateTimeContractError(
      "DATETIME_SUBMINUTE_INPUT",
      `Sub-minute input is not accepted for business fields: ${checked}`,
    );
  }
  return checked;
}

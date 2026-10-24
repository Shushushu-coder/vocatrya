import {
  addDaysToDateOnly,
  dateOnlyParts,
  formatUtcParts,
  requireDateOnly,
} from "./dateOnly";
import { requireInstantIso, toInstantIso } from "./instant";
import type { DateOnlyString, InstantIso, WallTime, WallTimeResolution } from "./types";
import { DateTimeContractError } from "./types";
import {
  assertValidTimeZone,
  offsetMsAt,
  wallPartsInZone,
  type ZoneWallParts,
} from "./zoneMath";

const HOUR_MS = 3_600_000;

export type WallTimeToInstantOptions = {
  /** Spring-forward gap: reject (default) or move to the first valid wall minute. */
  onNonexistent?: "reject" | "shiftForward";
  /** Fall-back fold: pick the earlier (default) or later matching instant. */
  onAmbiguous?: "earlier" | "later";
};

export type ZonedInterval = {
  startIso: InstantIso;
  /** Exclusive upper bound — comparisons use `now < endIsoExclusive`, which
   *  avoids inventing a "23:59:59.999" representative instant. */
  endIsoExclusive: InstantIso;
};

function wallEquals(parts: ZoneWallParts, wall: WallTime): boolean {
  const { year, month, day } = dateOnlyParts(wall.date);
  return (
    parts.year === year &&
    parts.month === month &&
    parts.day === day &&
    parts.hour === wall.hour &&
    parts.minute === wall.minute &&
    parts.second === 0 &&
    parts.millisecond === 0
  );
}

/**
 * Resolve a minute-precision wall time inside `timeZone` to an instant.
 *
 * - Normal case: one instant matches, `disambiguation: "none"`.
 * - Fall-back fold (wall time occurs twice): both candidate instants are
 *   computed and `onAmbiguous` picks deterministically; the resolution says
 *   which side was taken.
 * - Spring-forward gap (wall time never occurs): default rejects with
 *   `DATETIME_NONEXISTENT_WALL_TIME`; `onNonexistent: "shiftForward"` returns
 *   the first instant whose wall time is at/after the request with
 *   `disambiguation: "gap-shifted"`.
 */
export function wallTimeToInstant(
  wall: WallTime,
  timeZone: string,
  options: WallTimeToInstantOptions = {},
): WallTimeResolution {
  assertValidTimeZone(timeZone);
  const date = requireDateOnly(wall.date);
  const { year, month, day } = dateOnlyParts(date);
  if (
    !Number.isInteger(wall.hour) ||
    !Number.isInteger(wall.minute) ||
    wall.hour < 0 ||
    wall.hour > 23 ||
    wall.minute < 0 ||
    wall.minute > 59
  ) {
    throw new DateTimeContractError(
      "DATETIME_INVALID_WALL_TIME",
      `Wall time must be integer hour 0-23 / minute 0-59, received ${wall.hour}:${wall.minute}`,
    );
  }

  const naive = Date.UTC(year, month - 1, day, wall.hour, wall.minute);

  // Any transition that can make this wall time fold or gap must sit within
  // |max offset| + transition window of `naive`. Sampling a coarse grid well
  // past that range collects every offset a candidate instant could use; the
  // round-trip check below still guarantees we never return a wrong instant.
  const offsets = new Set<number>();
  for (let dh = -20; dh <= 20; dh += 4) {
    offsets.add(offsetMsAt(naive + dh * HOUR_MS, timeZone));
  }

  const candidates = new Set<number>();
  for (const off of offsets) {
    const candidate = naive - off;
    if (wallEquals(wallPartsInZone(candidate, timeZone), wall)) {
      candidates.add(candidate);
    }
  }

  if (candidates.size === 1) {
    const ms = [...candidates][0];
    return { iso: toInstantIso(new Date(ms)), disambiguation: "none", wall };
  }

  if (candidates.size >= 2) {
    const ordered = [...candidates].sort((a, b) => a - b);
    const pick =
      (options.onAmbiguous ?? "earlier") === "earlier"
        ? ordered[0]
        : ordered[ordered.length - 1];
    return {
      iso: toInstantIso(new Date(pick)),
      disambiguation:
        (options.onAmbiguous ?? "earlier") === "earlier"
          ? "fold-earlier"
          : "fold-later",
      wall,
    };
  }

  // Gap: the wall time never happened in this zone.
  if ((options.onNonexistent ?? "reject") === "reject") {
    throw new DateTimeContractError(
      "DATETIME_NONEXISTENT_WALL_TIME",
      `${wall.date} ${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")} does not exist in ${timeZone} (DST gap)`,
    );
  }

  // Shift forward: find the first instant whose wall time is at/after the
  // request. `wallAsUtc(t) = t + offset(t)` is non-decreasing in t across the
  // gap, so a binary search over a window covering both offsets suffices.
  const sortedOffsets = [...offsets].sort((a, b) => a - b);
  const lo = naive - sortedOffsets[sortedOffsets.length - 1];
  const hi = naive - sortedOffsets[0];
  let left = lo;
  let right = hi;
  while (right - left > 1) {
    const mid = Math.floor((left + right) / 2);
    const w = wallPartsInZone(mid, timeZone);
    const wallAsUtc = Date.UTC(
      w.year, w.month - 1, w.day, w.hour, w.minute, w.second, w.millisecond,
    );
    if (wallAsUtc >= naive) right = mid;
    else left = mid;
  }
  const resolvedWallParts = wallPartsInZone(right, timeZone);
  const resolvedWall: WallTime = {
    date: formatUtcParts(
      resolvedWallParts.year,
      resolvedWallParts.month,
      resolvedWallParts.day,
    ),
    hour: resolvedWallParts.hour,
    minute: resolvedWallParts.minute,
  };
  return {
    iso: toInstantIso(new Date(right)),
    disambiguation: "gap-shifted",
    wall: resolvedWall,
  };
}

/** The wall-clock reading of `iso` inside `timeZone`. */
export function instantToWallTime(
  iso: InstantIso,
  timeZone: string,
): { date: DateOnlyString; hour: number; minute: number; second: number; millisecond: number } {
  assertValidTimeZone(timeZone);
  const ms = Date.parse(requireInstantIso(iso));
  const w = wallPartsInZone(ms, timeZone);
  return {
    date: formatUtcParts(w.year, w.month, w.day),
    hour: w.hour,
    minute: w.minute,
    second: w.second,
    millisecond: w.millisecond,
  };
}

/**
 * The instant interval a calendar date occupies inside `timeZone`:
 * `[local midnight, next local midnight)`.
 *
 * Used for date-level semantics (e.g. a date-only deadline is overdue once
 * `now >= endIsoExclusive`) without ever fabricating a representative
 * instant like 23:59:59.999. If local midnight itself falls in a DST gap,
 * the boundary shifts forward to the first valid instant of that day.
 */
export function dateOnlyUtcWindow(
  date: DateOnlyString,
  timeZone: string,
): ZonedInterval {
  const checked = requireDateOnly(date);
  const opts: WallTimeToInstantOptions = {
    onNonexistent: "shiftForward",
    onAmbiguous: "earlier",
  };
  const start = wallTimeToInstant(
    { date: checked, hour: 0, minute: 0 },
    timeZone,
    opts,
  );
  const next = addDaysToDateOnly(checked, 1);
  const end = wallTimeToInstant(
    { date: next, hour: 0, minute: 0 },
    timeZone,
    opts,
  );
  return { startIso: start.iso, endIsoExclusive: end.iso };
}

// @vitest-environment node
import {
  assertValidTimeZone,
  dateOnlyUtcWindow,
  instantToWallTime,
  wallTimeToInstant,
  DateTimeContractError,
} from "@/lib/datetime";

const NY = "America/New_York";
const SH = "Asia/Shanghai";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("wallTimeToInstant — normal conversions", () => {
  it("maps wall minutes to the right instant per zone", () => {
    // 2026-10-25 14:30 Asia/Shanghai (UTC+8, no DST) = 06:30Z
    const sh = wallTimeToInstant(
      { date: "2026-10-25", hour: 14, minute: 30 },
      SH,
    );
    expect(sh.iso).toBe("2026-10-25T06:30:00.000Z");
    expect(sh.disambiguation).toBe("none");

    // Same wall time in New York (EDT, -4) = 18:30Z
    const ny = wallTimeToInstant(
      { date: "2026-10-25", hour: 14, minute: 30 },
      NY,
    );
    expect(ny.iso).toBe("2026-10-25T18:30:00.000Z");

    // UTC is identity.
    const utc = wallTimeToInstant(
      { date: "2026-10-25", hour: 14, minute: 30 },
      "UTC",
    );
    expect(utc.iso).toBe("2026-10-25T14:30:00.000Z");
  });

  it("round-trips wall → instant → wall", () => {
    const wall = { date: "2026-01-15", hour: 9, minute: 5 };
    for (const tz of [SH, NY, "UTC", "Europe/Berlin", "Australia/Sydney"]) {
      const r = wallTimeToInstant(wall, tz);
      const back = instantToWallTime(r.iso, tz);
      expect(back).toMatchObject({
        date: wall.date,
        hour: wall.hour,
        minute: wall.minute,
        second: 0,
      });
    }
  });

  it("rejects malformed input and bad zones with coded errors", () => {
    expect(() =>
      wallTimeToInstant({ date: "2026-10-25", hour: 24, minute: 0 }, "UTC"),
    ).toThrowError(
      expect.objectContaining({ code: "DATETIME_INVALID_WALL_TIME" }),
    );
    expect(() =>
      wallTimeToInstant({ date: "2026-10-25", hour: 9, minute: 60 }, "UTC"),
    ).toThrowError(
      expect.objectContaining({ code: "DATETIME_INVALID_WALL_TIME" }),
    );
    expect(() =>
      wallTimeToInstant({ date: "2026-13-01", hour: 9, minute: 0 }, "UTC"),
    ).toThrowError(
      expect.objectContaining({ code: "DATETIME_INVALID_DATE_ONLY" }),
    );
    expect(() =>
      wallTimeToInstant(
        { date: "2026-10-25", hour: 9, minute: 0 },
        "Mars/Olympus_Mons",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "DATETIME_INVALID_TIMEZONE" }),
    );
    expect(() =>
      wallTimeToInstant({ date: "2026-10-25", hour: 9.5, minute: 0 }, "UTC"),
    ).toThrowError(
      expect.objectContaining({ code: "DATETIME_INVALID_WALL_TIME" }),
    );
  });
});

describe("wallTimeToInstant — DST gap (spring forward)", () => {
  // America/New_York 2026-03-08: 02:00 jumps to 03:00. 02:30 never happens.
  const gapWall = { date: "2026-03-08", hour: 2, minute: 30 };

  it("rejects a nonexistent wall time by default", () => {
    try {
      wallTimeToInstant(gapWall, NY);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DateTimeContractError);
      expect((e as DateTimeContractError).code).toBe(
        "DATETIME_NONEXISTENT_WALL_TIME",
      );
    }
  });

  it("shiftForward lands on the first valid wall minute (03:00 EDT = 07:00Z)", () => {
    const r = wallTimeToInstant(gapWall, NY, { onNonexistent: "shiftForward" });
    expect(r.iso).toBe("2026-03-08T07:00:00.000Z");
    expect(r.disambiguation).toBe("gap-shifted");
    // The returned resolution reports the wall it actually produced.
    expect(r.wall).toEqual({ date: "2026-03-08", hour: 3, minute: 0 });
  });

  it("wall times on either side of the gap resolve normally", () => {
    expect(
      wallTimeToInstant({ date: "2026-03-08", hour: 1, minute: 59 }, NY).iso,
    ).toBe("2026-03-08T06:59:00.000Z"); // 01:59 EST
    expect(
      wallTimeToInstant({ date: "2026-03-08", hour: 3, minute: 0 }, NY).iso,
    ).toBe("2026-03-08T07:00:00.000Z"); // 03:00 EDT
  });
});

describe("wallTimeToInstant — DST fold (fall back)", () => {
  // America/New_York 2026-11-01: 02:00 falls back to 01:00. 01:30 happens twice.
  const foldWall = { date: "2026-11-01", hour: 1, minute: 30 };

  it("defaults to the earlier instant (EDT, 05:30Z) and reports it", () => {
    const r = wallTimeToInstant(foldWall, NY);
    expect(r.iso).toBe("2026-11-01T05:30:00.000Z");
    expect(r.disambiguation).toBe("fold-earlier");
  });

  it("onAmbiguous 'later' picks the EST occurrence (06:30Z)", () => {
    const r = wallTimeToInstant(foldWall, NY, { onAmbiguous: "later" });
    expect(r.iso).toBe("2026-11-01T06:30:00.000Z");
    expect(r.disambiguation).toBe("fold-later");
  });

  it("both fold answers round-trip to the same wall reading", () => {
    for (const iso of ["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]) {
      expect(instantToWallTime(iso, NY)).toMatchObject({
        date: "2026-11-01",
        hour: 1,
        minute: 30,
      });
    }
  });
});

describe("instantToWallTime", () => {
  it("renders one instant into each zone's wall reading", () => {
    const iso = "2026-10-25T16:30:00.000Z";
    expect(instantToWallTime(iso, "UTC")).toMatchObject({
      date: "2026-10-25",
      hour: 16,
      minute: 30,
    });
    expect(instantToWallTime(iso, SH)).toMatchObject({
      date: "2026-10-26",
      hour: 0,
      minute: 30,
    });
    expect(instantToWallTime(iso, NY)).toMatchObject({
      date: "2026-10-25",
      hour: 12,
      minute: 30,
    });
  });

  it("rejects invalid instants", () => {
    expect(() => instantToWallTime("not-an-iso", "UTC")).toThrowError(
      expect.objectContaining({ code: "DATETIME_INVALID_INSTANT" }),
    );
  });
});

describe("instantToWallTime — millisecond fidelity (F-8)", () => {
  // Node 24 ICU emits "second" and "fractionalSecond" as separate parts;
  // wallPartsInZone must read the fractional part instead of hunting for an
  // embedded "ss.sss" inside "second".
  it.each([
    ["2026-10-25T14:30:45.000Z", 0],
    ["2026-10-25T14:30:45.001Z", 1],
    ["2026-10-25T14:30:45.123Z", 123],
    ["2026-10-25T14:30:45.999Z", 999],
  ])("preserves .%s milliseconds as %i in UTC", (iso, expectedMs) => {
    const r = instantToWallTime(iso, "UTC");
    expect(r.second).toBe(45);
    expect(r.millisecond).toBe(expectedMs);
  });

  it.each([
    ["2026-10-25T14:30:45.123Z", "America/New_York", 123],
    ["2026-10-25T14:30:45.999Z", "Europe/Berlin", 999],
    ["2026-10-25T14:30:45.001Z", "Australia/Sydney", 1],
  ])(
    "preserves milliseconds in %s for %s",
    (iso, tz, expectedMs) => {
      const r = instantToWallTime(iso, tz);
      expect(r.second).toBe(45);
      expect(r.millisecond).toBe(expectedMs);
    },
  );

  it("keeps milliseconds across a zone-shifted date boundary", () => {
    // 16:30:45.123Z = next calendar day 00:30 in Asia/Shanghai.
    expect(
      instantToWallTime("2026-10-25T16:30:45.123Z", "Asia/Shanghai"),
    ).toEqual({
      date: "2026-10-26",
      hour: 0,
      minute: 30,
      second: 45,
      millisecond: 123,
    });
    // 05:30:45.007Z = previous calendar day 18:30 in Pacific/Pago_Pago (UTC-11).
    expect(
      instantToWallTime("2026-10-25T05:30:45.007Z", "Pacific/Pago_Pago"),
    ).toEqual({
      date: "2026-10-24",
      hour: 18,
      minute: 30,
      second: 45,
      millisecond: 7,
    });
  });

  it("a legal Instant keeps its full millisecond precision end to end", () => {
    // Canonical input as produced by Date.prototype.toISOString.
    const iso = new Date("2026-10-25T14:30:45.042Z").toISOString();
    expect(instantToWallTime(iso, "UTC").millisecond).toBe(42);
    // Round-trip: wall parts still carry the instant's milliseconds, so a
    // consumer can trust second/millisecond as an exact reading.
    const r = instantToWallTime("9999-12-31T23:59:59.999Z", "UTC");
    expect(r).toMatchObject({ second: 59, millisecond: 999 });
  });
});

describe("instantToWallTime — strict instant input (F-1)", () => {
  it("rejects a bare DateOnly — a calendar day is not an instant", () => {
    try {
      instantToWallTime("2026-10-25", NY);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(DateTimeContractError);
      expect((e as DateTimeContractError).code).toBe(
        "DATETIME_INVALID_INSTANT",
      );
    }
  });

  it("rejects offset-less and lenient shapes Date.parse would accept", () => {
    for (const bad of [
      "2026-10-25 14:30:00", // space-separated wall — Date.parse reads it as LOCAL
      "2026-10-25T14:30:00", // ISO shape but no offset
      "2026-10-25T14:30", // wall time shape
      "October 25, 2026", // month name
      "Sun, 25 Oct 2026 14:30:00 GMT", // RFC-2822
      "2026/10/25 14:30", // slash form
    ]) {
      try {
        instantToWallTime(bad, "UTC");
        expect.unreachable(`${bad} should have been rejected`);
      } catch (e) {
        expect((e as DateTimeContractError).code).toBe(
          "DATETIME_INVALID_INSTANT",
        );
      }
    }
  });

  it("rejects non-string input — no implicit string conversion into Date.parse", () => {
    const badInputs: unknown[] = [
      undefined,
      null,
      12345,
      new Date("2026-10-25T00:00:00.000Z"),
      {},
      [],
    ];
    for (const bad of badInputs) {
      try {
        instantToWallTime(bad as string, "UTC");
        expect.unreachable(`${String(bad)} should have been rejected`);
      } catch (e) {
        expect((e as DateTimeContractError).code).toBe(
          "DATETIME_INVALID_INSTANT",
        );
      }
    }
  });

  it("keeps valid Z and numeric-offset instants rendering identically", () => {
    const viaOffset = instantToWallTime("2026-10-25T14:30:00+08:00", "UTC");
    const viaZ = instantToWallTime("2026-10-25T06:30:00.000Z", "UTC");
    expect(viaOffset).toEqual(viaZ);
    expect(viaOffset).toMatchObject({
      date: "2026-10-25",
      hour: 6,
      minute: 30,
    });
    // An offset that crosses the UTC date line still lands correctly.
    expect(
      instantToWallTime("2026-10-25T01:30:00+08:00", "UTC"),
    ).toMatchObject({ date: "2026-10-24", hour: 17, minute: 30 });
  });

  it.each([
    "Pacific/Kiritimati",
    "Asia/Shanghai",
    "UTC",
    "America/New_York",
    "Pacific/Pago_Pago",
  ])("rejection is identical under system TZ=%s", (tz) => {
    process.env.TZ = tz;
    for (const bad of [
      "2026-10-25",
      "2026-10-25 14:30:00",
      "October 25, 2026",
    ]) {
      try {
        instantToWallTime(bad, "UTC");
        expect.unreachable(`${bad} should have been rejected`);
      } catch (e) {
        expect((e as DateTimeContractError).code).toBe(
          "DATETIME_INVALID_INSTANT",
        );
      }
    }
  });
});

describe("explicit IANA time zone is required (F-2)", () => {
  const wall = { date: "2026-10-25", hour: 14, minute: 30 };
  const badZones: unknown[] = [undefined, null, "", 123, {}, []];

  it("assertValidTimeZone rejects missing/empty/non-string zones with the coded error", () => {
    for (const bad of badZones) {
      try {
        assertValidTimeZone(bad as string);
        expect.unreachable(`${JSON.stringify(bad)} should have been rejected`);
      } catch (e) {
        expect(e).toBeInstanceOf(DateTimeContractError);
        expect((e as DateTimeContractError).code).toBe(
          "DATETIME_INVALID_TIMEZONE",
        );
      }
    }
  });

  it("assertValidTimeZone accepts real IANA names unchanged", () => {
    expect(assertValidTimeZone("UTC")).toBe("UTC");
    expect(assertValidTimeZone(NY)).toBe(NY);
    expect(assertValidTimeZone("Asia/Kathmandu")).toBe("Asia/Kathmandu");
  });

  it("no zoned path silently uses the runtime zone when timeZone is missing", () => {
    const calls: Array<(tz: string) => unknown> = [
      (tz) => wallTimeToInstant(wall, tz),
      (tz) => instantToWallTime("2026-10-25T06:30:00.000Z", tz),
      (tz) => dateOnlyUtcWindow("2026-10-25", tz),
    ];
    for (const bad of badZones) {
      for (const call of calls) {
        try {
          call(bad as string);
          expect.unreachable(`${JSON.stringify(bad)} should have been rejected`);
        } catch (e) {
          expect((e as DateTimeContractError).code).toBe(
            "DATETIME_INVALID_TIMEZONE",
          );
        }
      }
    }
  });

  it("a missing zone can never mint a machine-dependent instant reported as 'none'", () => {
    // Pre-fix behavior: resolved under the runtime zone and reported
    // disambiguation "none". The contract now rejects before any minting.
    try {
      wallTimeToInstant(wall, undefined as unknown as string);
      expect.unreachable();
    } catch (e) {
      expect((e as DateTimeContractError).code).toBe(
        "DATETIME_INVALID_TIMEZONE",
      );
    }
  });

  it.each([
    "Pacific/Kiritimati",
    "Asia/Shanghai",
    "UTC",
    "America/New_York",
    "Pacific/Pago_Pago",
  ])("missing zone rejected identically under system TZ=%s", (tz) => {
    process.env.TZ = tz;
    for (const call of [
      () => wallTimeToInstant(wall, undefined as unknown as string),
      () =>
        instantToWallTime(
          "2026-10-25T06:30:00.000Z",
          undefined as unknown as string,
        ),
      () => dateOnlyUtcWindow("2026-10-25", undefined as unknown as string),
    ]) {
      try {
        call();
        expect.unreachable();
      } catch (e) {
        expect((e as DateTimeContractError).code).toBe(
          "DATETIME_INVALID_TIMEZONE",
        );
      }
    }
  });
});

describe("dateOnlyUtcWindow — a calendar day as an interval", () => {
  it("bounds the day [midnight, next midnight) per zone", () => {
    expect(dateOnlyUtcWindow("2026-10-25", "UTC")).toEqual({
      startIso: "2026-10-25T00:00:00.000Z",
      endIsoExclusive: "2026-10-26T00:00:00.000Z",
    });
    expect(dateOnlyUtcWindow("2026-10-25", SH)).toEqual({
      startIso: "2026-10-24T16:00:00.000Z",
      endIsoExclusive: "2026-10-25T16:00:00.000Z",
    });
    expect(dateOnlyUtcWindow("2026-10-25", NY)).toEqual({
      startIso: "2026-10-25T04:00:00.000Z",
      endIsoExclusive: "2026-10-26T04:00:00.000Z",
    });
  });

  it("produces no representative instant — bounds only, and 24h wide normally", () => {
    const w = dateOnlyUtcWindow("2026-10-25", SH);
    expect(Date.parse(w.endIsoExclusive) - Date.parse(w.startIso)).toBe(
      24 * 3_600_000,
    );
  });

  it("DST days are not 24h but stay a correct calendar interval", () => {
    // NY spring-forward day is 23h; fall-back day is 25h.
    const spring = dateOnlyUtcWindow("2026-03-08", NY);
    expect(Date.parse(spring.endIsoExclusive) - Date.parse(spring.startIso)).toBe(
      23 * 3_600_000,
    );
    const fall = dateOnlyUtcWindow("2026-11-01", NY);
    expect(Date.parse(fall.endIsoExclusive) - Date.parse(fall.startIso)).toBe(
      25 * 3_600_000,
    );
  });
});

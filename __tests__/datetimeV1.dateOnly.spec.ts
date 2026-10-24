// @vitest-environment node
import {
  addDaysToDateOnly,
  compareDateOnly,
  dateOnlyFromPickerDate,
  dateOnlyParts,
  isDateOnly,
  parseDateOnly,
  requireDateOnly,
  todayDateOnly,
  DateTimeContractError,
} from "@/lib/datetime";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("parseDateOnly — strict YYYY-MM-DD", () => {
  it("accepts real calendar dates", () => {
    expect(parseDateOnly("2026-10-25")).toBe("2026-10-25");
    expect(parseDateOnly("2024-02-29")).toBe("2024-02-29"); // leap day
    expect(parseDateOnly("1999-12-31")).toBe("1999-12-31");
  });

  it("rejects impossible dates and malformed shapes", () => {
    for (const bad of [
      "2025-02-29", // not a leap year
      "2026-02-30",
      "2026-13-01",
      "2026-00-10",
      "2026-10-32",
      "2026-1-5", // unpadded
      "2026/10/25",
      "25-10-2026",
      "2026-10-25T00:00:00Z", // an instant, not a dateOnly
      "2026-10-25 ", // trailing space
      "October 25, 2026",
      "",
      null,
      undefined,
      20261025,
      new Date("2026-10-25"),
    ]) {
      expect(parseDateOnly(bad)).toBeNull();
    }
  });

  it("requireDateOnly throws a coded error", () => {
    expect(() => requireDateOnly("2026-02-30")).toThrow(DateTimeContractError);
    try {
      requireDateOnly("nope");
    } catch (e) {
      expect((e as DateTimeContractError).code).toBe(
        "DATETIME_INVALID_DATE_ONLY",
      );
    }
  });
});

describe("DateOnly arithmetic stays on the calendar axis", () => {
  it("addDaysToDateOnly crosses month/year/leap boundaries", () => {
    expect(addDaysToDateOnly("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDaysToDateOnly("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDaysToDateOnly("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDateOnly("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDaysToDateOnly("2026-10-25", -1)).toBe("2026-10-24");
  });

  it("compareDateOnly orders by calendar day", () => {
    expect(compareDateOnly("2026-10-25", "2026-10-26")).toBe(-1);
    expect(compareDateOnly("2026-10-26", "2026-10-25")).toBe(1);
    expect(compareDateOnly("2026-10-25", "2026-10-25")).toBe(0);
  });
});

describe("DateOnly is timezone-immune", () => {
  const zones = [
    "Pacific/Kiritimati", // UTC+14
    "Asia/Shanghai", // UTC+8
    "UTC",
    "America/New_York", // UTC-4/-5
    "Pacific/Pago_Pago", // UTC-11
  ];

  it.each(zones)("same literal survives system TZ=%s", (tz) => {
    process.env.TZ = tz;
    expect(parseDateOnly("2026-10-25")).toBe("2026-10-25");
    expect(dateOnlyParts("2026-10-25")).toEqual({
      year: 2026,
      month: 10,
      day: 25,
    });
    expect(addDaysToDateOnly("2026-10-25", 1)).toBe("2026-10-26");
  });

  it.each(zones)(
    "picker Date extracts the captured calendar day under TZ=%s",
    (tz) => {
      process.env.TZ = tz;
      // What react-day-picker hands back for an Oct-25 click.
      const picked = new Date(2026, 9, 25);
      expect(dateOnlyFromPickerDate(picked)).toBe("2026-10-25");
    },
  );

  it("todayDateOnly resolves the calendar day inside the given zone", () => {
    const now = new Date("2026-10-25T16:30:00.000Z");
    expect(todayDateOnly("UTC", now)).toBe("2026-10-25");
    expect(todayDateOnly("Asia/Shanghai", now)).toBe("2026-10-26");
    expect(todayDateOnly("America/New_York", now)).toBe("2026-10-25");
  });

  it("todayDateOnly requires an explicit zone — no silent runtime-zone fallback (F-2)", () => {
    const now = new Date("2026-10-25T16:30:00.000Z");
    const badZones: unknown[] = [undefined, null, ""];
    for (const bad of badZones) {
      try {
        todayDateOnly(bad as string, now);
        expect.unreachable(`${JSON.stringify(bad)} should have been rejected`);
      } catch (e) {
        expect((e as DateTimeContractError).code).toBe(
          "DATETIME_INVALID_TIMEZONE",
        );
      }
    }
  });
});

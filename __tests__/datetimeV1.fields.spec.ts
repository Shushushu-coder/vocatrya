// @vitest-environment node
import {
  classifyStoredInstant,
  completedAtNow,
  FIELD_TIME_CONTRACT,
  isDeadlineOverdue,
  parseBusinessTimeValue,
  parseDeadlineAtInput,
  parseScheduledAtInput,
  parseTimeOfDay12h,
  readStoredInstantAsBusinessTime,
  serializeBusinessTime,
  toBusinessTimeValue,
  DateTimeContractError,
  type BusinessTimeValue,
} from "@/lib/datetime";

describe("field contracts — write path", () => {
  it("scheduledAt requires a wall time at minute precision", () => {
    const v = parseScheduledAtInput(
      { date: "2026-10-25", hour: 14, minute: 30 },
      "Asia/Shanghai",
    );
    expect(v).toEqual({
      kind: "instant",
      iso: "2026-10-25T06:30:00.000Z",
      precision: "minute",
    });
  });

  it("scheduledAt accepts an explicit midnight the user actually typed", () => {
    const v = parseScheduledAtInput(
      { date: "2026-10-25", hour: 0, minute: 0 },
      "UTC",
    );
    expect(v).toEqual({
      kind: "instant",
      iso: "2026-10-25T00:00:00.000Z",
      precision: "minute",
    });
  });

  it("deadlineAt keeps a bare date as dateOnly — never fakes 23:59", () => {
    const v = parseDeadlineAtInput("2026-10-25", "Asia/Shanghai");
    expect(v).toEqual({ kind: "dateOnly", date: "2026-10-25" });
    // Crucially: no instant was minted.
    expect(v.kind).toBe("dateOnly");
  });

  it("deadlineAt accepts an explicit wall time as a minute instant", () => {
    const v = parseDeadlineAtInput(
      { date: "2026-10-25", hour: 17, minute: 0 },
      "Asia/Shanghai",
    );
    expect(v).toEqual({
      kind: "instant",
      iso: "2026-10-25T09:00:00.000Z",
      precision: "minute",
    });
  });

  it("completedAt is a full-precision system fact", () => {
    const fixed = new Date("2026-10-25T06:30:15.482Z");
    const v = completedAtNow(fixed);
    expect(v).toEqual({
      kind: "instant",
      iso: "2026-10-25T06:30:15.482Z",
      precision: "fullInstant",
    });
  });

  it("field descriptors pin the contract shape", () => {
    expect(FIELD_TIME_CONTRACT.scheduledAt.inputPrecision).toBe("minute");
    expect(FIELD_TIME_CONTRACT.deadlineAt.kind).toBe("dateOnlyOrDatetime");
    expect(FIELD_TIME_CONTRACT.completedAt.kind).toBe("instant");
  });
});

describe("deadline overdue — interval semantics", () => {
  // dateOnly "2026-10-25" in Asia/Shanghai occupies [16:00Z 10-24, 16:00Z 10-25).
  const deadline = parseDeadlineAtInput("2026-10-25", "Asia/Shanghai");

  it("a date-only deadline lasts the whole calendar day in its zone", () => {
    expect(
      isDeadlineOverdue(deadline, new Date("2026-10-25T15:59:59.999Z"), "Asia/Shanghai"),
    ).toBe(false);
    expect(
      isDeadlineOverdue(deadline, new Date("2026-10-25T16:00:00.000Z"), "Asia/Shanghai"),
    ).toBe(true);
  });

  it("the same date-only deadline ends at a different instant per zone", () => {
    // In UTC the day ends at 2026-10-26T00:00Z — four hours later than UTC+8.
    expect(
      isDeadlineOverdue(deadline, new Date("2026-10-25T16:30:00.000Z"), "UTC"),
    ).toBe(false);
    expect(
      isDeadlineOverdue(deadline, new Date("2026-10-26T00:00:00.000Z"), "UTC"),
    ).toBe(true);
  });

  it("a deadline carrying a real time compares as an instant", () => {
    const timed = parseDeadlineAtInput(
      { date: "2026-10-25", hour: 17, minute: 0 },
      "Asia/Shanghai",
    );
    expect(
      isDeadlineOverdue(timed, new Date("2026-10-25T09:00:00.000Z")),
    ).toBe(false); // equal is not yet overdue
    expect(
      isDeadlineOverdue(timed, new Date("2026-10-25T09:00:00.001Z")),
    ).toBe(true);
  });

  it("legacy stored instants keep instant semantics (status quo)", () => {
    // A pre-contract row: local-midnight write stored as an instant. We do NOT
    // reinterpret it as a dateOnly — it compares as the instant it is.
    const legacy = "2026-10-24T16:00:00.000Z"; // looked like Oct-25 in UTC+8
    expect(
      isDeadlineOverdue(legacy, new Date("2026-10-24T16:00:00.000Z")),
    ).toBe(false);
    expect(
      isDeadlineOverdue(legacy, new Date("2026-10-24T16:00:00.001Z")),
    ).toBe(true);
  });

  it("absent deadline is never overdue", () => {
    expect(isDeadlineOverdue(null)).toBe(false);
    expect(isDeadlineOverdue(undefined)).toBe(false);
  });
});

describe("historical values — truth kept, nothing fabricated", () => {
  it("null means absent — a known fact, not unknown precision", () => {
    const c = classifyStoredInstant(null);
    expect(c.kind).toBe("absent");
    expect(c.iso).toBeNull();
    expect(readStoredInstantAsBusinessTime(null)).toBeNull();
  });

  it("a stored instant stays an instant of unknown precision", () => {
    const c = classifyStoredInstant("2026-10-25T06:30:00.000Z");
    expect(c).toEqual({
      kind: "instant",
      iso: "2026-10-25T06:30:00.000Z",
      precision: "unknown",
      utcMidnight: false,
      onMinuteBoundary: true,
    });
    const v = readStoredInstantAsBusinessTime("2026-10-25T06:30:00.000Z");
    expect(v).toEqual({
      kind: "instant",
      iso: "2026-10-25T06:30:00.000Z",
      precision: "unknown",
    });
  });

  it("utcMidnight flags a suspect write without re-interpreting it", () => {
    const c = classifyStoredInstant(new Date("2026-10-25T00:00:00.000Z"));
    expect(c.utcMidnight).toBe(true);
    expect(c.kind).toBe("instant"); // still an instant — flag is informational
  });

  it("unreadable stored values surface as errors, not silent defaults", () => {
    expect(() => classifyStoredInstant("garbage")).toThrow(
      DateTimeContractError,
    );
  });
});

describe("serialization — precision survives the boundary", () => {
  it("round-trips every variant", () => {
    const cases: BusinessTimeValue[] = [
      { kind: "dateOnly", date: "2026-10-25" },
      { kind: "instant", iso: "2026-10-25T06:30:00.000Z", precision: "minute" },
      {
        kind: "instant",
        iso: "2026-10-25T06:30:15.482Z",
        precision: "fullInstant",
      },
      { kind: "instant", iso: "2026-10-25T06:30:00.000Z", precision: "unknown" },
    ];
    for (const v of cases) {
      expect(parseBusinessTimeValue(serializeBusinessTime(v))).toEqual(v);
    }
  });

  it("rejects mismatched precision/value envelopes", () => {
    expect(() =>
      parseBusinessTimeValue({ value: "2026-10-25T06:30:00.000Z", precision: "dateOnly" }),
    ).toThrow(DateTimeContractError);
    expect(() =>
      parseBusinessTimeValue({ value: "2026-10-25", precision: "minute" }),
    ).toThrow(DateTimeContractError);
  });

  it("toBusinessTimeValue coerces raw shapes honestly", () => {
    expect(toBusinessTimeValue("2026-10-25")).toEqual({
      kind: "dateOnly",
      date: "2026-10-25",
    });
    const viaIso = toBusinessTimeValue("2026-10-25T06:30:00.000Z");
    expect(viaIso).toMatchObject({ kind: "instant", precision: "unknown" });
    const viaDate = toBusinessTimeValue(new Date("2026-10-25T06:30:00.000Z"));
    expect(viaDate).toMatchObject({ kind: "instant", precision: "unknown" });
    expect(() => toBusinessTimeValue("25/10/2026")).toThrow(
      DateTimeContractError,
    );
  });
});

describe("UI bridges", () => {
  it("parseTimeOfDay12h reads the TimePicker wire form", () => {
    expect(parseTimeOfDay12h("02:30 PM")).toEqual({ hour: 14, minute: 30 });
    expect(parseTimeOfDay12h("12:00 AM")).toEqual({ hour: 0, minute: 0 });
    expect(parseTimeOfDay12h("12:30 PM")).toEqual({ hour: 12, minute: 30 });
    expect(parseTimeOfDay12h("09:05 am")).toEqual({ hour: 9, minute: 5 });
    for (const bad of ["24:00 AM", "13:00 PM", "00:30 AM", "2:60 PM", "14:30", ""]) {
      expect(parseTimeOfDay12h(bad)).toBeNull();
    }
  });
});

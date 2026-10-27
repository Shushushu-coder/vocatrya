// @vitest-environment node
//
// Picker-pair -> StepTimeInput bridge: the wire contract for the step-time
// form fields (date picker + 12h time picker), including backfill rules that
// never invent precision for historical unknown values.
import {
  pickerDateFromDateOnly,
  stepTimeFieldFromStored,
  stepTimeInputFromField,
} from "@/components/myjobs/job-details/stepTimeFields";

describe("stepTimeInputFromField", () => {
  it("returns null for an untouched empty pair", () => {
    expect(
      stepTimeInputFromField("scheduledAt", { date: null, time: "" }),
    ).toEqual({ ok: true, value: null });
    expect(
      stepTimeInputFromField("deadlineAt", { date: null, time: "" }),
    ).toEqual({ ok: true, value: null });
  });

  it("rejects a scheduled date without a time", () => {
    expect(
      stepTimeInputFromField("scheduledAt", {
        date: new Date(2026, 9, 20),
        time: "",
      }),
    ).toEqual({ ok: false, reason: "time-required" });
  });

  it("converts a scheduled date+time pair to a wallTime input", () => {
    expect(
      stepTimeInputFromField("scheduledAt", {
        date: new Date(2026, 9, 20),
        time: "02:30 PM",
      }),
    ).toEqual({
      ok: true,
      value: { kind: "wallTime", date: "2026-10-20", hour: 14, minute: 30 },
    });
  });

  it("keeps a bare deadline date as dateOnly", () => {
    expect(
      stepTimeInputFromField("deadlineAt", {
        date: new Date(2026, 9, 25),
        time: "",
      }),
    ).toEqual({ ok: true, value: { kind: "dateOnly", date: "2026-10-25" } });
  });

  it("converts a timed deadline to a wallTime input", () => {
    expect(
      stepTimeInputFromField("deadlineAt", {
        date: new Date(2026, 9, 25),
        time: "06:00 PM",
      }),
    ).toEqual({
      ok: true,
      value: { kind: "wallTime", date: "2026-10-25", hour: 18, minute: 0 },
    });
  });

  it("rejects a clock time with no day instead of silently clearing", () => {
    expect(
      stepTimeInputFromField("deadlineAt", { date: null, time: "02:30 PM" }),
    ).toEqual({ ok: false, reason: "date-required" });
    expect(
      stepTimeInputFromField("scheduledAt", { date: null, time: "09:00 AM" }),
    ).toEqual({ ok: false, reason: "date-required" });
  });

  it("flags malformed time strings", () => {
    expect(
      stepTimeInputFromField("deadlineAt", {
        date: new Date(2026, 9, 25),
        time: "25:99",
      }),
    ).toEqual({ ok: false, reason: "invalid-time" });
  });
});

describe("stepTimeFieldFromStored", () => {
  const tz = "Asia/Shanghai";

  it("backfills a minute instant as date + 12h wall time in the account zone", () => {
    // 2026-10-20 14:30 Asia/Shanghai = 06:30Z.
    expect(
      stepTimeFieldFromStored(
        {
          iso: "2026-10-20T06:30:00.000Z",
          precision: "minute",
          dateOnly: null,
          zone: "Asia/Shanghai",
        },
        tz,
      ),
    ).toEqual({
      date: pickerDateFromDateOnly("2026-10-20"),
      time: "02:30 PM",
    });
  });

  it("uses the new account zone when editing after a time-zone change", () => {
    const field = stepTimeFieldFromStored(
      {
        iso: "2026-10-20T06:30:00.000Z",
        precision: "minute",
        dateOnly: null,
        zone: "Asia/Shanghai",
      },
      "America/New_York",
    );
    expect(field).toEqual({
      date: pickerDateFromDateOnly("2026-10-20"),
      time: "02:30 AM",
    });
    // Moving the date by one day retains 02:30 in the zone the server uses.
    expect(stepTimeInputFromField("scheduledAt", {
      ...field, date: pickerDateFromDateOnly("2026-10-21"),
    })).toEqual({
      ok: true,
      value: { kind: "wallTime", date: "2026-10-21", hour: 2, minute: 30 },
    });
  });

  it("backfills a dateOnly deadline as a bare day", () => {
    expect(
      stepTimeFieldFromStored(
        {
          iso: null,
          precision: "dateOnly",
          dateOnly: "2026-10-25",
          zone: "Asia/Shanghai",
        },
        tz,
      ),
    ).toEqual({ date: pickerDateFromDateOnly("2026-10-25"), time: "" });
  });

  it("backfills an unknown instant as the day only — no invented clock", () => {
    const field = stepTimeFieldFromStored(
      {
        iso: "2026-10-20T16:30:00.000Z",
        precision: "unknown",
        dateOnly: null,
        zone: null,
      },
      tz,
    );
    // 16:30Z is already 10-21 in Shanghai — the *account-zone* day wins.
    expect(field.date).toEqual(pickerDateFromDateOnly("2026-10-21"));
    expect(field.time).toBe("");
  });

  it("returns an empty pair when nothing is stored", () => {
    expect(
      stepTimeFieldFromStored(
        { iso: null, precision: null, dateOnly: null, zone: null },
        tz,
      ),
    ).toEqual({ date: null, time: "" });
  });
});

describe("pickerDateFromDateOnly", () => {
  it("round-trips through the picker's local y/m/d rule", () => {
    const d = pickerDateFromDateOnly("2024-02-29");
    expect(d.getFullYear()).toBe(2024);
    expect(d.getMonth()).toBe(1);
    expect(d.getDate()).toBe(29);
  });
});

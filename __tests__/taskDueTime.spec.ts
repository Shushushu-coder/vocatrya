// @vitest-environment node
import {
  formatTaskDue,
  orderTasksByDue,
  taskDueBusinessValue,
  taskDueCalendarDay,
  taskDueDateGroup,
  taskDuePickerDate,
  taskDuePrecision,
  taskDueSortKeyIso,
} from "@/lib/tasks/dueTime";
import { dateOnlyUtcWindow } from "@/lib/datetime";

const SH = "Asia/Shanghai"; // UTC+8, no DST
const NY = "America/New_York";

describe("taskDueBusinessValue — deterministic carrier rule", () => {
  it("declared dateOnly wins", () => {
    expect(
      taskDueBusinessValue({
        dueOn: "2026-03-15",
        dueDate: null,
        duePrecision: "dateOnly",
      }),
    ).toEqual({ kind: "dateOnly", date: "2026-03-15" });
  });

  it("dateOnly declaration wins over a contradictory instant", () => {
    expect(
      taskDueBusinessValue({
        dueOn: "2026-03-15",
        dueDate: new Date("2026-01-01T00:00:00.000Z"),
        duePrecision: "dateOnly",
      }),
    ).toEqual({ kind: "dateOnly", date: "2026-03-15" });
  });

  it("stored instant without declaration is an unknown instant", () => {
    expect(
      taskDueBusinessValue({
        dueOn: null,
        dueDate: new Date("2026-03-15T02:00:00.000Z"),
        duePrecision: null,
      }),
    ).toEqual({
      kind: "instant",
      iso: "2026-03-15T02:00:00.000Z",
      precision: "unknown",
    });
  });

  it("declared minute precision is preserved", () => {
    expect(
      taskDueBusinessValue({
        dueOn: null,
        dueDate: "2026-03-15T02:00:00.000Z",
        duePrecision: "minute",
      }),
    ).toEqual({
      kind: "instant",
      iso: "2026-03-15T02:00:00.000Z",
      precision: "minute",
    });
  });

  it("unrecognised precision on an instant reads unknown", () => {
    expect(
      taskDueBusinessValue({
        dueOn: null,
        dueDate: new Date("2026-03-15T02:00:00.000Z"),
        duePrecision: "banana",
      }),
    ).toEqual({
      kind: "instant",
      iso: "2026-03-15T02:00:00.000Z",
      precision: "unknown",
    });
  });

  it("dueOn without the dateOnly declaration has no valid carrier", () => {
    expect(
      taskDueBusinessValue({
        dueOn: "2026-03-15",
        dueDate: null,
        duePrecision: null,
      }),
    ).toBeNull();
    expect(
      taskDueBusinessValue({
        dueOn: "2026-03-15",
        dueDate: null,
        duePrecision: "minute",
      }),
    ).toBeNull();
  });

  it("empty row has no due", () => {
    expect(
      taskDueBusinessValue({ dueOn: null, dueDate: null, duePrecision: null }),
    ).toBeNull();
  });

  it("declared-but-corrupt dateOnly is a data-plane error, not a downgrade", () => {
    expect(() =>
      taskDueBusinessValue({
        dueOn: "2026-13-40",
        dueDate: null,
        duePrecision: "dateOnly",
      }),
    ).toThrow();
  });
});

describe("taskDuePrecision — DTO normalization", () => {
  it.each([
    [
      { dueOn: "2026-03-15", dueDate: null, duePrecision: "dateOnly" },
      "dateOnly",
    ],
    [
      { dueOn: null, dueDate: new Date("2026-03-15T02:00:00Z"), duePrecision: "minute" },
      "minute",
    ],
    [
      { dueOn: null, dueDate: new Date("2026-03-15T02:00:00Z"), duePrecision: null },
      "unknown",
    ],
    [
      { dueOn: null, dueDate: new Date("2026-03-15T02:00:00Z"), duePrecision: "dateOnly" },
      // contradictory: dateOnly precision on an instant carrier
      "unknown",
    ],
    [{ dueOn: null, dueDate: null, duePrecision: null }, null],
    // dueOn without declaration: no carrier → null, not leaked as "unknown"
    [{ dueOn: "2026-03-15", dueDate: null, duePrecision: null }, null],
  ])("%j → %s", (row, expected) => {
    expect(taskDuePrecision(row)).toBe(expected);
  });
});

describe("taskDueSortKeyIso — §5.2 key", () => {
  it("dateOnly maps to endIsoExclusive in the account zone", () => {
    const row = { dueOn: "2026-10-25", dueDate: null, duePrecision: "dateOnly" };
    expect(taskDueSortKeyIso(row, SH)).toBe(
      dateOnlyUtcWindow("2026-10-25", SH).endIsoExclusive,
    );
    // Asia/Shanghai day end = next local midnight = 2026-10-25T16:00:00Z
    expect(taskDueSortKeyIso(row, SH)).toBe("2026-10-25T16:00:00.000Z");
  });

  it("instant maps to itself", () => {
    const row = {
      dueOn: null,
      dueDate: new Date("2026-10-25T02:00:00.000Z"),
      duePrecision: "minute",
    };
    expect(taskDueSortKeyIso(row, SH)).toBe("2026-10-25T02:00:00.000Z");
  });

  it("no due maps to null", () => {
    expect(
      taskDueSortKeyIso({ dueOn: null, dueDate: null, duePrecision: null }, SH),
    ).toBeNull();
  });
});

describe("orderTasksByDue — §5.2 total order", () => {
  const row = (
    id: string,
    due: { dueOn?: string; dueDate?: string; duePrecision?: string | null },
    priority = 5,
  ) => ({
    id,
    dueOn: due.dueOn ?? null,
    dueDate: due.dueDate ? new Date(due.dueDate) : null,
    duePrecision: due.duePrecision ?? null,
    priority,
  });

  it("orders instant → dateOnly-day-end → next instant → NULL last (§5.2 example)", () => {
    // userTz = Asia/Shanghai
    const t1 = row("T1", { dueDate: "2026-10-25T02:00:00.000Z" }); // 10:00 local
    const t2 = row("T2", { dueOn: "2026-10-25", duePrecision: "dateOnly" });
    const t3 = row("T3", { dueDate: "2026-10-26T00:30:00.000Z" }); // 08:30 next day
    const t4 = row("T4", {}); // NULL
    const ordered = orderTasksByDue([t4, t3, t2, t1], SH).map((r) => r.id);
    expect(ordered).toEqual(["T1", "T2", "T3", "T4"]);
  });

  it("NULL always sorts last regardless of input order", () => {
    const a = row("a", { dueOn: "2026-01-01", duePrecision: "dateOnly" });
    const n1 = row("n1", {});
    const b = row("b", { dueDate: "2025-01-01T00:00:00.000Z" });
    const n2 = row("n2", {});
    expect(orderTasksByDue([n1, a, n2, b], SH).map((r) => r.id)).toEqual([
      "b",
      "a",
      "n1",
      "n2",
    ]);
  });

  it("same key → priority desc → id asc", () => {
    const mk = (id: string, priority: number) =>
      row(id, { dueOn: "2026-06-15", duePrecision: "dateOnly" }, priority);
    const ordered = orderTasksByDue(
      [mk("b", 5), mk("a", 5), mk("c", 9), mk("d", 9)],
      SH,
    ).map((r) => r.id);
    expect(ordered).toEqual(["c", "d", "a", "b"]);
  });

  it("instant and dateOnly sharing the same key tie-break deterministically", () => {
    const endIso = dateOnlyUtcWindow("2026-06-15", SH).endIsoExclusive;
    const instantAtBoundary = row("i", { dueDate: endIso });
    const dateOnlyRow = row("d", {
      dueOn: "2026-06-15",
      duePrecision: "dateOnly",
    });
    const ordered = orderTasksByDue([dateOnlyRow, instantAtBoundary], SH).map(
      (r) => r.id,
    );
    // same key, same priority → id asc: "d" < "i"
    expect(ordered).toEqual(["d", "i"]);
  });
});

describe("taskDueCalendarDay / taskDueDateGroup — account-zone calendar", () => {
  it("dateOnly keeps its calendar day in any zone", () => {
    const row = { dueOn: "2026-03-15", dueDate: null, duePrecision: "dateOnly" };
    expect(taskDueCalendarDay(row, SH)).toBe("2026-03-15");
    expect(taskDueCalendarDay(row, NY)).toBe("2026-03-15");
  });

  it("instant maps to its wall date in the account zone", () => {
    // 2026-03-15T20:00Z = 03-16 04:00 in Shanghai, 03-15 16:00 in New York
    const row = {
      dueOn: null,
      dueDate: new Date("2026-03-15T20:00:00.000Z"),
      duePrecision: "unknown",
    };
    expect(taskDueCalendarDay(row, SH)).toBe("2026-03-16");
    expect(taskDueCalendarDay(row, NY)).toBe("2026-03-15");
  });

  it("buckets around the account-zone today", () => {
    // 2026-10-21T16:00Z: still 10-21 in NY, already 10-22 in SH
    const now = new Date("2026-10-21T16:00:00.000Z");
    const mk = (dueOn: string) => ({
      dueOn,
      dueDate: null,
      duePrecision: "dateOnly",
    });
    expect(taskDueDateGroup(mk("2026-10-20"), SH, now)).toBe("Overdue");
    expect(taskDueDateGroup(mk("2026-10-22"), SH, now)).toBe("Today");
    expect(taskDueDateGroup(mk("2026-10-23"), SH, now)).toBe("Tomorrow");
    expect(taskDueDateGroup(mk("2026-10-21"), NY, now)).toBe("Today");
    expect(
      taskDueDateGroup({ dueOn: null, dueDate: null, duePrecision: null }, SH, now),
    ).toBe("No Due Date");
  });

  it("an instant is overdue the moment it is reached, even earlier today", () => {
    // 15:00 Asia/Shanghai = 07:00Z; an 08:00-local instant (00:00Z) already
    // passed → Overdue, while a 23:00-local instant (15:00Z) is still Today.
    const now = new Date("2026-10-22T07:00:00.000Z");
    const mkInstant = (iso: string) => ({
      dueOn: null,
      dueDate: new Date(iso),
      duePrecision: "minute",
    });
    expect(
      taskDueDateGroup(mkInstant("2026-10-22T00:00:00.000Z"), SH, now),
    ).toBe("Overdue");
    expect(
      taskDueDateGroup(mkInstant("2026-10-22T15:00:00.000Z"), SH, now),
    ).toBe("Today");
    // …while a DateOnly on the same day is still valid → Today.
    expect(
      taskDueDateGroup(
        { dueOn: "2026-10-22", dueDate: null, duePrecision: "dateOnly" },
        SH,
        now,
      ),
    ).toBe("Today");
  });

  it("This Week covers the rest of the current Sunday-start week", () => {
    // now = Thursday 2026-10-22 local (NY), week Sun 10-18 .. Sat 10-24
    const now = new Date("2026-10-22T12:00:00.000Z");
    const mk = (dueOn: string) => ({
      dueOn,
      dueDate: null,
      duePrecision: "dateOnly",
    });
    expect(taskDueDateGroup(mk("2026-10-24"), NY, now)).toBe("This Week");
    expect(taskDueDateGroup(mk("2026-10-25"), NY, now)).toBe("Later");
    // Saturday today → nothing after tomorrow stays "This Week"
    const saturday = new Date("2026-10-24T12:00:00.000Z");
    expect(taskDueDateGroup(mk("2026-10-26"), NY, saturday)).toBe("Later");
  });
});

describe("taskDuePickerDate — local construction, never UTC-parse", () => {
  it("builds a local-midnight Date with the same y/m/d", () => {
    const d = taskDuePickerDate(
      { dueOn: "2026-03-15", dueDate: null, duePrecision: "dateOnly" },
      SH,
    )!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(15);
    expect(d.getHours()).toBe(0);
  });

  it("unknown instant prefills its account-zone wall date", () => {
    const d = taskDuePickerDate(
      {
        dueOn: null,
        dueDate: new Date("2026-03-15T20:00:00.000Z"),
        duePrecision: null,
      },
      SH,
    )!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(2);
    expect(d.getDate()).toBe(16);
  });

  it("no due → undefined", () => {
    expect(
      taskDuePickerDate({ dueOn: null, dueDate: null, duePrecision: null }, SH),
    ).toBeUndefined();
  });
});

describe("formatTaskDue — precision-aware display", () => {
  it("dateOnly renders verbatim, drift-free in any zone", () => {
    const row = { dueOn: "2026-03-15", dueDate: null, duePrecision: "dateOnly" };
    expect(formatTaskDue(row, "en", SH)).toBe("Mar 15, 2026");
    expect(formatTaskDue(row, "en", NY)).toBe("Mar 15, 2026");
  });

  it("unknown instant shows only the account-zone date (D7)", () => {
    const row = {
      dueOn: null,
      dueDate: new Date("2026-03-15T20:00:00.000Z"),
      duePrecision: null,
    };
    expect(formatTaskDue(row, "en", SH)).toBe("Mar 16, 2026");
    expect(formatTaskDue(row, "en", NY)).toBe("Mar 15, 2026");
  });

  it("minute instant shows date and time in the account zone", () => {
    const row = {
      dueOn: null,
      dueDate: new Date("2026-03-15T06:30:00.000Z"),
      duePrecision: "minute",
    };
    const rendered = formatTaskDue(row, "en", SH)!;
    expect(rendered).toContain("Mar 15, 2026");
    expect(rendered).toContain("2:30");
  });

  it("no due → null", () => {
    expect(
      formatTaskDue({ dueOn: null, dueDate: null, duePrecision: null }, "en", SH),
    ).toBeNull();
  });
});

// @vitest-environment node
import { businessTimeFromColumns } from "@/lib/datetime";

describe("business time column precision", () => {
  it.each([null, "unknown", "invalid", "minute"])(
    "does not infer DateOnly from an orphan date with precision %s",
    (precision) => {
      expect(businessTimeFromColumns({
        dateOnly: "2026-10-20", instant: null, precision,
      })).toBeNull();
    },
  );

  it("keeps an undeclared instant unknown when an orphan date also exists", () => {
    expect(businessTimeFromColumns({
      dateOnly: "2026-10-20",
      instant: "2026-10-21T00:00:00.000Z",
      precision: null,
    })).toEqual({
      kind: "instant", iso: "2026-10-21T00:00:00.000Z", precision: "unknown",
    });
  });

  it("reads a declared DateOnly and rejects invalid declared calendar text", () => {
    expect(businessTimeFromColumns({
      dateOnly: "2026-10-20", instant: null, precision: "dateOnly",
    })).toEqual({ kind: "dateOnly", date: "2026-10-20" });
    expect(() => businessTimeFromColumns({
      dateOnly: "2026-02-30", instant: null, precision: "dateOnly",
    })).toThrow();
  });
});

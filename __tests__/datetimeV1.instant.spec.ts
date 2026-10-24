// @vitest-environment node
import {
  assertMinutePrecision,
  isInstantShape,
  isOnMinuteBoundary,
  isUtcMidnight,
  parseInstantIso,
  requireInstantIso,
  toInstantIso,
  DateTimeContractError,
} from "@/lib/datetime";

describe("parseInstantIso — strict instant boundary", () => {
  it("accepts Z and numeric-offset forms, normalizing to canonical UTC", () => {
    expect(parseInstantIso("2026-10-25T14:30:00Z")).toBe(
      "2026-10-25T14:30:00.000Z",
    );
    expect(parseInstantIso("2026-10-25T14:30:45.123Z")).toBe(
      "2026-10-25T14:30:45.123Z",
    );
    // Numeric offset is honored, including crossing the UTC date line.
    expect(parseInstantIso("2026-10-25T14:30:00+08:00")).toBe(
      "2026-10-25T06:30:00.000Z",
    );
    expect(parseInstantIso("2026-10-25T01:30:00+08:00")).toBe(
      "2026-10-24T17:30:00.000Z",
    );
    expect(parseInstantIso("2026-10-25T14:30:00-05:00")).toBe(
      "2026-10-25T19:30:00.000Z",
    );
    // A minute-precision wire form (no seconds) is still an instant.
    expect(parseInstantIso("2026-10-25T14:30Z")).toBe(
      "2026-10-25T14:30:00.000Z",
    );
  });

  it("rejects date-only and offset-less shapes (they are not instants)", () => {
    for (const bad of [
      "2026-10-25", // DateOnly — refused here by design
      "2026-10-25T14:30", // wall time without zone — refused
      "2026-10-25T14:30:00", // seconds but still no offset
      "2026-10-25 14:30:00Z",
      "2026-10-25T14:30:00+0800",
      "2026-10-25T14:30:00+08",
      "",
      null,
      undefined,
      12345,
    ]) {
      expect(parseInstantIso(bad)).toBeNull();
    }
  });

  it("rejects impossible field values", () => {
    for (const bad of [
      "2026-02-30T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "2026-10-25T24:00:00Z",
      "2026-10-25T10:60:00Z",
      "2026-10-25T10:00:60Z",
      "2025-02-29T00:00:00Z",
      // offset shifts the UTC date but the declared local fields stay valid
      "2026-02-30T10:00:00+08:00",
    ]) {
      expect(parseInstantIso(bad)).toBeNull();
    }
  });
});

describe("instant helpers", () => {
  it("toInstantIso serializes and rejects invalid Dates", () => {
    expect(toInstantIso(new Date("2026-10-25T06:30:00Z"))).toBe(
      "2026-10-25T06:30:00.000Z",
    );
    expect(() => toInstantIso(new Date("not a date"))).toThrow(
      DateTimeContractError,
    );
  });

  it("precision markers are informational only", () => {
    expect(isUtcMidnight("2026-10-25T00:00:00.000Z")).toBe(true);
    expect(isUtcMidnight("2026-10-25T00:00:01.000Z")).toBe(false);
    expect(isOnMinuteBoundary("2026-10-25T14:30:00.000Z")).toBe(true);
    expect(isOnMinuteBoundary("2026-10-25T14:30:00.500Z")).toBe(false);
  });

  it("assertMinutePrecision rejects sub-minute instants", () => {
    expect(assertMinutePrecision("2026-10-25T14:30:00.000Z")).toBe(
      "2026-10-25T14:30:00.000Z",
    );
    for (const sub of [
      "2026-10-25T14:30:15.000Z",
      "2026-10-25T14:30:00.500Z",
      "2026-10-25T14:30:00.001Z",
    ]) {
      try {
        assertMinutePrecision(sub);
        expect.unreachable(`${sub} should have been rejected`);
      } catch (e) {
        expect((e as DateTimeContractError).code).toBe(
          "DATETIME_SUBMINUTE_INPUT",
        );
      }
    }
  });

  it("isInstantShape only reports shape, not calendar validity", () => {
    expect(isInstantShape("2026-10-25T14:30:00Z")).toBe(true);
    expect(isInstantShape("2026-10-25")).toBe(false);
    expect(isInstantShape("2026-02-30T00:00:00Z")).toBe(true);
    expect(parseInstantIso("2026-02-30T00:00:00Z")).toBeNull();
  });

  it("requireInstantIso carries a stable error code", () => {
    try {
      requireInstantIso("2026-10-25");
      expect.unreachable();
    } catch (e) {
      expect((e as DateTimeContractError).code).toBe("DATETIME_INVALID_INSTANT");
    }
  });
});

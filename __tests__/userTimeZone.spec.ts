// @vitest-environment node
/**
 * P-TZ read contract: storedUserTimeZone/resolveUserTimeZone on the
 * settings document, getUserTimeZone on a mocked store, and the
 * canonical-IANA gate every write must pass.
 */
import { describe, expect, it, vi } from "vitest";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", () => ({
  default: { userSettings: { findUnique } },
}));

import {
  isSupportedTimeZone,
  listSupportedTimeZones,
  resolveUserTimeZone,
  storedUserTimeZone,
  timeZoneOffsetLabel,
} from "@/lib/userSettings/timeZone";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";

const RUNTIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const doc = (timeZone: unknown) => ({
  ai: { provider: "ollama" },
  display: { theme: "system" },
  settings: { general: { timeZone } },
});

describe("isSupportedTimeZone — IANA gate", () => {
  it("accepts canonical identifiers, link names and the UTC special case", () => {
    for (const zone of [
      "Asia/Shanghai",
      "America/New_York",
      "Europe/Berlin",
      // Etc/* zones are canonical TZDB IDs omitted from this ICU's
      // supportedValuesOf — fixed-offset users legitimately need them.
      "Etc/GMT+8",
      "Etc/UTC",
      // Real IANA link names: they resolve unambiguously, so honoring
      // them is safer than silently treating a stored one as unset.
      "Asia/Chongqing",
      "US/Pacific",
      "UTC",
    ]) {
      expect(isSupportedTimeZone(zone)).toBe(true);
    }
  });

  it("rejects abbreviations, fixed offsets and bare aliases Intl parses anyway", () => {
    // ICU resolves each of these without error, but none is an Area/
    // Location identifier — storing them would smuggle ambiguous or
    // DST-blind semantics.
    for (const bad of [
      "CST",
      "PST",
      "EST",
      "+08:00",
      "-05:00",
      "GMT",
      "zulu",
      "PRC",
      "Hongkong",
      "GMT+8",
      "8",
      "",
      " Asia/Shanghai",
      "Mars/Olympus",
    ]) {
      expect(isSupportedTimeZone(bad)).toBe(false);
    }
  });

  it("rejects non-string input", () => {
    for (const bad of [null, undefined, 42, true, {}, [], ["Asia/Shanghai"]]) {
      expect(isSupportedTimeZone(bad)).toBe(false);
    }
  });
});

describe("listSupportedTimeZones", () => {
  it("returns canonical zones with UTC guaranteed present", () => {
    const zones = listSupportedTimeZones();
    expect(zones.length).toBeGreaterThan(300);
    expect(zones).toContain("Asia/Shanghai");
    expect(zones).toContain("UTC");
    // Every picker option must survive the write-path gate.
    for (const zone of zones.slice(0, 25)) {
      expect(isSupportedTimeZone(zone)).toBe(true);
    }
  });
});

describe("storedUserTimeZone — dirty-document reader", () => {
  it("returns the stored canonical zone", () => {
    expect(storedUserTimeZone(doc("Asia/Shanghai"))).toBe("Asia/Shanghai");
    expect(storedUserTimeZone(doc("UTC"))).toBe("UTC");
  });

  it("treats missing, null, non-string and non-canonical values as unset", () => {
    for (const bad of [
      doc(undefined),
      doc(null),
      doc(42),
      doc({}),
      doc("CST"),
      doc("+08:00"),
      doc("Mars/Olympus"),
      doc(""),
      { settings: { general: {} } },
      { settings: {} },
      {},
      null,
      undefined,
      "not an object",
      42,
    ]) {
      expect(storedUserTimeZone(bad)).toBeNull();
    }
  });

  it("reads the same path on the getUserSettings data.settings shape", () => {
    const data = { userId: "u-1", settings: doc("Europe/Berlin") };
    // data.settings is the document — the envelope itself is not.
    expect(storedUserTimeZone(data.settings)).toBe("Europe/Berlin");
  });
});

describe("resolveUserTimeZone — single fallback rule", () => {
  it("returns the stored zone when set", () => {
    expect(resolveUserTimeZone(doc("Asia/Shanghai"))).toBe("Asia/Shanghai");
  });

  it("falls back to the runtime zone when unset or dirty", () => {
    expect(resolveUserTimeZone(doc(undefined))).toBe(RUNTIME_ZONE);
    expect(resolveUserTimeZone(doc("CST"))).toBe(RUNTIME_ZONE);
    expect(resolveUserTimeZone(null)).toBe(RUNTIME_ZONE);
    expect(resolveUserTimeZone("garbage")).toBe(RUNTIME_ZONE);
  });
});

describe("getUserTimeZone — server read", () => {
  it("returns the stored zone", async () => {
    findUnique.mockResolvedValue({
      settings: JSON.stringify(doc("Asia/Shanghai")),
    });
    await expect(getUserTimeZone("u-1")).resolves.toBe("Asia/Shanghai");
    expect(findUnique).toHaveBeenCalledWith({
      where: { userId: "u-1" },
      select: { settings: true },
    });
  });

  it("returns the runtime zone when the row is missing", async () => {
    findUnique.mockResolvedValue(null);
    await expect(getUserTimeZone("u-1")).resolves.toBe(RUNTIME_ZONE);
  });

  it("returns the runtime zone on corrupt JSON instead of throwing", async () => {
    findUnique.mockResolvedValue({ settings: "{not json" });
    await expect(getUserTimeZone("u-1")).resolves.toBe(RUNTIME_ZONE);
  });

  it("returns the runtime zone when the stored zone is not canonical", async () => {
    findUnique.mockResolvedValue({
      settings: JSON.stringify(doc("+08:00")),
    });
    await expect(getUserTimeZone("u-1")).resolves.toBe(RUNTIME_ZONE);
  });
});

describe("timeZoneOffsetLabel", () => {
  it("formats longOffset labels", () => {
    expect(timeZoneOffsetLabel("Asia/Shanghai", new Date("2026-01-15T00:00:00Z")))
      .toBe("GMT+08:00");
    expect(
      timeZoneOffsetLabel("America/New_York", new Date("2026-01-15T00:00:00Z")),
    ).toBe("GMT-05:00");
    expect(timeZoneOffsetLabel("UTC")).toBe("GMT+00:00");
  });

  it("returns empty string for an unformattable zone", () => {
    expect(timeZoneOffsetLabel("not/a-zone")).toBe("");
  });
});

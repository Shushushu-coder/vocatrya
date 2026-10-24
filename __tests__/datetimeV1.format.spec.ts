// @vitest-environment node
import {
  formatDateOnly,
  formatDateOnlyMonthYear,
  formatInstant,
} from "@/lib/datetime";

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe("formatDateOnly — locale rendering that cannot drift", () => {
  it("renders zh-CN and en like the existing formatters", () => {
    expect(formatDateOnly("2026-10-25", "zh-CN")).toBe("2026年10月25日");
    expect(formatDateOnly("2026-10-25", "en")).toBe("Oct 25, 2026");
  });

  it.each([
    "Pacific/Kiritimati", // UTC+14 — the extreme east
    "Asia/Shanghai",
    "UTC",
    "America/New_York",
    "Pacific/Pago_Pago", // UTC-11 — the extreme west
  ])("shows the same calendar day under system TZ=%s", (tz) => {
    process.env.TZ = tz;
    expect(formatDateOnly("2026-10-25", "zh-CN")).toBe("2026年10月25日");
    expect(formatDateOnly("2026-10-25", "en")).toBe("Oct 25, 2026");
  });

  it("formatDateOnlyMonthYear matches existing month-year conventions", () => {
    expect(formatDateOnlyMonthYear("2026-10-25", "zh-CN")).toBe("2026年10月");
    expect(formatDateOnlyMonthYear("2026-10-25", "en")).toBe("Oct 2026");
  });
});

describe("formatInstant — instants do render per zone", () => {
  const iso = "2026-10-25T06:30:00.000Z"; // 14:30 in Shanghai

  it("renders with an explicit viewing zone regardless of system TZ", () => {
    for (const sysTz of ["Pacific/Kiritimati", "UTC", "Pacific/Pago_Pago"]) {
      process.env.TZ = sysTz;
      expect(formatInstant(iso, "zh-CN", "Asia/Shanghai")).toBe(
        "2026/10/25 14:30",
      );
      expect(formatInstant(iso, "en", "Asia/Shanghai")).toBe(
        "Oct 25, 2026, 2:30 PM",
      );
    }
  });

  it("without a zone it renders in the runtime zone (today's behavior)", () => {
    process.env.TZ = "Asia/Shanghai";
    expect(formatInstant(iso, "zh-CN")).toBe("2026/10/25 14:30");
    process.env.TZ = "UTC";
    expect(formatInstant(iso, "zh-CN")).toBe("2026/10/25 06:30");
  });

  it("same instant shifts calendar day across zones, honestly", () => {
    const iso = "2026-10-25T16:30:00.000Z";
    expect(formatInstant(iso, "en", "UTC")).toBe("Oct 25, 2026, 4:30 PM");
    expect(formatInstant(iso, "en", "Asia/Shanghai")).toBe(
      "Oct 26, 2026, 12:30 AM",
    );
  });
});

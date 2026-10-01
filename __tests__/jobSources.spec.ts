import {
  missingDefaultJobSources,
  resolveJobSourceIdentity,
  resolveSystemJobSourceValue,
} from "@/lib/jobs/jobSources";

describe("job source identity", () => {
  it("maps China default channel names onto stable values", () => {
    expect(resolveSystemJobSourceValue("官网")).toBe("careerpage");
    expect(resolveSystemJobSourceValue("Official Website")).toBe("careerpage");
    expect(resolveSystemJobSourceValue("实习僧")).toBe("shixiseng");
    expect(resolveSystemJobSourceValue("Shixiseng")).toBe("shixiseng");
    expect(resolveSystemJobSourceValue("BOSS直聘")).toBe("boss zhipin");
    expect(resolveSystemJobSourceValue("内推群")).toBe("referral group");
    expect(resolveSystemJobSourceValue("小红书")).toBe("xiaohongshu");
  });

  it("trims and rejects empty or oversized labels", () => {
    expect(resolveJobSourceIdentity("   ", 80)).toEqual({ error: "empty" });
    expect(resolveJobSourceIdentity("x".repeat(81), 80)).toEqual({
      error: "too-long",
    });
  });

  it("keeps a custom Chinese label as the stored text", () => {
    expect(resolveJobSourceIdentity("学校就业群", 80)).toEqual({
      label: "学校就业群",
      value: "学校就业群",
    });
  });

  it("does not invent missing defaults that the user already has", () => {
    const missing = missingDefaultJobSources([
      "indeed",
      "linkedin",
      "monster",
      "glassdoor",
      "careerpage",
      "google",
      "ziprecruiter",
      "jobstreet",
      "other",
      "shixiseng",
      "boss zhipin",
      "referral group",
      "xiaohongshu",
    ]);
    expect(missing).toEqual([]);
  });

  it("backfills only the China defaults a user is missing", () => {
    const missing = missingDefaultJobSources(["indeed", "linkedin"]);
    expect(missing.map((source) => source.value)).toEqual(
      expect.arrayContaining([
        "shixiseng",
        "boss zhipin",
        "referral group",
        "xiaohongshu",
        "careerpage",
      ]),
    );
    expect(missing.map((source) => source.value)).not.toContain("indeed");
  });
});

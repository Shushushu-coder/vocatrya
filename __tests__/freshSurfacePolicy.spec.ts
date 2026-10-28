import {
  isFreshFullHiddenNavRoute,
  isFreshNativeFullSurface,
  canMutateJobsSurface,
} from "@/lib/career/freshSurfacePolicy";

describe("job mutation surfaces match the runtime write paths", () => {
  it.each([
    ["legacy", "LEGACY_ONLY", "none", true],
    ["fresh", "AB_ENABLED", "full", true],
    ["fresh", "AB_ENABLED", "resume_v1", false],
    ["fresh", "AB_READY_DISABLED", "full", false],
    ["migrated", "AB_ENABLED", "resume_v1", true],
    ["migrated", "AB_READY_DISABLED", "full", false],
    ["unknown", "BLOCKED", "none", false],
  ] as const)("%s %s %s -> %s", (origin, mode, rolloutScope, expected) => {
    expect(canMutateJobsSurface({origin, mode, rolloutScope})).toBe(expected);
  });
});

describe("isFreshNativeFullSurface", () => {
  it("is true only for a trusted fresh origin on the full rollout", () => {
    expect(
      isFreshNativeFullSurface({
        origin: "fresh",
        mode: "AB_ENABLED",
        rolloutScope: "full",
      }),
    ).toBe(true);
  });

  it("keeps a migrated instance at full scope on compatibility surfaces", () => {
    expect(
      isFreshNativeFullSurface({
        origin: "migrated",
        mode: "AB_ENABLED",
        rolloutScope: "full",
      }),
    ).toBe(false);
  });

  it("keeps legacy users on the legacy surface", () => {
    for (const origin of ["legacy", "unknown"]) {
      expect(
        isFreshNativeFullSurface({
          origin,
          mode: "AB_ENABLED",
          rolloutScope: "full",
        }),
      ).toBe(false);
    }
  });

  it("does not fire for fresh origin below the full scope or below AB_ENABLED", () => {
    expect(
      isFreshNativeFullSurface({
        origin: "fresh",
        mode: "AB_ENABLED",
        rolloutScope: "resume_v1",
      }),
    ).toBe(false);
    expect(
      isFreshNativeFullSurface({
        origin: "fresh",
        mode: "AB_ENABLED",
        rolloutScope: "none",
      }),
    ).toBe(false);
    for (const mode of ["LEGACY_ONLY", "AB_READY_DISABLED", "BLOCKED"]) {
      expect(
        isFreshNativeFullSurface({
          origin: "fresh",
          mode,
          rolloutScope: "full",
        }),
      ).toBe(false);
    }
  });

  it("fails closed on missing fields", () => {
    expect(isFreshNativeFullSurface({})).toBe(false);
    expect(
      isFreshNativeFullSurface({ origin: "fresh", mode: "AB_ENABLED" }),
    ).toBe(false);
  });
});

describe("isFreshFullHiddenNavRoute", () => {
  it("hides the automations family, including nested routes", () => {
    expect(isFreshFullHiddenNavRoute("/dashboard/automations")).toBe(true);
    expect(isFreshFullHiddenNavRoute("/dashboard/automations/auto-1")).toBe(
      true,
    );
  });

  it("keeps supported nav routes", () => {
    for (const route of [
      "/dashboard",
      "/dashboard/myjobs",
      "/dashboard/myjobs/job-1",
      "/dashboard/tasks",
      "/dashboard/activities",
      "/dashboard/questions",
      "/dashboard/interview",
      "/dashboard/profile",
      "/dashboard/admin",
      "/dashboard/settings",
    ]) {
      expect(isFreshFullHiddenNavRoute(route)).toBe(false);
    }
  });
});

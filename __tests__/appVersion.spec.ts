import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import { resolveAppVersion, resolveBuildFacts } from "@/lib/appVersion";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveAppVersion", () => {
  it("prefers the runtime-injected desktop version", () => {
    vi.stubEnv("VOCATRYA_APP_VERSION", "1.2.0-rc.1");
    expect(resolveAppVersion()).toBe("1.2.0-rc.1");
  });

  it("passes a prerelease identifier through whole", () => {
    vi.stubEnv("VOCATRYA_APP_VERSION", " 1.2.0-beta.2 ");
    expect(resolveAppVersion()).toBe("1.2.0-beta.2");
  });

  it("falls back to package.json when the env is unset or blank", () => {
    vi.stubEnv("VOCATRYA_APP_VERSION", "");
    expect(resolveAppVersion()).toBe(packageJson.version);
    vi.stubEnv("VOCATRYA_APP_VERSION", "   ");
    expect(resolveAppVersion()).toBe(packageJson.version);
  });
});

describe("resolveBuildFacts", () => {
  it("returns the injected installer facts", () => {
    vi.stubEnv("VOCATRYA_BUILD_COMMIT", " abc123 ");
    vi.stubEnv("VOCATRYA_BUILT_AT", " 2026-11-13T08:00:00.000Z ");
    expect(resolveBuildFacts()).toEqual({
      commit: "abc123",
      builtAt: "2026-11-13T08:00:00.000Z",
    });
  });

  it("returns null when the envs are absent — dev/web never fabricates facts", () => {
    vi.stubEnv("VOCATRYA_BUILD_COMMIT", "");
    vi.stubEnv("VOCATRYA_BUILT_AT", "");
    expect(resolveBuildFacts()).toBeNull();
  });

  it("returns null when only one fact is present", () => {
    vi.stubEnv("VOCATRYA_BUILD_COMMIT", "abc123");
    vi.stubEnv("VOCATRYA_BUILT_AT", "");
    expect(resolveBuildFacts()).toBeNull();
    vi.stubEnv("VOCATRYA_BUILD_COMMIT", "");
    vi.stubEnv("VOCATRYA_BUILT_AT", "2026-11-13T08:00:00.000Z");
    expect(resolveBuildFacts()).toBeNull();
  });
});

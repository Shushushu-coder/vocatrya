import { afterEach, describe, expect, it, vi } from "vitest";
import packageJson from "../package.json";
import { resolveAppVersion } from "@/lib/appVersion";

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

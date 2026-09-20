import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mutableEnv = process.env as Record<string, string | undefined>;
const SAVED: Record<string, string | undefined> = {};

function saveKeys(...keys: string[]) {
  for (const key of keys) SAVED[key] = mutableEnv[key];
}

function restoreKeys(...keys: string[]) {
  for (const key of keys) {
    if (SAVED[key] === undefined) delete mutableEnv[key];
    else mutableEnv[key] = SAVED[key];
  }
}

async function loadUploadsDir() {
  const mod = (await import("@/lib/constants")) as {
    APP_CONSTANTS: { UPLOADS_DIR: string };
  };
  return mod.APP_CONSTANTS.UPLOADS_DIR;
}

beforeEach(() => {
  vi.resetModules();
  saveKeys("UPLOADS_DIR", "VOCATRYA_UPLOADS_DIR", "NODE_ENV");
});

afterEach(() => {
  restoreKeys("UPLOADS_DIR", "VOCATRYA_UPLOADS_DIR", "NODE_ENV");
  vi.unstubAllEnvs?.();
});

describe("desktop uploads override contract", () => {
  it("uses the explicit desktop child-env directory when provided", async () => {
    mutableEnv.UPLOADS_DIR = path.join("C:", "foundation", "files");
    delete mutableEnv.VOCATRYA_UPLOADS_DIR;
    mutableEnv.NODE_ENV = "production";
    expect(await loadUploadsDir()).toBe(path.join("C:", "foundation", "files"));
  });

  it("falls back to the legacy override variable when the primary is absent", async () => {
    delete mutableEnv.UPLOADS_DIR;
    mutableEnv.VOCATRYA_UPLOADS_DIR = path.join("C:", "legacy", "files");
    mutableEnv.NODE_ENV = "production";
    expect(await loadUploadsDir()).toBe(path.join("C:", "legacy", "files"));
  });

  it("preserves the Docker production default without desktop overrides", async () => {
    delete mutableEnv.UPLOADS_DIR;
    delete mutableEnv.VOCATRYA_UPLOADS_DIR;
    mutableEnv.NODE_ENV = "production";
    expect(await loadUploadsDir()).toBe("/data");
  });

  it("preserves the development default without desktop overrides", async () => {
    delete mutableEnv.UPLOADS_DIR;
    delete mutableEnv.VOCATRYA_UPLOADS_DIR;
    mutableEnv.NODE_ENV = "development";
    expect(await loadUploadsDir()).toBe("data");
  });

  it("keeps backend sources free of Electron imports", () => {
    const candidates = [path.resolve(__dirname, "../src/lib/constants.ts")];
    for (const file of candidates) {
      const content = fs.readFileSync(file, "utf8");
      expect(content).not.toContain('from "electron"');
      expect(content).not.toContain("safeStorage");
    }
  });
});

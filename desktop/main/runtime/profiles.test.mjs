import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import profiles from "./profiles.js";

const {
  RuntimeProfileError,
  RuntimeProfileManager,
  isRuntimeProfileRef,
} = profiles;

let root;
let manager;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-profiles-"));
  manager = new RuntimeProfileManager({ profilesRoot: root });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runtime profile manager", () => {
  it("creates opaque refs in the rp_<uuid> format", () => {
    const { runtimeProfileRef } = manager.createProfile();
    expect(isRuntimeProfileRef(runtimeProfileRef)).toBe(true);
    expect(runtimeProfileRef).toMatch(/^rp_[0-9a-f-]{36}$/);
  });

  it("resolves refs inside the managed root and creates directories", () => {
    const { runtimeProfileRef, profileDir } = manager.createProfile();
    expect(path.resolve(profileDir)).toBe(
      path.join(path.resolve(root), runtimeProfileRef),
    );
    expect(fs.statSync(profileDir).isDirectory()).toBe(true);
    expect(manager.profileExists(runtimeProfileRef)).toBe(true);
  });

  it("gives different refs different paths", () => {
    const a = manager.createProfile();
    const b = manager.createProfile();
    expect(a.runtimeProfileRef).not.toBe(b.runtimeProfileRef);
    expect(a.profileDir).not.toBe(b.profileDir);
  });

  it("rejects invalid refs, traversal, separators, and absolute paths", () => {
    for (const bad of [
      "..",
      "../outside",
      "rp_../escape",
      "rp_not-a-uuid",
      "C:\\Users\\x",
      "C:/Users/x",
      "\\\\server\\share",
      "/abs/path",
      "rp_1234",
      "",
      null,
      undefined,
      42,
      path.join(root, "rp_00000000-0000-0000-0000-000000000000"),
    ]) {
      expect(() => manager.resolveProfileDir(bad)).toThrow(RuntimeProfileError);
      expect(() => manager.resolveProfileDir(bad)).toThrow(/Invalid runtime profile ref/);
    }
  });

  it("rejects a non-absolute profiles root", () => {
    expect(() => new RuntimeProfileManager({ profilesRoot: "relative" })).toThrow(
      /absolute/,
    );
  });

  it("deletes only directories inside the managed root", () => {
    const { runtimeProfileRef, profileDir } = manager.createProfile();
    fs.writeFileSync(path.join(profileDir, "marker.txt"), "x");
    expect(manager.deleteProfile(runtimeProfileRef)).toBe(true);
    expect(fs.existsSync(profileDir)).toBe(false);
    // Second delete is a no-op.
    expect(manager.deleteProfile(runtimeProfileRef)).toBe(false);
    // A foreign absolute path can never be deleted through the manager.
    const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-foreign-"));
    expect(() => manager.deleteProfile(foreign)).toThrow(RuntimeProfileError);
    expect(fs.existsSync(foreign)).toBe(true);
    fs.rmSync(foreign, { recursive: true, force: true });
  });

  it("ensureProfile materializes the managed dir for a known ref", () => {
    const ref = manager.newProfileRef();
    const dir = manager.ensureProfile(ref);
    expect(manager.profileExists(ref)).toBe(true);
    expect(dir).toBe(manager.resolveProfileDir(ref));
  });
});

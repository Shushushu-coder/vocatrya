import { describe, expect, it } from "vitest";
import detector from "./detector.js";

const {
  detectRuntime,
  expandKnownLocation,
  parseVersionFromOutput,
} = detector;

// No test ever requires a real provider CLI — spawnSync/existsSync are faked.
function fakeSpawnSync(behaviour) {
  return (command, args, options) => behaviour(command, args, options);
}

const NEVER_FOUND = () => null;

describe("runtime detector", () => {
  it("reports NOT_INSTALLED when no candidate resolves", () => {
    const result = detectRuntime("CODEX_RUNTIME", {
      platform: "win32",
      env: {},
      spawnSyncImpl: fakeSpawnSync(() => ({ status: 1, stdout: "" })),
      existsSyncImpl: () => false,
    });
    expect(result.state).toBe("NOT_INSTALLED");
    expect(result.installed).toBe(false);
    expect(result.executablePath).toBeUndefined();
  });

  it("finds a binary via where.exe PATH lookup and probes its version", () => {
    const spawnSyncImpl = fakeSpawnSync((command, args) => {
      if (command === "where.exe" && args[0] === "codex.exe") {
        return { status: 0, stdout: "C:\\Tools\\codex.exe\r\n" };
      }
      if (command === "where.exe") return { status: 1, stdout: "" };
      if (command === "C:\\Tools\\codex.exe" && args[0] === "--version") {
        return { status: 0, stdout: "codex 0.42.1\n", stderr: "" };
      }
      return { status: 1, stdout: "", stderr: "" };
    });
    const result = detectRuntime("CODEX_RUNTIME", {
      platform: "win32",
      env: {},
      spawnSyncImpl,
      existsSyncImpl: () => false,
    });
    expect(result.state).toBe("READY");
    expect(result.installed).toBe(true);
    expect(result.executablePath).toBe("C:\\Tools\\codex.exe");
    expect(result.version).toBe("0.42.1");
  });

  it("finds a binary via a known install location before PATH", () => {
    const env = { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
    const existsSyncImpl = (p) =>
      p === "C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
    const spawnForVersion = fakeSpawnSync((command, args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "codex 1.0.0" }
        : { status: 1, stdout: "" },
    );
    const result = detectRuntime("CODEX_RUNTIME", {
      platform: "win32",
      env,
      spawnSyncImpl: spawnForVersion,
      existsSyncImpl,
    });
    expect(result.state).toBe("READY");
    expect(result.executablePath).toBe(
      "C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe",
    );
    expect(result.version).toBe("1.0.0");
  });

  it("marks a found-but-failing binary BROKEN", () => {
    const spawnSyncImpl = fakeSpawnSync((command, args) => {
      if (command === "where.exe") {
        return args[0] === "claude.exe"
          ? { status: 0, stdout: "C:\\Tools\\claude.exe" }
          : { status: 1, stdout: "" };
      }
      return { status: null, error: new Error("spawn failed"), stdout: "" };
    });
    const result = detectRuntime("CLAUDE_RUNTIME", {
      platform: "win32",
      env: {},
      spawnSyncImpl,
      existsSyncImpl: () => false,
    });
    expect(result.state).toBe("BROKEN");
    expect(result.installed).toBe(true);
  });

  it("rejects unknown backendKinds", () => {
    expect(() => detectRuntime("GEMINI_RUNTIME", {})).toThrow(/Unknown runtime/);
    expect(() => detectRuntime("runtime:exec", {})).toThrow(/Unknown runtime/);
  });

  it("expands {ENV} placeholders and skips unresolved ones", () => {
    const env = { LOCALAPPDATA: "C:\\L" };
    expect(expandKnownLocation("{LOCALAPPDATA}\\x\\y.exe", env)).toBe(
      "C:\\L\\x\\y.exe",
    );
    expect(expandKnownLocation("{MISSING}\\z.exe", env)).toBe("{MISSING}\\z.exe");
  });

  it("parses semver-ish versions from probe output", () => {
    expect(parseVersionFromOutput("codex 0.42.1")).toBe("0.42.1");
    expect(parseVersionFromOutput("v1.2")).toBe("1.2");
    expect(parseVersionFromOutput("no version here")).toBeNull();
  });
});

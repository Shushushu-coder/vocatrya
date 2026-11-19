import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import adapter from "./antigravity.js";

const {
  antigravityAdapter,
  parseAntigravityAuthStatus,
  buildAntigravityLoginInvocation,
  buildAntigravityLogoutInvocation,
  buildAntigravityPrintInvocation,
  resolveAntigravityExecutable,
} = adapter;

describe("antigravity adapter", () => {
  it("resolves only an existing agy.exe", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-bin-"));
    const exe = path.join(dir, "agy.exe");
    fs.writeFileSync(exe, "");
    expect(resolveAntigravityExecutable(exe)).toBe(exe);
    expect(resolveAntigravityExecutable(path.join(dir, "agy.cmd"))).toBe(exe);
    expect(resolveAntigravityExecutable(path.join(dir, "missing.exe"))).toBe(
      null,
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not treat a model table as a Google account session", () => {
    const table = "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\n";
    expect(parseAntigravityAuthStatus({ stdout: table, stderr: "" })).toEqual(
      expect.objectContaining({ authState: "UNKNOWN", authKind: null }),
    );
    expect(
      parseAntigravityAuthStatus({
        stdout: "",
        stderr: "You are currently not signed in.",
      }).authState,
    ).toBe("NOT_AUTHENTICATED");
  });

  it("launches interactive login and does not log out via a fake subcommand", () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-profile-"));
    const login = buildAntigravityLoginInvocation({
      executablePath: "C:\\agy\\agy.exe",
      profileDir,
      baseEnv: { PATH: "C:\\Windows", GEMINI_API_KEY: "secret" },
    });
    expect(login.executable).toBe("cmd.exe");
    expect(login.args).toContain("acp");
    expect(login.args).toContain("--login");
    expect(login.env.GEMINI_API_KEY).toBeUndefined();
    expect(login.env.USERPROFILE).toBe(path.join(profileDir, "home"));

    const logout = buildAntigravityLogoutInvocation({
      executablePath: "C:\\agy\\agy.exe",
      profileDir,
      baseEnv: { PATH: "C:\\Windows" },
    });
    expect(logout.args).toEqual(["--version"]);
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("keeps the print prompt off argv", () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-profile-"));
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "agy-work-"));
    const prompt = "VOCATRYA_ANTIGRAVITY_OK";
    const invocation = buildAntigravityPrintInvocation({
      executablePath: "C:\\agy\\agy.exe",
      profileDir,
      baseEnv: { PATH: "C:\\Windows", GOOGLE_API_KEY: "secret" },
      workingDirectory: work,
      model: "gemini-3.8-flash-low",
      prompt,
    });
    expect(invocation.args).not.toContain(prompt);
    expect(invocation.args).toContain("--sandbox");
    expect(invocation.args).toContain("--mode");
    expect(invocation.args).not.toContain("--dangerously-skip-permissions");
    expect(invocation.env.GOOGLE_API_KEY).toBeUndefined();
    expect(invocation.cwd).toBe(work);
    const chunks = [];
    invocation.onStdinReady({
      on() {},
      end(value) {
        chunks.push(String(value));
      },
    });
    expect(chunks.join("")).toBe(prompt);
    expect(antigravityAdapter.loginFailureCode({
      authState: "AUTHENTICATED",
      authKind: "API_KEY",
    })).toBe("UNSUPPORTED_AUTH_METHOD");
    fs.rmSync(profileDir, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });
});

import { describe, expect, it } from "vitest";
import authProbe from "./auth-probe.js";

const { classifyAuthProbeOutput, probeRuntimeAuthState } = authProbe;

describe("runtime auth probe", () => {
  it("classifies authenticated / unauthenticated / reauth / unknown output", () => {
    expect(
      classifyAuthProbeOutput({ exitCode: 0, stdout: "Logged in as user@x" }),
    ).toBe("AUTHENTICATED");
    expect(
      classifyAuthProbeOutput({ exitCode: 1, stderr: "Not logged in" }),
    ).toBe("NOT_AUTHENTICATED");
    expect(
      classifyAuthProbeOutput({ exitCode: 1, stderr: "token expired" }),
    ).toBe("REAUTH_REQUIRED");
    expect(
      classifyAuthProbeOutput({ exitCode: 0, stdout: "garbage" }),
    ).toBe("UNKNOWN");
    expect(
      classifyAuthProbeOutput({
        exitCode: 0,
        stdout: '{"authenticated": true}',
      }),
    ).toBe("AUTHENTICATED");
  });

  it("refuses to probe without a managed profile dir", async () => {
    const result = await probeRuntimeAuthState({
      backendKind: "CODEX_RUNTIME",
      executablePath: "C:\\Tools\\codex.exe",
      profileDir: null,
    });
    expect(result.authState).toBe("UNKNOWN");
    expect(result.reason).toBe("PROFILE_REQUIRED");
  });

  it("refuses to probe a runtime that is not installed", async () => {
    const result = await probeRuntimeAuthState({
      backendKind: "CODEX_RUNTIME",
      executablePath: null,
      profileDir: "C:\\profiles\\rp_11111111-2222-3333-4444-555555555555",
    });
    expect(result.reason).toBe("NOT_INSTALLED");
  });

  it("runs the registry-defined probe inside the managed profile env", async () => {
    const calls = [];
    const fakeRunner = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "Authenticated", stderr: "" };
    };
    const profileDir = "C:\\Managed\\rp_11111111-2222-3333-4444-555555555555";
    const result = await probeRuntimeAuthState({
      backendKind: "CODEX_RUNTIME",
      executablePath: "C:\\Tools\\codex.exe",
      profileDir,
      baseEnv: { PATH: "C:\\Windows", OPENAI_API_KEY: "sk-leak-leak-leak-leak" },
      runner: fakeRunner,
    });
    expect(result.authState).toBe("AUTHENTICATED");
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["login", "status"]);
    expect(calls[0].env.CODEX_HOME).toBe(profileDir);
    expect(calls[0].env.OPENAI_API_KEY).toBeUndefined();
  });

  it("prepends provider invocation args (Devin --config) to probe args", async () => {
    const calls = [];
    const fakeRunner = async (cmd) => {
      calls.push(cmd);
      return { exitCode: 0, stdout: "not logged in" };
    };
    const profileDir = "C:\\Managed\\rp_99999999-8888-7777-6666-555555555555";
    await probeRuntimeAuthState({
      backendKind: "DEVIN_RUNTIME",
      executablePath: "C:\\Tools\\devin.exe",
      profileDir,
      runner: fakeRunner,
    });
    expect(calls[0].args).toEqual([
      "--config",
      `${profileDir}\\config\\devin.toml`,
      "auth",
      "status",
    ]);
    expect(calls[0].env.APPDATA).toBe(`${profileDir}\\appdata`);
  });

  it("maps runner failures and timeouts to UNKNOWN", async () => {
    const profileDir = "C:\\Managed\\rp_11111111-2222-3333-4444-555555555555";
    const failed = await probeRuntimeAuthState({
      backendKind: "CURSOR_RUNTIME",
      executablePath: "C:\\Tools\\agent.exe",
      profileDir,
      runner: async () => ({ error: "ENOENT" }),
    });
    expect(failed.authState).toBe("UNKNOWN");
    expect(failed.reason).toBe("SPAWN_FAILED");

    const timedOut = await probeRuntimeAuthState({
      backendKind: "CURSOR_RUNTIME",
      executablePath: "C:\\Tools\\agent.exe",
      profileDir,
      runner: async () => ({ timedOut: true }),
    });
    expect(timedOut.authState).toBe("UNKNOWN");
    expect(timedOut.reason).toBe("TIMEOUT");
  });
});

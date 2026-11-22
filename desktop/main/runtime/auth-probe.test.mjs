import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import authProbe from "./auth-probe.js";

const { classifyAuthProbeOutput, probeRuntimeAuthState } = authProbe;

// Fake `grok agent --no-leader stdio` child for the ACP_STDIO delegation
// path — answers initialize with no cached session.
function fakeGrokAgent() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.stdin = {
    write(data) {
      const msg = JSON.parse(data.trim());
      setImmediate(() => {
        if (msg.method === "initialize") {
          child.stdout.emit(
            "data",
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { authMethods: [{ id: "grok.com" }] },
            }) + "\n",
          );
        }
      });
      return true;
    },
    end() {},
  };
  child.kill = () => {};
  return child;
}

// Fake `agy acp` child — answers initialize and authenticate(oauth-personal)
// with a successful result carrying the tier metadata.
function fakeAgyAcp() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4343;
  child.stdin = {
    write(data) {
      const msg = JSON.parse(data.trim());
      const result =
        msg.method === "initialize"
          ? { protocolVersion: 1, authMethods: [{ id: "oauth-personal" }] }
          : { _meta: { antigravity: { tier: { id: "free-tier" } } } };
      setImmediate(() => {
        child.stdout.emit(
          "data",
          `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`,
        );
      });
      return true;
    },
    end() {},
  };
  child.kill = () => {};
  return child;
}

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

  it("probes Devin inside the USERPROFILE-anchored profile roots", async () => {
    // Verified against devin 3000.10.31: credentials resolve via
    // USERPROFILE — the probe env must carry the redirected home roots and
    // no --config arg (the flag never moved credentials).
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
    expect(calls[0].args).toEqual(["auth", "status"]);
    const home = `${profileDir}\\home`;
    expect(calls[0].env.USERPROFILE).toBe(home);
    expect(calls[0].env.HOME).toBe(home);
    expect(calls[0].env.APPDATA).toBe(`${home}\\AppData\\Roaming`);
    expect(calls[0].env.LOCALAPPDATA).toBe(`${home}\\AppData\\Local`);
    expect(calls[0].env.DEVIN_API_KEY).toBeUndefined();
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

  it("delegates ACP_STDIO probes to the grok adapter, never the runner", async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-acp-"));
    const spawned = [];
    const terminated = [];
    try {
      const result = await probeRuntimeAuthState({
        backendKind: "GROK_RUNTIME",
        executablePath: "C:\\Tools\\grok.exe",
        profileDir,
        baseEnv: { PATH: "C:\\Windows" },
        runner: async () => {
          throw new Error("runner must not be used for ACP_STDIO probes");
        },
        spawnImpl: (cmd, args, opts) => {
          spawned.push({ cmd, args, env: opts.env });
          return fakeGrokAgent();
        },
        terminateImpl: async (child) => {
          terminated.push(child);
        },
      });
      expect(result.authState).toBe("NOT_AUTHENTICATED");
      expect(spawned).toHaveLength(1);
      expect(spawned[0].args).toEqual(["agent", "--no-leader", "stdio"]);
      expect(spawned[0].env.GROK_HOME).toBe(profileDir);
      expect(terminated).toHaveLength(1);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("keeps passive Antigravity status unknown without spawning OAuth", async () => {
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-"));
    const spawned = [];
    const terminated = [];
    try {
      const result = await probeRuntimeAuthState({
        backendKind: "ANTIGRAVITY_RUNTIME",
        executablePath: "C:\\Tools\\agy.exe",
        profileDir,
        baseEnv: { PATH: "C:\\Windows" },
        runner: async () => {
          throw new Error("runner must not be used for ACP_STDIO probes");
        },
        spawnImpl: (cmd, args, opts) => {
          spawned.push({ cmd, args, env: opts.env });
          return fakeAgyAcp();
        },
        terminateImpl: async (child) => {
          terminated.push(child);
        },
      });
      expect(result.authState).toBe("UNKNOWN");
      expect(spawned).toHaveLength(0);
      expect(terminated).toHaveLength(0);
    } finally {
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

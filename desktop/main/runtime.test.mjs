import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import runtime from "./runtime.js";
import artifacts from "./artifacts.js";

const {
  allocateLoopbackPort,
  buildBackendCommand,
  buildBackendEnvironment,
  isAllowedNavigation,
  isExternalHttpUrl,
  resolveNodeExecutable,
  startBackendWithRetry,
  terminateChildTree,
  toPrismaFileUrl,
} = runtime;
const { scanForbiddenArtifacts } = artifacts;

describe("desktop runtime helpers", () => {
  it("allocates an ephemeral loopback port", async () => {
    const port = await allocateLoopbackPort();
    expect(port).toBeGreaterThan(0);
    expect(port).not.toBe(3737);
  });

  it("constructs a loopback-only backend environment without inherited secrets", () => {
    const env = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: { AUTH_SECRET: "real", DATABASE_URL: "real", OLLAMA_BASE_URL: "http://127.0.0.1:11434", PATH: "safe-path" },
      secret: "temporary",
    });
    expect(env.HOSTNAME).toBe("127.0.0.1");
    expect(env.NEXTAUTH_URL).toBe("http://127.0.0.1:45678");
    expect(env.AUTH_SECRET).toBe("temporary");
    expect(env.DATABASE_URL).toContain("desktop-poc.db");
    expect(env.DATABASE_URL).toMatch(/^file:/);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
    expect(env.PATH).toBe("safe-path");
    expect(env.VOCATRYA_AB_RUNTIME_ENABLED).toBeUndefined();
    expect(env.VOCATRYA_AB_ROLLOUT_SCOPE).toBeUndefined();
  });

  it("passes the operator hosted-endpoint channel through to the backend env", () => {
    const env = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: { VOCATRYA_HOSTED_ENDPOINT: "http://127.0.0.1:8787" },
      secret: "temporary",
    });
    expect(env.VOCATRYA_HOSTED_ENDPOINT).toBe("http://127.0.0.1:8787");
    const absent = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: {},
      secret: "temporary",
    });
    expect(Object.prototype.hasOwnProperty.call(absent, "VOCATRYA_HOSTED_ENDPOINT")).toBe(false);
  });

  it("passes the interview practice URL through as a non-secret config knob", () => {
    const env = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: { VOCATRYA_INTERVIEW_PRACTICE_URL: "https://practice.example.com/app" },
      secret: "temporary",
    });
    expect(env.VOCATRYA_INTERVIEW_PRACTICE_URL).toBe("https://practice.example.com/app");
    const absent = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: {},
      secret: "temporary",
    });
    expect(Object.prototype.hasOwnProperty.call(absent, "VOCATRYA_INTERVIEW_PRACTICE_URL")).toBe(false);
  });

  it("passes explicit AB flags through and omits absent ones", () => {
    const absent = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: { PATH: "safe-path" },
      secret: "temporary",
    });
    expect(Object.prototype.hasOwnProperty.call(absent, "VOCATRYA_AB_RUNTIME_ENABLED")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(absent, "VOCATRYA_AB_ROLLOUT_SCOPE")).toBe(false);

    const explicit = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: {
        PATH: "safe-path",
        VOCATRYA_AB_RUNTIME_ENABLED: "false",
        VOCATRYA_AB_ROLLOUT_SCOPE: "none",
      },
      secret: "temporary",
    });
    expect(explicit.VOCATRYA_AB_RUNTIME_ENABLED).toBe("false");
    expect(explicit.VOCATRYA_AB_ROLLOUT_SCOPE).toBe("none");

    const blank = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: {
        VOCATRYA_AB_RUNTIME_ENABLED: "",
        VOCATRYA_AB_ROLLOUT_SCOPE: "",
      },
      secret: "temporary",
    });
    expect(blank.VOCATRYA_AB_RUNTIME_ENABLED).toBe("");
    expect(blank.VOCATRYA_AB_ROLLOUT_SCOPE).toBe("");

    const full = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: { VOCATRYA_AB_ROLLOUT_SCOPE: "full" },
      secret: "temporary",
    });
    expect(full.VOCATRYA_AB_ROLLOUT_SCOPE).toBe("full");
    expect(Object.prototype.hasOwnProperty.call(full, "VOCATRYA_AB_RUNTIME_ENABLED")).toBe(false);
  });

  it("injects packaged build facts and keeps them absent otherwise", () => {
    const packaged = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: {},
      secret: "temporary",
      appVersion: "1.2.0-rc",
      buildCommit: " 831df5a3 ",
      builtAt: "2026-11-13T08:00:00.000Z",
    });
    expect(packaged.VOCATRYA_BUILD_COMMIT).toBe("831df5a3");
    expect(packaged.VOCATRYA_BUILT_AT).toBe("2026-11-13T08:00:00.000Z");

    // Blank/absent values must not leak inherited or fabricated facts.
    const plain = buildBackendEnvironment({
      port: 45678,
      dataDir: "C:\\poc-data",
      baseEnv: { VOCATRYA_BUILD_COMMIT: "inherited", VOCATRYA_BUILT_AT: "inherited" },
      secret: "temporary",
      buildCommit: "  ",
    });
    expect(Object.prototype.hasOwnProperty.call(plain, "VOCATRYA_BUILD_COMMIT")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(plain, "VOCATRYA_BUILT_AT")).toBe(false);
  });

  it("builds a bundled-node command", () => {
    expect(buildBackendCommand({ nodeExecutable: "runtime\\node.exe", serverPath: "backend\\server.js" })).toEqual({
      executable: "runtime\\node.exe",
      args: ["backend\\server.js"],
    });
  });

  it("allows only the selected loopback origin", () => {
    const origin = "http://127.0.0.1:45678";
    expect(isAllowedNavigation(`${origin}/signin`, origin)).toBe(true);
    expect(isAllowedNavigation(`${origin}/dashboard`, origin)).toBe(true);
    expect(isAllowedNavigation("http://127.0.0.1:45679/", origin)).toBe(false);
    // `localhost` must never substitute for the bound loopback address —
    // a localhost redirect is exactly the defect this guards against.
    expect(isAllowedNavigation("http://localhost:45678/signin", origin)).toBe(false);
    expect(isAllowedNavigation("http://[::1]:45678/signin", origin)).toBe(false);
    expect(isAllowedNavigation("http://0.0.0.0:45678/signin", origin)).toBe(false);
    expect(isAllowedNavigation("https://127.0.0.1:45678/signin", origin)).toBe(false);
    expect(isAllowedNavigation("http://127.0.0.1/signin", origin)).toBe(false);
    expect(isAllowedNavigation("https://example.com/", origin)).toBe(false);
    expect(isAllowedNavigation("file:///tmp/test", origin)).toBe(false);
    expect(isExternalHttpUrl("https://example.com/path")).toBe(true);
    expect(isExternalHttpUrl("javascript:alert(1)")).toBe(false);
  });

  it("resolves an explicit runtime path before development PATH lookup", () => {
    const runtime = path.join(os.tmpdir(), "vocatrya-node.exe");
    fs.writeFileSync(runtime, "placeholder");
    expect(resolveNodeExecutable({ isPackaged: false, appPath: ".", env: { DESKTOP_NODE_RUNTIME: runtime }, platform: "win32" })).toBe(runtime);
    fs.rmSync(runtime, { force: true });
  });

  it("never falls back to an environment Node path when packaged", () => {
    expect(() => resolveNodeExecutable({
      isPackaged: true,
      appPath: os.tmpdir(),
      env: { DESKTOP_NODE_RUNTIME: process.execPath },
      platform: "win32",
    })).toThrow(/Bundled Node runtime is missing/);
  });

  it("uses the prepared desktop runtime in development when available", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-dev-"));
    const prepared = path.join(root, ".codex-tmp", "desktop-poc", "runtime", "win32-x64");
    fs.mkdirSync(prepared, { recursive: true });
    const runtimePath = path.join(prepared, "node.exe");
    fs.writeFileSync(runtimePath, "placeholder");
    expect(resolveNodeExecutable({ isPackaged: false, appPath: root, env: {}, platform: "win32" })).toBe(runtimePath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("scans forbidden output artifacts", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-bundle-"));
    fs.mkdirSync(path.join(root, "nested"));
    fs.writeFileSync(path.join(root, "nested", "leaked.env"), "secret");
    fs.writeFileSync(path.join(root, "nested", ".ENV.production"), "secret");
    fs.writeFileSync(path.join(root, "nested", "sample.db-wal"), "db");
    fs.writeFileSync(path.join(root, "nested", "query_engine.node.tmp123"), "tmp");
    expect(scanForbiddenArtifacts(root)).toHaveLength(3);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("retries a failed startup on a new port and succeeds", async () => {
    const ports = [45001, 45002];
    const spawned = [];
    const terminated = [];
    let allocateCalls = 0;
    const result = await startBackendWithRetry({
      attempts: 3,
      allocatePort: async () => {
        allocateCalls += 1;
        return ports[allocateCalls - 1];
      },
      spawnChild: async (port) => {
        const child = { port };
        spawned.push(port);
        return child;
      },
      waitReady: async (port) => {
        if (port === 45001) throw new Error("Backend readiness timed out after 25000ms: bind-equivalent failure");
      },
      terminate: async (child) => {
        terminated.push(child.port);
      },
    });
    expect(result.port).toBe(45002);
    expect(result.attemptedPorts).toEqual([45001, 45002]);
    expect(result.attemptedPorts[0]).not.toBe(result.attemptedPorts[1]);
    expect(spawned).toEqual([45001, 45002]);
    expect(terminated).toEqual([45001]);
    expect(allocateCalls).toBe(2);
  });

  it("rejects after exhausting finite retry attempts without a fourth spawn", async () => {
    let allocateCalls = 0;
    let spawnCalls = 0;
    let terminateCalls = 0;
    await expect(startBackendWithRetry({
      attempts: 3,
      allocatePort: async () => {
        allocateCalls += 1;
        return 46000 + allocateCalls;
      },
      spawnChild: async () => {
        spawnCalls += 1;
        return { id: spawnCalls };
      },
      waitReady: async () => {
        throw new Error("Backend readiness timed out after 25000ms: bind-equivalent failure");
      },
      terminate: async () => {
        terminateCalls += 1;
      },
    })).rejects.toThrow(/readiness/);
    expect(allocateCalls).toBe(3);
    expect(spawnCalls).toBe(3);
    expect(terminateCalls).toBe(3);
  });
});

// The quit path must terminate ONLY the process trees this instance spawned —
// never a sibling worktree's backend, never a foreign node.exe. This spawns
// two real children and proves termination is scoped to the owned PID tree.
describe("owned-process termination isolation", () => {
  function spawnSleeper() {
    return spawn(process.execPath, ["-e", "setInterval(() => {}, 5000)"], {
      windowsHide: true,
      stdio: "ignore",
    });
  }

  function alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it("terminates the owned child tree and leaves foreign processes running", async () => {
    const owned = spawnSleeper();
    const foreign = spawnSleeper();
    try {
      await terminateChildTree(owned, 5_000);
      expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
      expect(alive(owned.pid)).toBe(false);
      // The sibling process the app does not own is untouched — no global
      // taskkill on node.exe, no PID sweep.
      expect(foreign.exitCode).toBeNull();
      expect(foreign.signalCode).toBeNull();
      expect(alive(foreign.pid)).toBe(true);
    } finally {
      await terminateChildTree(foreign, 5_000);
    }
    expect(alive(foreign.pid)).toBe(false);
  }, 30_000);

  it("is a no-op on missing or already-exited children", async () => {
    await expect(terminateChildTree(null)).resolves.toBeUndefined();
    const exited = spawnSleeper();
    exited.kill();
    await new Promise((resolve) => exited.once("exit", resolve));
    await expect(terminateChildTree(exited, 1_000)).resolves.toMatchObject({ exited: true, ok: true, detail: "already-exited" });
  }, 30_000);

  it("reports confirmed cleanup instead of silently assuming it", async () => {
    const owned = spawnSleeper();
    const result = await terminateChildTree(owned, 5_000);
    expect(result.exited).toBe(true);
    expect(result.ok).toBe(true);
    // A dead root cannot anchor taskkill /t — the detail records which
    // branch produced the clean result.
    expect(result.detail).toBe(process.platform === "win32" ? "exit:0" : "child-exited");
    expect(alive(owned.pid)).toBe(false);
  }, 30_000);

  it.skipIf(process.platform !== "win32")("terminates descendants before losing their owned root", async () => {
    const parentCode = `const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},5000)'],{windowsHide:true,stdio:'ignore'});
      child.once('spawn',()=>process.send(child.pid)); setInterval(()=>{},5000);`;
    const owned = spawn(process.execPath, ["-e", parentCode], {
      windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    const foreign = spawnSleeper();
    let descendant;
    try {
      [descendant] = await once(owned, "message");
      expect(alive(descendant)).toBe(true);
      const result = await terminateChildTree(owned, 5_000);
      expect(result).toMatchObject({ exited: true, ok: true, detail: "exit:0" });
      expect(alive(owned.pid)).toBe(false);
      expect(alive(descendant)).toBe(false);
      expect(alive(foreign.pid)).toBe(true);
    } finally {
      await terminateChildTree(owned);
      await terminateChildTree(foreign);
      // This test created the descendant; clean it even if a regression orphaned it.
      if (descendant && alive(descendant)) process.kill(descendant);
    }
  }, 30_000);
});

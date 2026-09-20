import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
    expect(isAllowedNavigation("http://127.0.0.1:45679/", origin)).toBe(false);
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

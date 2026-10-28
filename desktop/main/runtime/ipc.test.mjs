import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ipc from "./ipc.js";
import serviceModule from "./service.js";

const { RUNTIME_IPC_CHANNELS, registerRuntimeIpcHandlers } = ipc;
const { createRuntimeStatusService } = serviceModule;

// Minimal ipcMain stand-in that records registered handlers.
function fakeIpcMain() {
  const handlers = new Map();
  return {
    handlers,
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
    invoke(channel, payload) {
      const fn = handlers.get(channel);
      if (!fn) throw new Error(`No handler for ${channel}`);
      return fn({}, payload);
    },
  };
}

let root;
let service;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-ipc-"));
  service = createRuntimeStatusService({
    profilesRoot: root,
    deps: {
      platform: "win32",
      env: {},
      // Everything looks NOT_INSTALLED — no real CLI on the test box.
      spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
      existsSyncImpl: () => false,
    },
  });
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runtime IPC boundary", () => {
  it("exposes only registry-keyed channels — no arbitrary exec", () => {
    const ipcMain = fakeIpcMain();
    registerRuntimeIpcHandlers(ipcMain, service);
    const channels = [...ipcMain.handlers.keys()];
    expect(channels).toEqual([
      "runtime:list",
      "runtime:detect",
      "runtime:getVersion",
      "runtime:getStatus",
      "runtime:getInstallInfo",
      "runtime:getUpdateInfo",
      "runtime:checkUpdate",
    ]);
    // The dangerous shapes must not exist at all.
    for (const forbidden of [
      "runtime:exec",
      "runtime:run",
      "runtime:spawn",
      "runtime:shell",
      "runtime:command",
    ]) {
      expect(channels).not.toContain(forbidden);
    }
  });

  it("lists the seven runtimes", async () => {
    const ipcMain = fakeIpcMain();
    registerRuntimeIpcHandlers(ipcMain, service);
    const list = await ipcMain.invoke("runtime:list");
    expect(list).toHaveLength(7);
    expect(list.map((r) => r.backendKind)).toContain("DEVIN_RUNTIME");
  });

  it("enforces the backendKind allowlist on every keyed channel", async () => {
    const ipcMain = fakeIpcMain();
    registerRuntimeIpcHandlers(ipcMain, service);
    for (const channel of [
      "runtime:detect",
      "runtime:getVersion",
      "runtime:getStatus",
      "runtime:getInstallInfo",
      "runtime:getUpdateInfo",
      "runtime:checkUpdate",
    ]) {
      for (const bad of [
        undefined,
        {},
        { backendKind: "GEMINI_RUNTIME" },
        { backendKind: "runtime:exec" },
        { backendKind: "C:\\evil.exe" },
        "CODEX_RUNTIME",
      ]) {
        expect(() => ipcMain.invoke(channel, bad)).toThrow(/backendKind/i);
      }
    }
  });

  it("detects a runtime by backendKind without renderer-supplied paths", async () => {
    const ipcMain = fakeIpcMain();
    registerRuntimeIpcHandlers(ipcMain, service);
    const result = await ipcMain.invoke("runtime:detect", {
      backendKind: "CODEX_RUNTIME",
      // A hostile payload field is ignored — the handler reads only
      // backendKind and runtimeProfileRef.
      executable: "C:\\evil.exe",
      args: ["--evil"],
    });
    expect(result.state).toBe("NOT_INSTALLED");
    expect(result.runtimeVendor).toBe("OPENAI");
  });

  it("serves the consolidated capability descriptor via runtime:list", async () => {
    const ipcMain = fakeIpcMain();
    registerRuntimeIpcHandlers(ipcMain, service);
    const list = await ipcMain.invoke("runtime:list");
    const codex = list.find((r) => r.backendKind === "CODEX_RUNTIME");
    expect(codex.capabilities.implemented).toBe(true);
    expect(codex.capabilities.permission.level).toBe("STRONG_SANDBOX");
    expect(codex.capabilities.profile.credentialBoundary).toContain(
      "CODEX_HOME",
    );
    const devin = list.find((r) => r.backendKind === "DEVIN_RUNTIME");
    expect(devin.capabilities.login.interaction).toBe("VISIBLE_CONSOLE");
    expect(devin.capabilities.profile.browserLoginEnvPassthrough).toEqual([
      "APPDATA",
      "LOCALAPPDATA",
    ]);
  });

  it("returns structured install/update metadata with execution disabled", async () => {
    const ipcMain = fakeIpcMain();
    registerRuntimeIpcHandlers(ipcMain, service);
    const install = await ipcMain.invoke("runtime:getInstallInfo", {
      backendKind: "DEVIN_RUNTIME",
    });
    expect(install.executionEnabled).toBe(false);
    expect(install.methods[0].executable).toBe("powershell.exe");
    const update = await ipcMain.invoke("runtime:getUpdateInfo", {
      backendKind: "CLAUDE_RUNTIME",
    });
    expect(update.methods[0].args).toEqual(["update"]);
  });

  it("checkUpdate runs the read-only online check — no install executes", async () => {
    const ipcMain = fakeIpcMain();
    registerRuntimeIpcHandlers(ipcMain, service);
    // Everything is NOT_INSTALLED in this test env → the check reports
    // NOT_RUN without touching the network.
    const result = await ipcMain.invoke("runtime:checkUpdate", {
      backendKind: "CODEX_RUNTIME",
      force: true,
      executable: "C:\\evil.exe", // hostile fields stay ignored
    });
    expect(result.backendKind).toBe("CODEX_RUNTIME");
    expect(result.check.status).toBe("NOT_RUN");
    expect(result.executionEnabled).toBe(false);
  });

  it("getStatus stays UNKNOWN without a managed profile and validates refs", async () => {
    const ipcMain = fakeIpcMain();
    registerRuntimeIpcHandlers(ipcMain, service);
    // Not installed → no auth probe attempted.
    const status = await ipcMain.invoke("runtime:getStatus", {
      backendKind: "CODEX_RUNTIME",
      runtimeProfileRef: "rp_11111111-2222-3333-4444-555555555555",
    });
    expect(status.state).toBe("NOT_INSTALLED");
    expect(status.authState).toBeNull();
    // A traversal-shaped ref is rejected by the profile manager boundary.
    await expect(
      ipcMain.invoke("runtime:getStatus", {
        backendKind: "CODEX_RUNTIME",
        runtimeProfileRef: "../../etc",
      }),
    ).rejects.toThrow();
  });
});

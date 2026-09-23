import { describe, expect, it, vi } from "vitest";
import ipcModule from "./connection-ipc.js";

const { AI_CONNECTION_IPC_CHANNELS, registerConnectionIpcHandlers } = ipcModule;

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

function fakeService() {
  return {
    startLogin: vi.fn(async (input) => ({ ok: true, input })),
    cancelOperation: vi.fn(async (input) => ({ ok: true, cancelled: true, input })),
    reconnect: vi.fn(async (input) => ({ ok: true, input })),
    disconnect: vi.fn(async (input) => ({ ok: true, input })),
    verify: vi.fn(async (input) => ({ ok: true, input })),
    listModels: vi.fn(async (input) => ({ ok: true, input })),
    runSmoke: vi.fn(async (input) => ({ ok: true, input })),
  };
}

describe("aiConnection IPC boundary", () => {
  it("exposes only the typed lifecycle channels", () => {
    const ipcMain = fakeIpcMain();
    registerConnectionIpcHandlers(ipcMain, fakeService());
    expect([...ipcMain.handlers.keys()]).toEqual([
      "aiConnection:startLogin",
      "aiConnection:cancelOperation",
      "aiConnection:reconnect",
      "aiConnection:disconnect",
      "aiConnection:verify",
      "aiConnection:listModels",
      "aiConnection:runSmoke",
    ]);
  });

  it("forwards only identifiers — injected executable/args/env are dropped", async () => {
    const ipcMain = fakeIpcMain();
    const service = fakeService();
    registerConnectionIpcHandlers(ipcMain, service);

    await ipcMain.invoke("aiConnection:startLogin", {
      backendKind: "CODEX_RUNTIME",
      ticket: "t1",
      executable: "C:\\evil\\cmd.exe",
      args: ["/c", "calc"],
      env: { CODEX_HOME: "C:\\evil" },
      cwd: "C:\\",
      command: "codex login --device-auth",
      // A renderer-supplied provider must never reach the service — the
      // account provider is pinned by the minted ticket, not the payload.
      accountProvider: "GITHUB_COPILOT",
    });
    expect(service.startLogin).toHaveBeenCalledWith({
      backendKind: "CODEX_RUNTIME",
      ticket: "t1",
    });

    await ipcMain.invoke("aiConnection:runSmoke", {
      connectionId: "c1",
      ticket: "t2",
      model: "gpt-5.5",
      executable: "rm.exe",
      args: ["-rf", "/"],
      env: { OPENAI_API_KEY: "sk-injected" },
    });
    expect(service.runSmoke).toHaveBeenCalledWith({
      connectionId: "c1",
      ticket: "t2",
      model: "gpt-5.5",
    });
  });

  it("non-string fields degrade to structured errors, not exceptions", async () => {
    const ipcMain = fakeIpcMain();
    const service = fakeService();
    registerConnectionIpcHandlers(ipcMain, service);
    await ipcMain.invoke("aiConnection:startLogin", {
      backendKind: 42,
      ticket: { nested: true },
    });
    expect(service.startLogin).toHaveBeenCalledWith({
      backendKind: "",
      ticket: null,
    });
  });
});

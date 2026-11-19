// Per-purpose Codex binary selection: with a verified npm 0.170.0 next to the
// capability-verified standalone 0.165.0, the native session and the
// streaming/exec path must each SPAWN their own selected executable.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serviceModule from "./connection-service.js";

const { createConnectionService } = serviceModule;

const STANDALONE = "C:\\Users\\u\\AppData\\Local\\Programs\\OpenAI\\Codex\\bin\\codex.exe";
const NPM_VENDOR = "C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe";
const RP = "rp_11111111-1111-4111-8111-111111111111";
const VERSIONS = { [STANDALONE]: "0.165.0", [NPM_VENDOR]: "0.170.0" };

let roots;
let invocations;

beforeEach(() => {
  roots = ["profiles", "smoke", "exec"].map((n) => fs.mkdtempSync(path.join(os.tmpdir(), `vocatrya-bin-${n}-`)));
  fs.mkdirSync(path.join(roots[0], RP), { recursive: true });
  invocations = [];
});
afterEach(() => roots.forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function makeService() {
  const backend = {
    resolveTicket: vi.fn(async () => ({
      ok: true, operationId: "op_1", operation: "executeText", backendKind: "CODEX_RUNTIME",
      connection: { id: "conn-1", userId: "user-1", provider: "OPENAI", authType: "ACCOUNT_LOGIN", backendKind: "CODEX_RUNTIME", displayName: "ChatGPT", status: "CONNECTED", runtimeProfileRef: RP, createdAt: new Date().toISOString() },
    })),
    completeOperation: vi.fn(async () => ({ ok: true })),
  };
  return createConnectionService({
    profilesRoot: roots[0], smokeWorkRoot: roots[1], execWorkRoot: roots[2], backend, persistentCodexRuntime: false,
    deps: {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", APPDATA: "C:\\Users\\u\\AppData\\Roaming", PATH: "C:\\Windows" },
      existsSyncImpl: (p) => p === STANDALONE || p === NPM_VENDOR,
      spawnSyncImpl: (cmd) => (VERSIONS[cmd] ? { status: 0, stdout: `codex-cli ${VERSIONS[cmd]}`, stderr: "" } : { status: 1, stdout: "", stderr: "" }),
      persistentCodexRuntime: false,
      runner: vi.fn(async (inv) => { invocations.push({ executable: inv.executable, args: inv.args.slice() }); return { exitCode: 1, stdout: "", stderr: "" }; }),
    },
  });
}

describe("per-purpose Codex binary", () => {
  it("runtimeState reports streaming and native binaries separately", () => {
    const state = makeService().runtimeState({ backendKind: "CODEX_RUNTIME", accountProvider: "OPENAI" });
    expect(state).toMatchObject({ runtimeVersion: "0.165.0", runtimePath: STANDALONE });
    expect(state.nativeSession).toMatchObject({ ready: true, runtimeVersion: "0.170.0", runtimePath: NPM_VENDOR });
    expect(state.installs.map((i) => i.selectedFor)).toEqual([["default", "exec"], ["native"]]);
  });

  it("executeNativeSession spawns the verified npm 0.170.0 binary", async () => {
    await makeService().executeNativeSession({ ticket: "t", connectionId: "conn-1", model: "gpt-5.4", prompt: "hi", nativeSession: { conversationId: "c1" } });
    expect(invocations.map((i) => i.executable)).toEqual([NPM_VENDOR]);
    expect(invocations[0].args).toContain("app-server");
  });

  it("executeTextStream spawns the streaming-verified 0.165.0 binary and passes its version gate", async () => {
    const result = await makeService().executeTextStream({ ticket: "t", connectionId: "conn-1", model: "gpt-5.5", prompt: "hi" });
    expect(result).not.toEqual({ ok: false, code: "STREAMING_NOT_VERIFIED" });
    expect(invocations.map((i) => i.executable)).toEqual([STANDALONE]);
  });
});

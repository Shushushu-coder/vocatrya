import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serviceModule from "./connection-service.js";

const { createConnectionService } = serviceModule;

const FAKE_EXE = "C:\\fake\\codex.exe";
const RP_A = "rp_11111111-1111-4111-8111-111111111111";
const RP_B = "rp_22222222-2222-4222-8222-222222222222";

let profilesRoot;
let smokeWorkRoot;
let invocations;
let runnerScript;
let backend;
let service;

// Runner dispatch: each test installs handlers keyed on the command head.
// Default handler fails loudly so unexpected invocations surface.
function runnerImpl(inv) {
  invocations.push({
    args: inv.args.slice(),
    env: { ...inv.env },
    cwd: inv.cwd,
    executable: inv.executable,
    stdinPipe: inv.stdinPipe,
    onStdinReady: inv.onStdinReady,
  });
  const head = inv.args.join(" ");
  for (const { match, respond } of runnerScript) {
    if (match(head, inv)) return respond(inv);
  }
  throw new Error(`No fake runner response for: ${head}`);
}

// Drives an invocation's declared stdin transport with a stub stream and
// returns what the child would have received plus the EOF flag.
function driveStdin(inv) {
  const stdin = { on() {}, ended: false, chunks: [],
    write(c) { this.chunks.push(String(c)); },
    end(c) { if (c !== undefined) this.chunks.push(String(c)); this.ended = true; } };
  inv.onStdinReady(stdin);
  return { prompt: stdin.chunks.join(""), ended: stdin.ended };
}

function respond(result) {
  return () => Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...result });
}

function makeDeps() {
  return {
    platform: "win32",
    env: {
      PATH: "C:\\Windows",
      // Poison the ambient env — nothing credential-shaped may reach the
      // managed process environment.
      OPENAI_API_KEY: "sk-ambient",
      CODEX_API_KEY: "ambient",
      CODEX_ACCESS_TOKEN: "ambient",
      GITHUB_TOKEN: "ghp_ambient",
    },
    existsSyncImpl: (p) => p === FAKE_EXE,
    spawnSyncImpl: (cmd, args) => {
      if (cmd === "where.exe") return { status: 0, stdout: `${FAKE_EXE}\r\n` };
      return { status: 0, stdout: "codex-cli 0.154.0\n", stderr: "" };
    },
    runner: vi.fn(runnerImpl),
  };
}

function connectionRow(overrides = {}) {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "OPENAI",
    authType: "ACCOUNT_LOGIN",
    backendKind: "CODEX_RUNTIME",
    displayName: "ChatGPT",
    accountIdentity: "first@example.com",
    status: "CONNECTED",
    runtimeProfileRef: RP_A,
    lastVerifiedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-profiles-"));
  smokeWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-smoke-"));
  invocations = [];
  runnerScript = [];
  backend = {
    resolveTicket: vi.fn(async () => ({
      ok: true,
      operationId: "op_1",
      operation: "login",
      backendKind: "CODEX_RUNTIME",
    })),
    completeOperation: vi.fn(async (_opId, result) => ({
      ok: true,
      connection: connectionRow({
        runtimeProfileRef: result.runtimeProfileRef || RP_A,
        status:
          result.outcome === "disconnected"
            ? "DISCONNECTED"
            : result.outcome === "identity_conflict"
              ? "ERROR"
              : result.outcome === "auth_state"
                ? result.authState === "AUTHENTICATED"
                  ? "CONNECTED"
                  : result.authState === "UNKNOWN"
                    ? "ERROR"
                    : "REAUTH_REQUIRED"
                : "CONNECTED",
        lastVerifiedAt: new Date().toISOString(),
      }),
    })),
  };
  service = createConnectionService({
    profilesRoot,
    smokeWorkRoot,
    backend,
    deps: makeDeps(),
    loginTimeoutMs: 30_000,
  });
});

afterEach(() => {
  fs.rmSync(profilesRoot, { recursive: true, force: true });
  fs.rmSync(smokeWorkRoot, { recursive: true, force: true });
});

function assertManagedEnv(inv, expectedProfileDir) {
  expect(inv.env.CODEX_HOME).toBe(expectedProfileDir);
  expect(inv.env.CODEX_HOME.startsWith(profilesRoot)).toBe(true);
  // No credential override may leak into the managed process env.
  for (const key of [
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "GITHUB_TOKEN",
  ]) {
    expect(inv.env[key]).toBeUndefined();
  }
}

function loginScript(behavior) {
  runnerScript = [
    { match: (h) => h === "login", respond: behavior },
    {
      match: (h) => h === "login status",
      respond: respond({ stdout: "Logged in using ChatGPT\n" }),
    },
  ];
}

describe("startLogin", () => {
  it("creates a pending profile, runs login + status inside it, then persists", async () => {
    loginScript(respond({ stdout: "login server started\n" }));
    const result = await service.startLogin({
      backendKind: "CODEX_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("CONNECTED");

    const profileRef = backend.completeOperation.mock.calls[0][1].runtimeProfileRef;
    expect(profileRef).toMatch(/^rp_[0-9a-f-]{36}$/);
    const profileDir = path.join(profilesRoot, profileRef);
    expect(fs.statSync(profileDir).isDirectory()).toBe(true);

    const loginInv = invocations.find((i) => i.args[0] === "login" && i.args.length === 1);
    const statusInv = invocations.find((i) => i.args.join(" ") === "login status");
    assertManagedEnv(loginInv, profileDir);
    assertManagedEnv(statusInv, profileDir);
    expect(backend.completeOperation).toHaveBeenCalledWith("op_1", {
      outcome: "authenticated",
      verifiedProvider: "OPENAI",
      runtimeProfileRef: profileRef,
      accountIdentity: null,
    });
  });

  it("rejects unsupported backends without touching profiles", async () => {
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UNSUPPORTED_BACKEND");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("returns RUNTIME_NOT_INSTALLED and creates no profile", async () => {
    service = createConnectionService({
      profilesRoot,
      smokeWorkRoot,
      backend,
      deps: {
        ...makeDeps(),
        existsSyncImpl: () => false,
        spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
      },
    });
    const result = await service.startLogin({
      backendKind: "CODEX_RUNTIME",
      ticket: "t",
    });
    expect(result).toEqual({ ok: false, code: "RUNTIME_NOT_INSTALLED" });
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.resolveTicket).toHaveBeenCalled();
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("cleans the pending profile when the login process fails", async () => {
    loginScript(respond({ exitCode: 1, stderr: "boom" }));
    runnerScript[1] = {
      match: (h) => h === "login status",
      respond: respond({ exitCode: 1, stdout: "Not logged in\n" }),
    };
    const result = await service.startLogin({
      backendKind: "CODEX_RUNTIME",
      ticket: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("LOGIN_FAILED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("cleans the pending profile when auth is not confirmed", async () => {
    runnerScript = [
      { match: (h) => h === "login", respond: respond({}) },
      {
        match: (h) => h === "login status",
        respond: respond({ exitCode: 1, stdout: "Not logged in\n" }),
      },
    ];
    const result = await service.startLogin({
      backendKind: "CODEX_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_NOT_CONFIRMED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects an API-key session — never masquerades as account login", async () => {
    runnerScript = [
      { match: (h) => h === "login", respond: respond({}) },
      {
        match: (h) => h === "login status",
        respond: respond({ stdout: "Logged in using an API key - sk-x***y\n" }),
      },
    ];
    const result = await service.startLogin({
      backendKind: "CODEX_RUNTIME",
      ticket: "t",
    });
    // Unified taxonomy: a recognized credential override is
    // UNSUPPORTED_AUTH_METHOD (the user signed in the wrong way), not
    // AUTH_NOT_CONFIRMED (the probe could not decide).
    expect(result.code).toBe("UNSUPPORTED_AUTH_METHOD");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("cancellation terminates the process and deletes the pending profile", async () => {
    runnerScript = [
      {
        match: (h) => h === "login",
        respond: (inv) =>
          new Promise((resolve) => {
            inv.signal.addEventListener("abort", () =>
              resolve({ aborted: true, exitCode: null, stdout: "", stderr: "" }),
            );
          }),
      },
      {
        match: (h) => h === "login status",
        respond: respond({ exitCode: 1, stdout: "Not logged in\n" }),
      },
    ];
    const pending = service.startLogin({
      backendKind: "CODEX_RUNTIME",
      ticket: "t-cancel",
    });
    await new Promise((r) => setTimeout(r, 10));
    await service.cancelOperation({ ticket: "t-cancel" });
    const result = await pending;
    expect(result.code).toBe("LOGIN_CANCELLED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("times out and removes the pending profile", async () => {
    runnerScript = [
      {
        match: (h) => h === "login",
        respond: respond({ timedOut: true, exitCode: null }),
      },
      {
        match: (h) => h === "login status",
        respond: respond({ exitCode: 1, stdout: "Not logged in\n" }),
      },
    ];
    const result = await service.startLogin({
      backendKind: "CODEX_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("LOGIN_TIMEOUT");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("serializes concurrent logins", async () => {
    runnerScript = [
      {
        match: (h) => h === "login",
        respond: (inv) =>
          new Promise((resolve) => {
            inv.signal.addEventListener("abort", () =>
              resolve({ aborted: true, exitCode: null, stdout: "", stderr: "" }),
            );
          }),
      },
      {
        match: (h) => h === "login status",
        respond: respond({ stdout: "Logged in using ChatGPT\n" }),
      },
    ];
    const first = service.startLogin({ backendKind: "CODEX_RUNTIME", ticket: "a" });
    const second = service.startLogin({ backendKind: "CODEX_RUNTIME", ticket: "b" });
    await new Promise((r) => setTimeout(r, 10));
    await service.cancelOperation({ ticket: "a" });
    const [r1, r2] = await Promise.all([first, second]);
    const codes = [r1.code, r2.code].sort();
    expect(codes).toEqual(["LOGIN_ALREADY_IN_PROGRESS", "LOGIN_CANCELLED"]);
  });

  it("fails when the backend rejects the ticket", async () => {
    backend.resolveTicket.mockResolvedValueOnce({ ok: false, code: "INVALID_TICKET" });
    const result = await service.startLogin({
      backendKind: "CODEX_RUNTIME",
      ticket: "bad",
    });
    expect(result.code).toBe("INVALID_TICKET");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });
});

describe("reconnect", () => {
  const connTicket = (operation = "reconnect") => ({
    ok: true,
    operationId: "op_rec",
    operation,
    backendKind: "CODEX_RUNTIME",
    connection: connectionRow(),
  });

  beforeEach(() => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    backend.resolveTicket.mockImplementation(async () => connTicket());
  });

  it("re-authenticates in the same profile and keeps the connection id", async () => {
    loginScript(respond({}));
    const result = await service.reconnect({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.connection.id).toBe("conn-1");
    const loginInv = invocations.find((i) => i.args[0] === "login");
    assertManagedEnv(loginInv, path.join(profilesRoot, RP_A));
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "authenticated",
      accountIdentity: "first@example.com",
    });
  });

  it("reports ACCOUNT_IDENTITY_CONFLICT when a different account signs in", async () => {
    runnerScript = [
      { match: (h) => h === "login", respond: respond({}) },
      {
        match: (h) => h === "login status",
        respond: respond({
          stdout: "Logged in using ChatGPT (other@example.com)\n",
        }),
      },
    ];
    const result = await service.reconnect({ connectionId: "conn-1", ticket: "t" });
    expect(result.code).toBe("ACCOUNT_IDENTITY_CONFLICT");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "identity_conflict",
      accountIdentity: "other@example.com",
    });
  });

  it("does not conflict when the stored identity is unknown", async () => {
    backend.resolveTicket.mockImplementation(async () => ({
      ok: true,
      operationId: "op_rec",
      operation: "reconnect",
      backendKind: "CODEX_RUNTIME",
      connection: connectionRow({ accountIdentity: null }),
    }));
    runnerScript = [
      { match: (h) => h === "login", respond: respond({}) },
      {
        match: (h) => h === "login status",
        respond: respond({
          stdout: "Logged in using ChatGPT (other@example.com)\n",
        }),
      },
    ];
    const result = await service.reconnect({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "authenticated",
      accountIdentity: "other@example.com",
    });
  });

  it("reports the observed auth state when login does not confirm", async () => {
    runnerScript = [
      { match: (h) => h === "login", respond: respond({ exitCode: 0 }) },
      {
        match: (h) => h === "login status",
        respond: respond({ exitCode: 1, stdout: "Not logged in\n" }),
      },
    ];
    const result = await service.reconnect({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("REAUTH_REQUIRED");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "auth_state",
      authState: "NOT_AUTHENTICATED",
    });
  });
});

describe("disconnect", () => {
  it("runs codex logout only inside the target profile and keeps the row", async () => {
    // Two managed profiles exist: disconnecting A must never touch B or the
    // host-global ~/.codex.
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    fs.mkdirSync(path.join(profilesRoot, RP_B), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_dc",
      operation: "disconnect",
      backendKind: "CODEX_RUNTIME",
      connection: connectionRow({ id: "conn-a", runtimeProfileRef: RP_A }),
    });
    runnerScript = [{ match: (h) => h === "logout", respond: respond({}) }];

    const result = await service.disconnect({ connectionId: "conn-a", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("DISCONNECTED");

    const logoutInv = invocations.find((i) => i.args[0] === "logout");
    assertManagedEnv(logoutInv, path.join(profilesRoot, RP_A));
    expect(invocations).toHaveLength(1);
    // Profile dirs are retained — disconnect is not deletion.
    expect(fs.existsSync(path.join(profilesRoot, RP_A))).toBe(true);
    expect(fs.existsSync(path.join(profilesRoot, RP_B))).toBe(true);
    expect(backend.completeOperation).toHaveBeenCalledWith("op_dc", {
      outcome: "disconnected",
    });
  });
});

describe("verify", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_v",
      operation: "verify",
      backendKind: "CODEX_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("maps AUTHENTICATED to a verified connection", async () => {
    runnerScript = [
      {
        match: (h) => h === "login status",
        respond: respond({ stdout: "Logged in using ChatGPT\n" }),
      },
    ];
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.authState).toBe("AUTHENTICATED");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_v", {
      outcome: "auth_state",
      authState: "AUTHENTICATED",
    });
  });

  it("maps NOT_AUTHENTICATED through without touching runtime state", async () => {
    runnerScript = [
      {
        match: (h) => h === "login status",
        respond: respond({ exitCode: 1, stdout: "Not logged in\n" }),
      },
    ];
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("REAUTH_REQUIRED");
  });

  it("never reports an API-key session as authenticated for ACCOUNT_LOGIN", async () => {
    runnerScript = [
      {
        match: (h) => h === "login status",
        respond: respond({
          stdout: "Logged in using an API key - sk-abc***xyz\n",
        }),
      },
    ];
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    // Reported as UNKNOWN → the backend maps it to ERROR, never CONNECTED.
    expect(backend.completeOperation).toHaveBeenCalledWith("op_v", {
      outcome: "auth_state",
      authState: "UNKNOWN",
    });
    expect(result.connection.status).toBe("ERROR");
  });

  it("keeps runtime failure separate from connection state", async () => {
    service = createConnectionService({
      profilesRoot,
      smokeWorkRoot,
      backend,
      deps: {
        ...makeDeps(),
        existsSyncImpl: () => false,
        spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
      },
    });
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result).toEqual({ ok: false, code: "RUNTIME_NOT_INSTALLED" });
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });
});

describe("listModels", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_m",
      operation: "listModels",
      backendKind: "CODEX_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("returns the live catalog when debug models succeeds", async () => {
    runnerScript = [
      {
        match: (h) => h === "debug models",
        respond: respond({
          stdout: JSON.stringify({
            models: [
              { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
              { slug: "hidden", display_name: "Hidden", visibility: "hide" },
            ],
          }),
        }),
      },
    ];
    const result = await service.listModels({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.dynamicDiscoverySupported).toBe(true);
    expect(result.models).toEqual([
      {
        id: "gpt-6-astra",
        displayName: "GPT-6-Astra",
        source: "RUNTIME",
        availability: "available",
      },
    ]);
    const inv = invocations.find((i) => i.args[0] === "debug");
    assertManagedEnv(inv, path.join(profilesRoot, RP_A));
  });

  it("falls back to the bundled catalog when the refresh fails", async () => {
    runnerScript = [
      { match: (h) => h === "debug models", respond: respond({ exitCode: 1 }) },
      {
        match: (h) => h === "debug models --bundled",
        respond: respond({
          stdout: JSON.stringify({
            models: [{ slug: "gpt-5.5", display_name: "GPT-5.5", visibility: "list" }],
          }),
        }),
      },
    ];
    const result = await service.listModels({ connectionId: "conn-1", ticket: "t" });
    expect(result.dynamicDiscoverySupported).toBe(true);
    expect(result.models[0].id).toBe("gpt-5.5");
    expect(result.models[0].source).toBe("RUNTIME");
  });

  it("falls back to the curated catalog when the runtime cannot produce one", async () => {
    runnerScript = [
      { match: () => true, respond: respond({ exitCode: 1, stderr: "boom" }) },
    ];
    const result = await service.listModels({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.dynamicDiscoverySupported).toBe(false);
    expect(result.models.length).toBeGreaterThan(0);
    expect(result.models.every((m) => m.source === "CURATED")).toBe(true);
    expect(result.models.map((m) => m.id)).not.toContain("gpt-4o");
  });
});

describe("runSmoke", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_s",
      operation: "smoke",
      backendKind: "CODEX_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("runs codex exec in a Vocatrya temp dir and matches the marker", async () => {
    runnerScript = [
      {
        match: (h) => h.startsWith("exec "),
        respond: (inv) => {
          const outIdx = inv.args.indexOf("-o");
          fs.writeFileSync(inv.args[outIdx + 1], "VOCATRYA_CODEX_OK");
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        },
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
      model: "gpt-5.5",
    });
    expect(result).toMatchObject({
      ok: true,
      matched: true,
      text: "VOCATRYA_CODEX_OK",
      expected: "VOCATRYA_CODEX_OK",
    });
    const inv = invocations[0];
    assertManagedEnv(inv, path.join(profilesRoot, RP_A));
    expect(inv.cwd.startsWith(smokeWorkRoot)).toBe(true);
    expect(inv.args).toContain("-s");
    expect(inv.args[inv.args.indexOf("-s") + 1]).toBe("read-only");
    expect(inv.args).toContain("-m");
    expect(inv.args[inv.args.indexOf("-m") + 1]).toBe("gpt-5.5");
    // `codex exec -` — the prompt rides piped stdin to EOF, never argv.
    expect(inv.args[inv.args.length - 1]).toBe("-");
    expect(inv.args).not.toContain("Reply with exactly: VOCATRYA_CODEX_OK");
    const stdin = driveStdin(inv);
    expect(stdin.prompt).toBe("Reply with exactly: VOCATRYA_CODEX_OK");
    expect(stdin.ended).toBe(true);
    // The Vocatrya-owned work dir is cleaned afterwards.
    expect(fs.readdirSync(smokeWorkRoot)).toHaveLength(0);
  });

  it("maps a nonzero exit to INFERENCE_FAILED", async () => {
    runnerScript = [
      {
        match: (h) => h.startsWith("exec "),
        respond: respond({ exitCode: 1, stderr: "unauthorized" }),
      },
    ];
    const result = await service.runSmoke({ connectionId: "conn-1", ticket: "t" });
    expect(result).toEqual({ ok: false, code: "INFERENCE_FAILED" });
  });
});

describe("operation guard", () => {
  it("serializes operations on the same connection", async () => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_v",
      operation: "verify",
      backendKind: "CODEX_RUNTIME",
      connection: connectionRow(),
    });
    runnerScript = [
      {
        match: (h) => h === "login status",
        respond: (inv) =>
          new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({
                  exitCode: 0,
                  stdout: "Logged in using ChatGPT\n",
                  stderr: "",
                }),
              30,
            ),
          ),
      },
    ];
    const first = service.verify({ connectionId: "conn-1", ticket: "t1" });
    const second = service.verify({ connectionId: "conn-1", ticket: "t2" });
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1.ok).toBe(true);
    expect(r2.code).toBe("LOGIN_ALREADY_IN_PROGRESS");
  });
});

// Phase G Grok lifecycle tests — same coverage shape as the Codex/Claude/
// OpenCode suites, driven through the GROK_RUNTIME adapter bound to the XAI
// account provider. Proves: ticket-pinned provider binding, GROK_HOME +
// redirected-home isolation, ACP cached_token auth verification, OAuth-vs-
// wrong-method classification, disconnect isolation, dynamic model
// discovery, and the minimal-permission smoke invocation.
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serviceModule from "./connection-service.js";

const { createConnectionService } = serviceModule;

const FAKE_EXE = "C:\\fake\\grok.exe";
const RP_A = "rp_11111111-1111-4111-8111-111111111111";
const RP_B = "rp_22222222-2222-4222-8222-222222222222";
const PROFILE_A = () => path.join(profilesRoot, RP_A);
const PROFILE_B = () => path.join(profilesRoot, RP_B);

const OAUTH_URL =
  "https://auth.x.ai/oauth2/authorize?response_type=code&client_id=x";

const MODELS_AUTHED = [
  "You are logged in with grok.com.",
  "",
  "Default model: grok-4.7",
  "",
  "Available models:",
  "  * grok-4.7 (default)",
  "  - grok-4.7-build-fast",
  "  - grok-4.6",
  "",
].join("\n");

const MODELS_UNAUTHED = [
  "You are not authenticated.",
  "",
  "Default model: grok-4.6",
  "",
  "Available models:",
  "  * grok-4.6 (default)",
  "",
].join("\n");

let profilesRoot;
let smokeWorkRoot;
let invocations;
let acpCalls;
let runnerScript;
let acpScript;
let backend;
let service;
let serviceDeps;
let oauthEvents;

function runnerImpl(inv) {
  invocations.push({
    args: inv.args.slice(),
    env: { ...inv.env },
    cwd: inv.cwd,
    executable: inv.executable,
    onStdout: inv.onStdout,
    onStderr: inv.onStderr,
  });
  const head = inv.args.join(" ");
  for (const { match, respond } of runnerScript) {
    if (match(head, inv)) return respond(inv);
  }
  throw new Error(`No fake runner response for: ${head}`);
}

function respond(result) {
  return () =>
    Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...result });
}

// Fake `grok agent --no-leader stdio`: captures the managed env and answers
// the JSON-RPC exchange with the scripted ACP result.
function fakeAcpSpawn() {
  return (cmd, args, opts) => {
    acpCalls.push({
      cmd,
      args: args.slice(),
      env: { ...opts.env },
      cwd: opts.cwd,
      shell: opts.shell,
    });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kill = () => {};
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
                result: acpScript.initializeResult,
              }) + "\n",
            );
          } else if (msg.method === "authenticate") {
            const response = acpScript.authenticateError
              ? { jsonrpc: "2.0", id: msg.id, error: acpScript.authenticateError }
              : {
                  jsonrpc: "2.0",
                  id: msg.id,
                  result: acpScript.authenticateResult ?? {},
                };
            child.stdout.emit("data", JSON.stringify(response) + "\n");
          }
        });
        return true;
      },
      end() {},
    };
    return child;
  };
}

const AUTHED_ACP = {
  initializeResult: {
    authMethods: [
      { id: "grok.com", name: "Grok" },
      { id: "cached_token", name: "Existing login" },
    ],
  },
  authenticateResult: {
    _meta: {
      email: "user@example.com",
      auth_mode: "Oidc",
      subscription_tier: "SuperGrok",
    },
  },
};

const UNAUTHED_ACP = {
  initializeResult: { authMethods: [{ id: "grok.com", name: "Grok" }] },
};

function makeDeps() {
  return {
    platform: "win32",
    env: {
      PATH: "C:\\Windows",
      // Host home/appdata roots — every managed child must see the
      // profile-redirected copies, never these.
      USERPROFILE: "C:\\Users\\Real",
      HOME: "C:\\Users\\Real",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\Real",
      APPDATA: "C:\\Users\\Real\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Real\\AppData\\Local",
      // Poison the ambient env — nothing credential- or endpoint-shaped may
      // reach the managed process environment.
      XAI_API_KEY: "xai-ambient",
      GROK_API_KEY: "grok-ambient",
      GROK_DEPLOYMENT_KEY: "deploy-ambient",
      GROK_AUTH_PROVIDER_COMMAND: "corp-auth",
      GROK_OIDC_ISSUER: "https://okta.example.com",
      GROK_OIDC_CLIENT_ID: "cid",
      GROK_CONFIG: '{"models":{"default":"evil"}}',
      GROK_CONFIG_PATH: "C:\\evil.toml",
      GROK_MODELS_BASE_URL: "https://models.example.com",
      GROK_CLI_CHAT_PROXY_BASE_URL: "https://proxy.example.com",
      GROK_CLAUDE_MCPS_ENABLED: "true",
      GROK_CURSOR_HOOKS_ENABLED: "true",
      GROK_MEMORY: "1",
      GROK_SUBAGENTS: "1",
      OPENAI_API_KEY: "sk-ambient",
      ANTHROPIC_API_KEY: "sk-ant-ambient",
    },
    existsSyncImpl: (p) => p === FAKE_EXE,
    spawnSyncImpl: (cmd, args) => {
      if (cmd === "where.exe") return { status: 0, stdout: `${FAKE_EXE}\r\n` };
      return { status: 0, stdout: "grok 1.0.41\n", stderr: "" };
    },
    runner: vi.fn(runnerImpl),
    spawnImpl: vi.fn(fakeAcpSpawn()),
    terminateImpl: vi.fn(async () => {}),
    notifyOAuthUrl: vi.fn(),
  };
}

function connectionRow(overrides = {}) {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "XAI",
    authType: "ACCOUNT_LOGIN",
    backendKind: "GROK_RUNTIME",
    displayName: "Grok",
    accountIdentity: null,
    status: "CONNECTED",
    runtimeProfileRef: RP_A,
    lastVerifiedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function loginResolve(accountProvider = "XAI") {
  return {
    ok: true,
    operationId: "op_1",
    operation: "login",
    backendKind: "GROK_RUNTIME",
    accountProvider,
  };
}

beforeEach(() => {
  profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-grok-profiles-"));
  smokeWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-grok-smoke-"));
  invocations = [];
  acpCalls = [];
  runnerScript = [];
  acpScript = AUTHED_ACP;
  oauthEvents = [];
  backend = {
    resolveTicket: vi.fn(async () => loginResolve()),
    completeOperation: vi.fn(async (_opId, result) => ({
      ok: true,
      connection: connectionRow({
        runtimeProfileRef: result.runtimeProfileRef || RP_A,
        status:
          result.outcome === "disconnected"
            ? "DISCONNECTED"
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
  serviceDeps = {
    ...makeDeps(),
    notifyOAuthUrl: (e) => oauthEvents.push(e),
  };
  service = createConnectionService({
    profilesRoot,
    smokeWorkRoot,
    backend,
    deps: serviceDeps,
    loginTimeoutMs: 30_000,
  });
});

afterEach(() => {
  fs.rmSync(profilesRoot, { recursive: true, force: true });
  fs.rmSync(smokeWorkRoot, { recursive: true, force: true });
});

// Every managed child process — login, ACP probe, models, smoke — must run
// with GROK_HOME and redirected HOME/USERPROFILE inside the profile, and
// with every credential/endpoint/compat env var stripped.
function assertManagedEnv(env, expectedProfileDir) {
  expect(env.GROK_HOME).toBe(expectedProfileDir);
  expect(env.GROK_LEADER_SOCKET).toBe(
    path.join(expectedProfileDir, "grok-leader.sock"),
  );
  const home = path.join(expectedProfileDir, "home");
  expect(env.HOME).toBe(home);
  expect(env.USERPROFILE).toBe(home);
  expect(env.APPDATA).toBe(path.join(home, "AppData", "Roaming"));
  expect(env.LOCALAPPDATA).toBe(path.join(home, "AppData", "Local"));
  expect(env.HOMEDRIVE).toBeUndefined();
  expect(env.HOMEPATH).toBeUndefined();
  expect(env.PATH).toBe("C:\\Windows");
  const poisoned = Object.keys(makeDeps().env).filter(
    (k) =>
      ![
        "PATH",
        "USERPROFILE",
        "HOME",
        "APPDATA",
        "LOCALAPPDATA",
      ].includes(k),
  );
  for (const key of poisoned) {
    expect(env[key], `leaked ${key}`).toBeUndefined();
  }
}

// `grok login --oauth` prints the authorize URL on stderr and exits when the
// flow completes; the ACP probe then verifies the stored session.
function loginScript(loginResult = {}) {
  runnerScript = [
    {
      match: (h) => h === "login --oauth",
      respond: (inv) => {
        inv.onStderr?.(`Open this URL to sign in:\n  ${OAUTH_URL}\n`);
        return respond(loginResult)(inv);
      },
    },
  ];
}

describe("startLogin (Grok)", () => {
  it("pins OAuth, isolates GROK_HOME, verifies via ACP, persists XAI", async () => {
    loginScript();
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("CONNECTED");

    const profileRef =
      backend.completeOperation.mock.calls[0][1].runtimeProfileRef;
    expect(profileRef).toMatch(/^rp_[0-9a-f-]{36}$/);
    const profileDir = path.join(profilesRoot, profileRef);
    expect(fs.statSync(profileDir).isDirectory()).toBe(true);
    // The managed config.toml was written before login ran.
    expect(fs.readFileSync(path.join(profileDir, "config.toml"), "utf8")).toContain(
      "auto_update = false",
    );

    const loginInv = invocations.find((i) => i.args.join(" ") === "login --oauth");
    expect(loginInv).toBeTruthy();
    expect(loginInv.cwd).toBe(profileDir);
    assertManagedEnv(loginInv.env, profileDir);

    // The ACP probe ran inside the same profile env with --no-leader.
    expect(acpCalls).toHaveLength(1);
    expect(acpCalls[0].args).toEqual(["agent", "--no-leader", "stdio"]);
    expect(acpCalls[0].shell).toBe(false);
    assertManagedEnv(acpCalls[0].env, profileDir);

    // The authorize URL (stderr) was surfaced for the renderer.
    expect(oauthEvents).toEqual([
      {
        backendKind: "GROK_RUNTIME",
        accountProvider: "XAI",
        url: OAUTH_URL,
      },
    ]);

    // Backend persistence carries the verified provider + profile ref +
    // whitelisted account metadata — never a model id, never a token.
    expect(backend.completeOperation).toHaveBeenCalledWith("op_1", {
      outcome: "authenticated",
      verifiedProvider: "XAI",
      runtimeProfileRef: profileRef,
      accountIdentity: "user@example.com",
      providerMetadata: { authMode: "Oidc", subscriptionTier: "SuperGrok" },
    });
  });

  it("cancelled login leaves no zombie row and deletes the pending profile", async () => {
    loginScript({ aborted: true });
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("LOGIN_CANCELLED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("failed login leaves no zombie row", async () => {
    loginScript({ exitCode: 1, stderr: "flow aborted" });
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("LOGIN_FAILED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("an unverified session (no cached_token) fails with AUTH_NOT_CONFIRMED", async () => {
    loginScript();
    acpScript = UNAUTHED_ACP;
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_NOT_CONFIRMED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("rejects an API-key session — never ACCOUNT_LOGIN", async () => {
    loginScript();
    acpScript = {
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      authenticateResult: { _meta: { auth_mode: "ApiKey" } },
    };
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_AUTH_METHOD");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects an external auth-provider session", async () => {
    loginScript();
    acpScript = {
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      authenticateResult: { _meta: { auth_mode: "External" } },
    };
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_AUTH_METHOD");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("an unclassifiable session is AUTH_METHOD_UNVERIFIED, never accepted", async () => {
    loginScript();
    acpScript = {
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      authenticateResult: { _meta: { auth_mode: "MysteryMode" } },
    };
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_METHOD_UNVERIFIED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("a session missing auth_mode is AUTH_METHOD_UNVERIFIED, never accepted", async () => {
    loginScript();
    acpScript = {
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      authenticateResult: { _meta: { email: "user@example.com" } },
    };
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_METHOD_UNVERIFIED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects providers the adapter does not implement", async () => {
    backend.resolveTicket.mockResolvedValue(loginResolve("ANTHROPIC"));
    const result = await service.startLogin({
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
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
      backendKind: "GROK_RUNTIME",
      ticket: "t",
    });
    expect(result).toEqual({ ok: false, code: "RUNTIME_NOT_INSTALLED" });
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });
});

describe("reconnect (Grok)", () => {
  const connTicket = () => ({
    ok: true,
    operationId: "op_rec",
    operation: "reconnect",
    backendKind: "GROK_RUNTIME",
    connection: connectionRow(),
  });

  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockImplementation(async () => connTicket());
  });

  it("re-authenticates inside the same GROK_HOME and keeps the row", async () => {
    loginScript();
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.id).toBe("conn-1");
    const loginInv = invocations.find((i) => i.args.join(" ") === "login --oauth");
    assertManagedEnv(loginInv.env, PROFILE_A());
    expect(acpCalls[0].env.GROK_HOME).toBe(PROFILE_A());
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "authenticated",
      accountIdentity: "user@example.com",
      providerMetadata: { authMode: "Oidc", subscriptionTier: "SuperGrok" },
    });
  });
});

describe("disconnect (Grok)", () => {
  it("logs out only inside the target profile's GROK_HOME", async () => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    fs.mkdirSync(PROFILE_B(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_dc",
      operation: "disconnect",
      backendKind: "GROK_RUNTIME",
      connection: connectionRow(),
    });
    runnerScript = [
      { match: (h) => h === "logout", respond: respond({}) },
    ];
    const result = await service.disconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("DISCONNECTED");

    const logoutInv = invocations.find((i) => i.args.join(" ") === "logout");
    expect(logoutInv).toBeTruthy();
    assertManagedEnv(logoutInv.env, PROFILE_A());
    // Profile B's roots are never touched — every home var names A's dir.
    for (const key of [
      "GROK_HOME",
      "HOME",
      "USERPROFILE",
      "APPDATA",
      "LOCALAPPDATA",
    ]) {
      expect(logoutInv.env[key]).not.toContain(RP_B);
    }
  });
});

describe("verify (Grok)", () => {
  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_v",
      operation: "verify",
      backendKind: "GROK_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("reports CONNECTED for a verified xAI OAuth session", async () => {
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("CONNECTED");
    expect(acpCalls[0].env.GROK_HOME).toBe(PROFILE_A());
    // The ACP child was terminated after the handshake.
    expect(serviceDeps.terminateImpl).toHaveBeenCalled();
  });

  it("reports an API-key session as UNKNOWN → ERROR, never CONNECTED", async () => {
    acpScript = {
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      authenticateResult: { _meta: { auth_mode: "ApiKey" } },
    };
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.authState).toBe("UNKNOWN");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_v", {
      outcome: "auth_state",
      authState: "UNKNOWN",
    });
  });

  it("reports a missing session as NOT_AUTHENTICATED", async () => {
    acpScript = UNAUTHED_ACP;
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.authState).toBe("NOT_AUTHENTICATED");
  });
});

describe("listModels (Grok)", () => {
  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_m",
      operation: "listModels",
      backendKind: "GROK_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("discovers the runtime catalog inside the managed env", async () => {
    runnerScript = [
      { match: (h) => h === "models", respond: respond({ stdout: MODELS_AUTHED }) },
    ];
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.dynamicDiscoverySupported).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.6",
    ]);
    for (const m of result.models) {
      expect(m.source).toBe("RUNTIME");
    }
    const inv = invocations.find((i) => i.args.join(" ") === "models");
    assertManagedEnv(inv.env, PROFILE_A());
  });

  it("returns MODEL_DISCOVERY_UNAVAILABLE for the unauthenticated list", async () => {
    runnerScript = [
      {
        match: (h) => h === "models",
        respond: respond({ stdout: MODELS_UNAUTHED }),
      },
    ];
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MODEL_DISCOVERY_UNAVAILABLE");
  });

  it("returns MODEL_DISCOVERY_UNAVAILABLE on runtime failure", async () => {
    runnerScript = [
      { match: () => true, respond: respond({ exitCode: 1, stderr: "boom" }) },
    ];
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MODEL_DISCOVERY_UNAVAILABLE");
  });
});

describe("runSmoke (Grok)", () => {
  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_s",
      operation: "smoke",
      backendKind: "GROK_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("runs in a fresh temp cwd with every safety flag, then cleans up", async () => {
    runnerScript = [
      {
        match: (h) => h.startsWith("-p "),
        respond: respond({
          stdout: JSON.stringify({
            text: "VOCATRYA_GROK_OK",
            stopReason: "end_turn",
            sessionId: "s1",
            requestId: "r1",
          }),
        }),
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
      model: "grok-4.7",
    });
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(true);

    const smokeInv = invocations.find((i) => i.args[0] === "-p");
    expect(smokeInv.args).toEqual(
      expect.arrayContaining([
        "--output-format",
        "json",
        "--no-auto-update",
        "--no-memory",
        "--no-subagents",
        "--disable-web-search",
        "--sandbox",
        "strict",
        "--permission-mode",
        "dontAsk",
        "-m",
        "grok-4.7",
      ]),
    );
    expect(smokeInv.args.join(" ")).not.toMatch(/always-approve|yolo/);
    // Fresh Vocatrya-owned temp cwd — never the repo or a user folder.
    expect(smokeInv.cwd.startsWith(smokeWorkRoot)).toBe(true);
    expect(smokeInv.cwd).not.toBe(smokeWorkRoot);
    assertManagedEnv(smokeInv.env, PROFILE_A());
    // Temp cwd is cleaned up afterwards.
    expect(fs.existsSync(smokeInv.cwd)).toBe(false);
  });

  it("omits -m when no model is supplied — the runtime default applies", async () => {
    runnerScript = [
      {
        match: (h) => h.startsWith("-p "),
        respond: respond({
          stdout: JSON.stringify({ text: "VOCATRYA_GROK_OK" }),
        }),
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    const smokeInv = invocations.find((i) => i.args[0] === "-p");
    expect(smokeInv.args).not.toContain("-m");
  });
});

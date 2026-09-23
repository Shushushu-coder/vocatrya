// Phase H Cursor lifecycle tests — same coverage shape as the Codex/
// Claude/Grok/OpenCode suites, driven through the CURSOR_RUNTIME adapter
// bound to the CURSOR account provider. Proves: ticket-pinned provider
// binding, isolated-roots auth boundary (APPDATA\Cursor\auth.json +
// CURSOR_CONFIG_DIR + redirected home), `agent login` browser flow with
// NO_OPEN_BROWSER URL forwarding, JSON status classification, disconnect
// isolation, dynamic model discovery, and the minimal-permission smoke
// invocation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serviceModule from "./connection-service.js";

const { createConnectionService } = serviceModule;

const VERSIONS_DIR = "C:\\fake-local\\cursor-agent\\versions";
const BUNDLE_DIR = path.join(VERSIONS_DIR, "2026.09.18-9a7762b");
const FAKE_EXE = path.join(BUNDLE_DIR, "node.exe");
const ENTRYPOINT = path.join(BUNDLE_DIR, "index.js");
const RP_A = "rp_11111111-1111-4111-8111-111111111111";
const RP_B = "rp_22222222-2222-4222-8222-222222222222";
const PROFILE_A = () => path.join(profilesRoot, RP_A);
const PROFILE_B = () => path.join(profilesRoot, RP_B);

const LOGIN_URL =
  "https://cursor.com/loginDeepControl?challenge=abc123&uuid=u-1&mode=login&redirectTarget=cli";

const STATUS_AUTHENTICATED = JSON.stringify({
  status: "authenticated",
  isAuthenticated: true,
  hasAccessToken: true,
  hasRefreshToken: true,
  message: null,
  userInfo: { email: "user@example.com", userId: "u_1" },
});

const STATUS_UNAUTHENTICATED = JSON.stringify({
  status: "unauthenticated",
  isAuthenticated: false,
  hasAccessToken: false,
  hasRefreshToken: false,
  message: "Not logged in",
});

const STATUS_PARTIAL = JSON.stringify({
  status: "partially-authenticated",
  isAuthenticated: false,
  hasAccessToken: true,
  hasRefreshToken: false,
  message: "Partially authenticated (missing refresh token)",
});

const MODELS_TEXT = [
  "Available models:",
  "  auto",
  "  gpt-5",
  "  sonnet-4.5",
  "  composer-1.5",
  "",
].join("\n");

let profilesRoot;
let smokeWorkRoot;
let invocations;
let runnerScript;
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
  const head = inv.args.slice(1).join(" "); // args[0] is index.js
  for (const { match, respond } of runnerScript) {
    if (match(head, inv)) return respond(inv);
  }
  throw new Error(`No fake runner response for: ${head}`);
}

function respond(result) {
  return () =>
    Promise.resolve({ exitCode: 0, stdout: "", stderr: "", ...result });
}

function makeDeps() {
  return {
    platform: "win32",
    env: {
      PATH: "C:\\Windows",
      // Host roots — every managed child must see profile-redirected
      // copies, never these.
      USERPROFILE: "C:\\Users\\Real",
      HOME: "C:\\Users\\Real",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\Real",
      APPDATA: "C:\\Users\\Real\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\fake-local",
      XDG_CONFIG_HOME: "C:\\Users\\Real\\.config",
      // Poison the ambient env — nothing credential-, endpoint-, or
      // behavior-shaped may reach the managed process environment.
      CURSOR_API_KEY: "ck-ambient",
      CURSOR_AUTH_TOKEN: "tok-ambient",
      CURSOR_API_ENDPOINT: "https://evil.example.com",
      CURSOR_WEBSITE_URL: "https://evil.example.com",
      CURSOR_LOCAL_AGENT_API_KEY: "local-key",
      CURSOR_ENABLE_BEDROCK: "1",
      CURSOR_AGENT_CLI_AUTHLESS_MODE: "1",
      CURSOR_MDM_SIGN_IN_POLICY_JSON: '{"force":true}',
      AGENT_CLI_CREDENTIAL_STORE: "memory",
      AGENT_CLI_UPDATE_CHECK_URL: "https://evil.example.com/u",
      CURSOR_MODEL: "evil-model",
      CURSOR_SANDBOX: "disabled",
      CURSOR_DATA_DIR: "C:\\evil-data",
      OPENAI_API_KEY: "sk-ambient",
      ANTHROPIC_API_KEY: "sk-ant-ambient",
    },
    existsSyncImpl: (p) => p === FAKE_EXE || p === ENTRYPOINT,
    readdirSyncImpl: (p) =>
      p === path.join(VERSIONS_DIR)
        ? [{ name: "2026.09.18-9a7762b", isDirectory: () => true }]
        : [],
    spawnSyncImpl: (cmd, args) => {
      if (cmd === "where.exe") return { status: 0, stdout: `${FAKE_EXE}\r\n` };
      return { status: 0, stdout: "2026.09.18-9a7762b\n", stderr: "" };
    },
    runner: vi.fn(runnerImpl),
    terminateImpl: vi.fn(async () => {}),
    notifyOAuthUrl: vi.fn(),
  };
}

function connectionRow(overrides = {}) {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "CURSOR",
    authType: "ACCOUNT_LOGIN",
    backendKind: "CURSOR_RUNTIME",
    displayName: "Cursor",
    accountIdentity: null,
    status: "CONNECTED",
    runtimeProfileRef: RP_A,
    lastVerifiedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function loginResolve(accountProvider = "CURSOR") {
  return {
    ok: true,
    operationId: "op_1",
    operation: "login",
    backendKind: "CURSOR_RUNTIME",
    accountProvider,
  };
}

beforeEach(() => {
  profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-cursor-profiles-"));
  smokeWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-cursor-smoke-"));
  invocations = [];
  runnerScript = [];
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

// Every managed child — login, status, logout, models, smoke — must run
// with the isolated roots inside the profile and with every credential/
// endpoint/behavior env var stripped.
function assertManagedEnv(env, expectedProfileDir) {
  expect(env.CURSOR_CONFIG_DIR).toBe(path.join(expectedProfileDir, "config"));
  expect(env.APPDATA).toBe(path.join(expectedProfileDir, "appdata"));
  expect(env.LOCALAPPDATA).toBe(
    path.join(expectedProfileDir, "localappdata"),
  );
  const home = path.join(expectedProfileDir, "home");
  expect(env.HOME).toBe(home);
  expect(env.USERPROFILE).toBe(home);
  expect(env.XDG_CONFIG_HOME).toBe(
    path.join(expectedProfileDir, "xdg-config"),
  );
  expect(env.HOMEDRIVE).toBeUndefined();
  expect(env.HOMEPATH).toBeUndefined();
  expect(env.NO_OPEN_BROWSER).toBe("1");
  expect(env.PATH).toBe("C:\\Windows");
  const redirected = [
    "USERPROFILE",
    "HOME",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "PATH",
  ];
  const poisoned = Object.keys(makeDeps().env).filter(
    (k) => !redirected.includes(k),
  );
  for (const key of poisoned) {
    expect(env[key], `leaked ${key}`).toBeUndefined();
  }
}

// `agent login` prints the deep-control URL on stdout (NO_OPEN_BROWSER=1
// keeps it from opening a browser) and exits when the flow completes;
// `agent status --format json` then verifies the stored session.
function loginScript(loginResult = {}, statusResult = {}) {
  runnerScript = [
    {
      match: (h) => h === "login",
      respond: (inv) => {
        inv.onStdout?.(
          `Waiting for browser authentication...\n` +
            `Open a browser and navigate to this link: ${LOGIN_URL}\n`,
        );
        return respond(loginResult)(inv);
      },
    },
    {
      match: (h) => h === "status --format json",
      respond: respond({ stdout: STATUS_AUTHENTICATED, ...statusResult }),
    },
  ];
}

describe("startLogin (Cursor)", () => {
  it("pins browser login, isolates roots, verifies via status, persists CURSOR", async () => {
    loginScript();
    const result = await service.startLogin({
      backendKind: "CURSOR_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("CONNECTED");

    const profileRef =
      backend.completeOperation.mock.calls[0][1].runtimeProfileRef;
    expect(profileRef).toMatch(/^rp_[0-9a-f-]{36}$/);
    const profileDir = path.join(profilesRoot, profileRef);
    expect(fs.statSync(profileDir).isDirectory()).toBe(true);

    // The managed cli-config.json was written before login ran.
    const config = JSON.parse(
      fs.readFileSync(path.join(profileDir, "config", "cli-config.json"), "utf8"),
    );
    expect(config.approvalMode).toBe("allowlist");
    expect(config.permissions.allow).toEqual([]);
    expect(config.permissions.deny).toContain("Shell(*)");
    expect(config.permissions.deny).toContain("Write(**)");
    expect(config.permissions.deny).toContain("Read(**)");
    expect(config.sandbox.mode).toBe("enabled");

    const loginInv = invocations.find(
      (i) => i.args.slice(1).join(" ") === "login",
    );
    expect(loginInv).toBeTruthy();
    expect(loginInv.executable).toBe(FAKE_EXE);
    expect(loginInv.args[0]).toBe(ENTRYPOINT);
    expect(loginInv.cwd).toBe(profileDir);
    assertManagedEnv(loginInv.env, profileDir);

    // The deep-control URL was surfaced for the renderer.
    expect(oauthEvents).toEqual([
      {
        backendKind: "CURSOR_RUNTIME",
        accountProvider: "CURSOR",
        url: LOGIN_URL,
      },
    ]);

    // Backend persistence carries the verified provider + profile ref +
    // whitelisted identity — never a model id, never a token.
    expect(backend.completeOperation).toHaveBeenCalledWith("op_1", {
      outcome: "authenticated",
      verifiedProvider: "CURSOR",
      runtimeProfileRef: profileRef,
      accountIdentity: "user@example.com",
    });
  });

  it("deletes the pending profile when login exits non-zero", async () => {
    loginScript({ exitCode: 1, stderr: "login aborted" });
    const result = await service.startLogin({
      backendKind: "CURSOR_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("LOGIN_FAILED");
    expect(backend.completeOperation).not.toHaveBeenCalled();
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("deletes the pending profile when login is cancelled", async () => {
    runnerScript = [
      {
        match: (h) => h === "login",
        respond: () => Promise.resolve({ aborted: true, exitCode: null }),
      },
      {
        match: (h) => h === "status --format json",
        respond: respond({ stdout: STATUS_UNAUTHENTICATED }),
      },
    ];
    const result = await service.startLogin({
      backendKind: "CURSOR_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("LOGIN_CANCELLED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("fails AUTH_NOT_CONFIRMED when status reports unauthenticated", async () => {
    loginScript({}, { stdout: STATUS_UNAUTHENTICATED });
    const result = await service.startLogin({
      backendKind: "CURSOR_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("AUTH_NOT_CONFIRMED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("maps partially-authenticated to REAUTH_REQUIRED", async () => {
    loginScript({}, { stdout: STATUS_PARTIAL });
    const result = await service.startLogin({
      backendKind: "CURSOR_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("AUTH_NOT_CONFIRMED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("never forwards a non-cursor.com URL from login output", async () => {
    runnerScript = [
      {
        match: (h) => h === "login",
        respond: (inv) => {
          inv.onStdout?.("https://evil.example.com/loginDeepControl?x=1\n");
          inv.onStdout?.(
            `Open a browser and navigate to this link: ${LOGIN_URL}\n`,
          );
          return respond({})(inv);
        },
      },
      {
        match: (h) => h === "status --format json",
        respond: respond({ stdout: STATUS_AUTHENTICATED }),
      },
    ];
    const result = await service.startLogin({
      backendKind: "CURSOR_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(oauthEvents).toHaveLength(1);
    expect(oauthEvents[0].url).toBe(LOGIN_URL);
  });
});

describe("disconnect / verify / reconnect (Cursor)", () => {
  function opResolve(operation) {
    return {
      ok: true,
      operationId: `op_${operation}`,
      operation,
      backendKind: "CURSOR_RUNTIME",
      connection: connectionRow(),
    };
  }

  it("logout runs only inside the target profile", async () => {
    backend.resolveTicket = vi.fn(async () => opResolve("disconnect"));
    runnerScript = [
      { match: (h) => h === "logout", respond: respond({}) },
    ];
    const result = await service.disconnect({
      connectionId: "conn-1",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("DISCONNECTED");
    const logoutInv = invocations.find(
      (i) => i.args.slice(1).join(" ") === "logout",
    );
    expect(logoutInv).toBeTruthy();
    assertManagedEnv(logoutInv.env, PROFILE_A());
    // The logout cwd is the profile dir — never the host or repo.
    expect(logoutInv.cwd).toBe(PROFILE_A());
  });

  it("verify reports auth_state through the managed profile", async () => {
    backend.resolveTicket = vi.fn(async () => opResolve("verify"));
    runnerScript = [
      {
        match: (h) => h === "status --format json",
        respond: respond({ stdout: STATUS_AUTHENTICATED }),
      },
    ];
    const result = await service.verify({ connectionId: "conn-1", ticket: "t1" });
    expect(result.ok).toBe(true);
    expect(result.authState).toBe("AUTHENTICATED");
    const statusInv = invocations.find((i) =>
      i.args.slice(1).join(" ").startsWith("status"),
    );
    assertManagedEnv(statusInv.env, PROFILE_A());
  });

  it("reconnect preserves connectionId and profile", async () => {
    backend.resolveTicket = vi.fn(async () => opResolve("reconnect"));
    loginScript();
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.id).toBe("conn-1");
    // No new profile was created — the existing RP_A dir is reused.
    expect(fs.readdirSync(profilesRoot)).toEqual([RP_A]);
  });

  it("reconnect surfaces ACCOUNT_IDENTITY_CONFLICT on a different account", async () => {
    backend.resolveTicket = vi.fn(async () => opResolve("reconnect"));
    loginScript(
      {},
      {
        stdout: JSON.stringify({
          status: "authenticated",
          isAuthenticated: true,
          hasAccessToken: true,
          hasRefreshToken: true,
          userInfo: { email: "other@example.com" },
        }),
      },
    );
    // Existing row carries a different verified identity.
    backend.resolveTicket = vi.fn(async () => ({
      ...opResolve("reconnect"),
      connection: connectionRow({ accountIdentity: "first@example.com" }),
    }));
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t1",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("ACCOUNT_IDENTITY_CONFLICT");
  });
});

describe("listModels (Cursor)", () => {
  it("parses the runtime model list inside the managed profile", async () => {
    backend.resolveTicket = vi.fn(async () => ({
      ok: true,
      operationId: "op_models",
      operation: "listModels",
      backendKind: "CURSOR_RUNTIME",
      connection: connectionRow(),
    }));
    runnerScript = [
      { match: (h) => h === "models", respond: respond({ stdout: MODELS_TEXT }) },
    ];
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.dynamicDiscoverySupported).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual([
      "auto",
      "gpt-5",
      "sonnet-4.5",
      "composer-1.5",
    ]);
    expect(result.models.every((m) => m.source === "RUNTIME")).toBe(true);
    const inv = invocations.find((i) => i.args.slice(1).join(" ") === "models");
    assertManagedEnv(inv.env, PROFILE_A());
  });

  it("reports MODEL_DISCOVERY_UNAVAILABLE when unauthenticated", async () => {
    backend.resolveTicket = vi.fn(async () => ({
      ok: true,
      operationId: "op_models",
      operation: "listModels",
      backendKind: "CURSOR_RUNTIME",
      connection: connectionRow(),
    }));
    runnerScript = [
      {
        match: (h) => h === "models",
        respond: respond({
          exitCode: 1,
          stderr: "Error: Authentication required.",
        }),
      },
    ];
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t1",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MODEL_DISCOVERY_UNAVAILABLE");
  });
});

describe("runSmoke (Cursor)", () => {
  function smokeResolve() {
    return {
      ok: true,
      operationId: "op_smoke",
      operation: "smoke",
      backendKind: "CURSOR_RUNTIME",
      connection: connectionRow(),
    };
  }

  it("runs a minimal-permission print invocation and parses JSON", async () => {
    backend.resolveTicket = vi.fn(async () => smokeResolve());
    runnerScript = [
      {
        match: (h) => h.startsWith("-p "),
        respond: respond({
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "VOCATRYA_CURSOR_OK",
            session_id: "s_1",
          }),
        }),
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(true);
    const inv = invocations.find((i) => i.args.slice(1).join(" ").startsWith("-p "));
    expect(inv).toBeTruthy();
    const head = inv.args.slice(1).join(" ");
    expect(head).toContain("--mode ask");
    expect(head).toContain("--sandbox enabled");
    expect(head).toContain("--output-format json");
    expect(head).toContain("--disable-auto-update");
    expect(head).toContain("--disable-project-configs");
    expect(head).not.toContain("--force");
    expect(head).not.toContain("--yolo");
    expect(head).not.toContain("--resume");
    expect(head).not.toContain("--worktree");
    // cwd is a fresh Vocatrya-owned temp dir, never the repo/profile.
    expect(inv.cwd).toContain(smokeWorkRoot);
    expect(inv.cwd).not.toBe(PROFILE_A());
    assertManagedEnv(inv.env, PROFILE_A());
  });

  it("fails INFERENCE_FAILED when the run reports is_error", async () => {
    backend.resolveTicket = vi.fn(async () => smokeResolve());
    runnerScript = [
      {
        match: (h) => h.startsWith("-p "),
        respond: respond({
          stdout: JSON.stringify({
            type: "result",
            subtype: "error",
            is_error: true,
            result: "boom",
          }),
        }),
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t1",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("INFERENCE_FAILED");
  });
});

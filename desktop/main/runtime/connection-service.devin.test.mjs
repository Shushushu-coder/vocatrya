// Phase I Devin lifecycle tests — same coverage shape as the Codex/Claude/
// OpenCode/Grok suites, driven through the DEVIN_RUNTIME adapter bound to
// the DEVIN account provider. Proves: ticket-pinned provider binding,
// USERPROFILE-anchored profile isolation, the console-window login launch,
// `auth status` method classification, disconnect isolation, dynamic model
// discovery, org pinning, and the minimum-permission smoke invocation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serviceModule from "./connection-service.js";

const { createConnectionService } = serviceModule;

const FAKE_EXE = "C:\\fake\\devin\\bin\\devin.exe";
const RP_A = "rp_11111111-1111-4111-8111-111111111111";
const RP_B = "rp_22222222-2222-4222-8222-222222222222";
const PROFILE_A = () => path.join(profilesRoot, RP_A);
const PROFILE_B = () => path.join(profilesRoot, RP_B);

const STATUS_AUTHED = [
  "Logged in (via Devin).",
  "",
  "Credentials:",
  "  File:              C:\\managed\\devin\\credentials.toml",
  "",
  "User:",
  "  Name:              Test User",
  "  Email:             devin@example.com",
  "  User ID:           user-abc123",
  "",
  "Account:",
  "  Tier:              Devin Pro",
  "  Plan:              Pro",
  "  Team ID:           devin-team$account-xyz",
  "  Enterprise:        no",
  "",
].join("\n");

const STATUS_UNAUTHED =
  "Not logged in.\n  Credentials path: C:\\managed\\devin\\credentials.toml\n";

const STATUS_TOKEN = "Logged in (via token).\n";

const MODELS_JSON = JSON.stringify({
  families: [
    {
      slug: "swe-2",
      label: "SWE-2",
      variants: [
        { model_uid: "swe-2-high", label: "SWE-2 High" },
        { model_uid: "swe-2-max", label: "SWE-2 Max" },
      ],
    },
    {
      slug: "fusion",
      label: "Fusion",
      variants: [{ model_uid: "fusion-x", label: "Fusion X" }],
    },
  ],
});

const WHOAMI_JSON = JSON.stringify({
  org_id: "org-test123",
  devin_api_url: "https://api.devin.ai",
  api_key_set: true,
});

let profilesRoot;
let smokeWorkRoot;
let invocations;
let runnerScript;
let statusOutput;
let backend;
let service;

function runnerImpl(inv) {
  invocations.push({
    args: inv.args.slice(),
    env: { ...inv.env },
    cwd: inv.cwd,
    executable: inv.executable,
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

// Default command routing for the Devin CLI — auth status answers with the
// scripted output so each test can flip auth states; the org-info probe
// always reports a pinned org.
function installDefaultRouting() {
  runnerScript = [
    {
      match: (h, inv) =>
        inv.executable === "cmd.exe" && h.includes("auth login"),
      respond: respond({}),
    },
    {
      match: (h) => h === "auth status",
      respond: (inv) => respond(statusOutput)(inv),
    },
    {
      match: (h) => h === "cloud drs whoami",
      respond: respond({ stdout: WHOAMI_JSON }),
    },
    { match: (h) => h === "auth logout", respond: respond({}) },
    {
      match: (h) => h === "models list --format json",
      respond: respond({ stdout: MODELS_JSON }),
    },
  ];
}

function makeDeps() {
  return {
    platform: "win32",
    env: {
      PATH: "C:\\Windows",
      // Host profile roots — every managed child must see the
      // profile-redirected copies, never these.
      USERPROFILE: "C:\\Users\\Real",
      HOME: "C:\\Users\\Real",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Users\\Real",
      APPDATA: "C:\\Users\\Real\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\Real\\AppData\\Local",
      // Poison the ambient env — nothing credential- or endpoint-shaped may
      // reach the managed process environment.
      DEVIN_API_KEY: "devin-ambient-key",
      DEVIN_TOKEN: "devin-ambient-token",
      DEVIN_ACCESS_TOKEN: "devin-ambient-access",
      DEVIN_PAT: "devin-ambient-pat",
      WINDSURF_API_KEY: "ws-ambient",
      COGNITION_API_KEY: "cog-ambient",
      DEVIN_API_URL: "https://evil.example.com",
      DEVIN_WEBAPP_HOST: "evil.example.com",
      DEVIN_ACP_BACKEND: "evil",
      DEVIN_MODEL: "evil-model",
      DEVIN_PERMISSION_MODE: "dangerous",
      OPENAI_API_KEY: "sk-ambient",
      HTTPS_PROXY: "http://127.0.0.1:7897",
    },
    existsSyncImpl: (p) => p === FAKE_EXE,
    spawnSyncImpl: (cmd, args) => {
      if (cmd === "where.exe") return { status: 0, stdout: `${FAKE_EXE}\r\n` };
      return { status: 0, stdout: "devin 3000.10.31\n", stderr: "" };
    },
    runner: vi.fn(runnerImpl),
  };
}

function connectionRow(overrides = {}) {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "DEVIN",
    authType: "ACCOUNT_LOGIN",
    backendKind: "DEVIN_RUNTIME",
    displayName: "Devin",
    accountIdentity: null,
    status: "CONNECTED",
    runtimeProfileRef: RP_A,
    lastVerifiedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function loginResolve(accountProvider = "DEVIN") {
  return {
    ok: true,
    operationId: "op_1",
    operation: "login",
    backendKind: "DEVIN_RUNTIME",
    accountProvider,
  };
}

beforeEach(() => {
  profilesRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vocatrya-devin-profiles-"),
  );
  smokeWorkRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), "vocatrya-devin-smoke-"),
  );
  invocations = [];
  statusOutput = { stdout: STATUS_AUTHED };
  installDefaultRouting();
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

// Every managed child process — login launcher, status probe, models,
// smoke — must run with the USERPROFILE-anchored roots redirected into the
// profile and every credential/endpoint env var stripped. The login
// launcher is the single exception for APPDATA/LOCALAPPDATA: it restores
// the host roots so the spawned browser resolves the user's real profile
// (existing app.devin.ai session) instead of a fresh one.
function assertManagedEnv(env, expectedProfileDir, { browserRoots = false } = {}) {
  const home = path.join(expectedProfileDir, "home");
  expect(env.USERPROFILE).toBe(home);
  expect(env.HOME).toBe(home);
  if (browserRoots) {
    expect(env.APPDATA).toBe("C:\\Users\\Real\\AppData\\Roaming");
    expect(env.LOCALAPPDATA).toBe("C:\\Users\\Real\\AppData\\Local");
  } else {
    expect(env.APPDATA).toBe(path.join(home, "AppData", "Roaming"));
    expect(env.LOCALAPPDATA).toBe(path.join(home, "AppData", "Local"));
  }
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
        "HTTPS_PROXY",
      ].includes(k),
  );
  for (const key of poisoned) {
    expect(env[key], `leaked ${key}`).toBeUndefined();
  }
  // Ordinary proxy settings pass through.
  expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7897");
}

function loginInv() {
  return invocations.find((i) => i.executable === "cmd.exe");
}
function statusInv() {
  return invocations.find((i) => i.args.join(" ") === "auth status");
}

describe("startLogin (Devin)", () => {
  it("launches the console window, verifies via Devin, persists DEVIN", async () => {
    const result = await service.startLogin({
      backendKind: "DEVIN_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("CONNECTED");

    const profileRef =
      backend.completeOperation.mock.calls[0][1].runtimeProfileRef;
    expect(profileRef).toMatch(/^rp_[0-9a-f-]{36}$/);
    const profileDir = path.join(profilesRoot, profileRef);
    expect(fs.statSync(profileDir).isDirectory()).toBe(true);
    // The hardened managed config exists inside the profile.
    const config = JSON.parse(
      fs.readFileSync(
        path.join(profileDir, "home", "AppData", "Roaming", "devin", "config.json"),
        "utf8",
      ),
    );
    expect(config.auto_update).toBe(false);
    expect(config.read_config_from.claude).toBe(false);
    expect(config.permissions.deny).toContain("exec");
    // The org was pinned from `cloud drs whoami` for `devin -p`.
    expect(config.devin.org_id).toBe("org-test123");

    // Login ran through the console launcher, never as a piped TUI.
    const login = loginInv();
    expect(login).toBeTruthy();
    expect(login.args.slice(0, 5)).toEqual(["/d", "/c", "start", "", "/wait"]);
    expect(login.args[5]).toBe(FAKE_EXE);
    expect(login.args.slice(6)).toEqual(["auth", "login"]);
    expect(login.cwd).toBe(profileDir);
    assertManagedEnv(login.env, profileDir, { browserRoots: true });

    // Status probe + org pinning ran inside the same managed env.
    assertManagedEnv(statusInv().env, profileDir);
    const whoami = invocations.find(
      (i) => i.args.join(" ") === "cloud drs whoami",
    );
    assertManagedEnv(whoami.env, profileDir);

    // Backend persistence carries the verified provider + profile ref +
    // whitelisted account metadata — never a model id, never a token.
    expect(backend.completeOperation).toHaveBeenCalledWith("op_1", {
      outcome: "authenticated",
      verifiedProvider: "DEVIN",
      runtimeProfileRef: profileRef,
      accountIdentity: "devin@example.com",
      providerMetadata: expect.objectContaining({
        userId: "user-abc123",
        tier: "Devin Pro",
      }),
    });
  });

  it("cancelled login leaves no zombie row and deletes the pending profile", async () => {
    runnerScript[0] = {
      match: (h, inv) =>
        inv.executable === "cmd.exe" && h.includes("auth login"),
      respond: respond({ aborted: true }),
    };
    statusOutput = { stdout: STATUS_UNAUTHED, exitCode: 1 };
    const result = await service.startLogin({
      backendKind: "DEVIN_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("LOGIN_CANCELLED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("failed login (window closed) leaves no zombie row", async () => {
    runnerScript[0] = {
      match: (h, inv) =>
        inv.executable === "cmd.exe" && h.includes("auth login"),
      respond: respond({ exitCode: 1, stderr: "Login canceled" }),
    };
    statusOutput = { stdout: STATUS_UNAUTHED, exitCode: 1 };
    const result = await service.startLogin({
      backendKind: "DEVIN_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("LOGIN_FAILED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("an unverified session fails with AUTH_NOT_CONFIRMED", async () => {
    statusOutput = { stdout: STATUS_UNAUTHED, exitCode: 1 };
    const result = await service.startLogin({
      backendKind: "DEVIN_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_NOT_CONFIRMED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("rejects a token session — PAT is never ACCOUNT_LOGIN", async () => {
    statusOutput = { stdout: STATUS_TOKEN };
    const result = await service.startLogin({
      backendKind: "DEVIN_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_AUTH_METHOD");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("an unclassifiable method is AUTH_METHOD_UNVERIFIED", async () => {
    statusOutput = { stdout: "Logged in (via Windsurf).\n" };
    const result = await service.startLogin({
      backendKind: "DEVIN_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_METHOD_UNVERIFIED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects providers the adapter does not implement", async () => {
    backend.resolveTicket.mockResolvedValue(loginResolve("OPENAI"));
    const result = await service.startLogin({
      backendKind: "DEVIN_RUNTIME",
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
      backendKind: "DEVIN_RUNTIME",
      ticket: "t",
    });
    expect(result).toEqual({ ok: false, code: "RUNTIME_NOT_INSTALLED" });
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });
});

describe("reconnect (Devin)", () => {
  const connTicket = () => ({
    ok: true,
    operationId: "op_rec",
    operation: "reconnect",
    backendKind: "DEVIN_RUNTIME",
    connection: connectionRow(),
  });

  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockImplementation(async () => connTicket());
  });

  it("re-authenticates inside the same profile and keeps the row", async () => {
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.id).toBe("conn-1");
    assertManagedEnv(loginInv().env, PROFILE_A(), { browserRoots: true });
    assertManagedEnv(statusInv().env, PROFILE_A());
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "authenticated",
      accountIdentity: "devin@example.com",
      providerMetadata: expect.objectContaining({ userId: "user-abc123" }),
    });
  });

  it("identity change surfaces ACCOUNT_IDENTITY_CONFLICT", async () => {
    statusOutput = {
      stdout: STATUS_AUTHED.replace("devin@example.com", "other@example.com"),
    };
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_rec",
      operation: "reconnect",
      backendKind: "DEVIN_RUNTIME",
      connection: connectionRow({ accountIdentity: "devin@example.com" }),
    });
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.code).toBe("ACCOUNT_IDENTITY_CONFLICT");
  });
});

describe("disconnect (Devin)", () => {
  it("logs out only inside the target profile", async () => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    fs.mkdirSync(PROFILE_B(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_dc",
      operation: "disconnect",
      backendKind: "DEVIN_RUNTIME",
      connection: connectionRow(),
    });
    const result = await service.disconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("DISCONNECTED");

    const logout = invocations.find((i) => i.args.join(" ") === "auth logout");
    expect(logout).toBeTruthy();
    assertManagedEnv(logout.env, PROFILE_A());
    // Profile B's roots are never touched — every home var names A's dir.
    for (const key of ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"]) {
      expect(logout.env[key]).not.toContain(RP_B);
    }
    expect(fs.statSync(PROFILE_B()).isDirectory()).toBe(true);
  });
});

describe("verify (Devin)", () => {
  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_v",
      operation: "verify",
      backendKind: "DEVIN_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("reports CONNECTED for a verified via-Devin session", async () => {
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("CONNECTED");
    assertManagedEnv(statusInv().env, PROFILE_A());
  });

  it("reports a token session as UNKNOWN → ERROR, never CONNECTED", async () => {
    statusOutput = { stdout: STATUS_TOKEN };
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.authState).toBe("UNKNOWN");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_v", {
      outcome: "auth_state",
      authState: "UNKNOWN",
    });
  });

  it("reports a missing session as NOT_AUTHENTICATED", async () => {
    statusOutput = { stdout: STATUS_UNAUTHED, exitCode: 1 };
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.authState).toBe("NOT_AUTHENTICATED");
  });
});

describe("listModels (Devin)", () => {
  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_m",
      operation: "listModels",
      backendKind: "DEVIN_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("discovers the runtime catalog inside the managed env", async () => {
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.dynamicDiscoverySupported).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual([
      "swe-2-high",
      "swe-2-max",
      "fusion-x",
    ]);
    for (const m of result.models) {
      expect(m.source).toBe("RUNTIME");
    }
    const inv = invocations.find(
      (i) => i.args.join(" ") === "models list --format json",
    );
    assertManagedEnv(inv.env, PROFILE_A());
  });

  it("malformed catalog output is MODEL_DISCOVERY_UNAVAILABLE", async () => {
    runnerScript.unshift({
      match: (h) => h === "models list --format json",
      respond: respond({ stdout: "not json at all" }),
    });
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.code).toBe("MODEL_DISCOVERY_UNAVAILABLE");
  });
});

describe("runSmoke (Devin)", () => {
  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_s",
      operation: "smoke",
      backendKind: "DEVIN_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("runs -p in a fresh temp cwd with minimum permissions", async () => {
    runnerScript.push({
      match: (h) => h.startsWith("-p "),
      respond: respond({ stdout: "VOCATRYA_DEVIN_OK\n" }),
    });
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
      model: "swe-2-high",
    });
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(true);
    expect(result.text).toBe("VOCATRYA_DEVIN_OK");

    const inv = invocations.find((i) => i.args.join(" ").startsWith("-p "));
    expect(inv.args[0]).toBe("-p");
    // The prompt rides --prompt-file inside the fresh workDir — the file
    // is already removed with the workDir, so only the path shape is
    // asserted here; content coverage lives in devin.test.mjs.
    expect(inv.args[1]).toBe("--prompt-file");
    expect(inv.args[2].startsWith(inv.cwd)).toBe(true);
    expect(inv.args[2].endsWith("prompt.txt")).toBe(true);
    expect(inv.args).toContain("--permission-mode");
    expect(inv.args).toContain("auto");
    expect(inv.args).toContain("--respect-workspace-trust");
    expect(inv.args).toContain("--model");
    expect(inv.args).toContain("swe-2-high");
    const joined = inv.args.join(" ");
    expect(joined).not.toMatch(/--cloud|yolo|dangerous|bypass|acp/i);
    // Fresh Vocatrya temp cwd — never the repo or the user profile.
    expect(inv.cwd).toContain(smokeWorkRoot);
    expect(inv.cwd).not.toBe(PROFILE_A());
    assertManagedEnv(inv.env, PROFILE_A());
    // Org pinning ran before the smoke invocation.
    const whoami = invocations.find(
      (i) => i.args.join(" ") === "cloud drs whoami",
    );
    expect(whoami).toBeTruthy();
    const config = JSON.parse(
      fs.readFileSync(
        path.join(
          PROFILE_A(),
          "home",
          "AppData",
          "Roaming",
          "devin",
          "config.json",
        ),
        "utf8",
      ),
    );
    expect(config.devin.org_id).toBe("org-test123");
  });

  it("INFERENCE_FAILED on nonzero exit", async () => {
    runnerScript.push({
      match: (h) => h.startsWith("-p "),
      respond: respond({ exitCode: 1, stderr: "boom" }),
    });
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.code).toBe("INFERENCE_FAILED");
  });
});

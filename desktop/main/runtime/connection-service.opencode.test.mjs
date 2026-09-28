// OpenCode lifecycle tests — same coverage shape as the Codex and Claude
// suites, driven through the OPENCODE_RUNTIME adapter bound to the
// OPENCODE_GO / OPENCODE_ZEN account providers. Proves: ticket-pinned
// provider binding, XDG isolation, vendor API-key classification, the
// visible-console login launch, disconnect isolation, model discovery,
// and the deny-by-default smoke invocation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serviceModule from "./connection-service.js";

const { createConnectionService } = serviceModule;

const FAKE_EXE = "C:\\fake\\opencode.exe";
const RP_A = "rp_11111111-1111-4111-8111-111111111111";
const RP_B = "rp_22222222-2222-4222-8222-222222222222";
const PROFILE_A = () => path.join(profilesRoot, RP_A);
const PROFILE_B = () => path.join(profilesRoot, RP_B);

// `auth list` output as opencode 1.18.31 emits it (ANSI-stripped shape).
function authList(entries, profileDir) {
  const lines = [`T  Credentials ${profileDir}\\data\\opencode\\auth.json`, "|"];
  for (const { name, type } of entries) {
    lines.push(`•  ${name} ${type}`, "|");
  }
  lines.push(`—  ${entries.length} credentials`, "");
  return lines.join("\n");
}
const GO_API = (dir) => authList([{ name: "OpenCode Go", type: "api" }], dir);
const GO_OAUTH = (dir) =>
  authList([{ name: "OpenCode Go", type: "oauth" }], dir);
const ZEN_API = (dir) =>
  authList([{ name: "OpenCode Zen", type: "api" }], dir);
const OPENAI_OAUTH = (dir) =>
  authList([{ name: "OpenAI", type: "oauth" }], dir);
const EMPTY_LIST = (dir) => authList([], dir);

let profilesRoot;
let smokeWorkRoot;
let invocations;
let runnerScript;
let backend;
let service;
let oauthEvents;

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

function makeDeps() {
  return {
    platform: "win32",
    env: {
      PATH: "C:\\Windows",
      // Poison the ambient env — nothing credential-shaped may reach the
      // managed process environment (spec §43).
      OPENAI_API_KEY: "sk-ambient",
      ANTHROPIC_API_KEY: "sk-ant-ambient",
      XAI_API_KEY: "xai-ambient",
      OPENROUTER_API_KEY: "or-ambient",
      GITHUB_TOKEN: "ghp_ambient",
      GH_TOKEN: "ghp_ambient2",
      OPENCODE_API_KEY: "oc-ambient",
    },
    existsSyncImpl: (p) => p === FAKE_EXE,
    spawnSyncImpl: (cmd, args) => {
      if (cmd === "where.exe") return { status: 0, stdout: `${FAKE_EXE}\r\n` };
      return { status: 0, stdout: "1.18.31\n", stderr: "" };
    },
    runner: vi.fn(runnerImpl),
    notifyOAuthUrl: vi.fn(),
  };
}

function connectionRow(overrides = {}) {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "OPENCODE_GO",
    authType: "ACCOUNT_LOGIN",
    backendKind: "OPENCODE_RUNTIME",
    displayName: "OpenCode Go",
    accountIdentity: null,
    status: "CONNECTED",
    runtimeProfileRef: RP_A,
    lastVerifiedAt: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function loginResolve(accountProvider = "OPENCODE_GO") {
  return {
    ok: true,
    operationId: "op_1",
    operation: "login",
    backendKind: "OPENCODE_RUNTIME",
    accountProvider,
  };
}

beforeEach(() => {
  profilesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-profiles-"));
  smokeWorkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-smoke-"));
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
    deps: { ...makeDeps(), notifyOAuthUrl: (e) => oauthEvents.push(e) },
    loginTimeoutMs: 30_000,
  });
});

afterEach(() => {
  fs.rmSync(profilesRoot, { recursive: true, force: true });
  fs.rmSync(smokeWorkRoot, { recursive: true, force: true });
});

function assertManagedEnv(inv, expectedProfileDir) {
  // All four XDG roots isolate the profile — never OPENCODE_CONFIG_DIR
  // alone, and never a host path.
  expect(inv.env.XDG_DATA_HOME).toBe(`${expectedProfileDir}\\data`);
  expect(inv.env.XDG_CONFIG_HOME).toBe(`${expectedProfileDir}\\config`);
  expect(inv.env.XDG_CACHE_HOME).toBe(`${expectedProfileDir}\\cache`);
  expect(inv.env.XDG_STATE_HOME).toBe(`${expectedProfileDir}\\state`);
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "OPENCODE_API_KEY",
  ]) {
    expect(inv.env[key], `leaked ${key}`).toBeUndefined();
  }
  // The real user profile is never the target.
  for (const key of ["XDG_DATA_HOME", "HOME", "USERPROFILE"]) {
    if (inv.env[key]) {
      expect(inv.env[key].startsWith(expectedProfileDir)).toBe(true);
    }
  }
}

// Runner script for the login flow: the console-launched
// `auth login --pure -p <provider>`; `auth list` reports the credential
// state afterwards. `start /wait` does not propagate the exit code — the
// probe is the only verdict.
function loginScript(loginBehavior, listStdout = null) {
  runnerScript = [
    {
      match: (h) => h.includes("auth login"),
      respond: (inv) => loginBehavior(inv),
    },
    {
      match: (h) => h === "auth list",
      respond: (inv) =>
        Promise.resolve({
          exitCode: 0,
          stdout:
            typeof listStdout === "function"
              ? listStdout(inv)
              : (listStdout ?? GO_API(inv.env.XDG_DATA_HOME.replace(/\\data$/, ""))),
          stderr: "",
        }),
    },
  ];
}

describe("startLogin (OpenCode Go)", () => {
  it("launches the vendor TUI in a console window, isolates XDG roots, persists OPENCODE_GO", async () => {
    loginScript(respond({}));
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("CONNECTED");

    const profileRef =
      backend.completeOperation.mock.calls[0][1].runtimeProfileRef;
    expect(profileRef).toMatch(/^rp_[0-9a-f-]{36}$/);
    const profileDir = path.join(profilesRoot, profileRef);
    expect(fs.statSync(profileDir).isDirectory()).toBe(true);

    const loginInv = invocations.find((i) =>
      i.args.join(" ").includes("auth login"),
    );
    const listInv = invocations.find((i) => i.args.join(" ") === "auth list");
    // The interactive credential TUI needs a real console window — it is
    // launched through cmd start /wait, never piped.
    expect(loginInv.executable).toBe("cmd.exe");
    expect(loginInv.args.slice(0, 5)).toEqual([
      "/d",
      "/c",
      "start",
      "",
      "/wait",
    ]);
    expect(loginInv.args.slice(6).join(" ")).toBe(
      "auth login --pure -p opencode-go",
    );
    assertManagedEnv(loginInv, profileDir);
    assertManagedEnv(listInv, profileDir);

    // The backend persists the adapter-verified provider — the product
    // account, never the runtime vendor and never OPENAI.
    expect(backend.completeOperation).toHaveBeenCalledWith("op_1", {
      outcome: "authenticated",
      verifiedProvider: "OPENCODE_GO",
      runtimeProfileRef: profileRef,
      accountIdentity: null,
      providerMetadata: {
        authType: "api",
        product: "OpenCode Go",
      },
    });

    // There is no vendor OAuth URL to surface — no auth events fire.
    expect(oauthEvents).toEqual([]);
  });

  it("a Zen login ticket pins -p opencode", async () => {
    backend.resolveTicket.mockResolvedValue(loginResolve("OPENCODE_ZEN"));
    loginScript(respond({}), (inv) =>
      ZEN_API(inv.env.XDG_DATA_HOME.replace(/\\data$/, "")),
    );
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    const loginInv = invocations.find((i) =>
      i.args.join(" ").includes("auth login"),
    );
    expect(loginInv.args.slice(6).join(" ")).toBe(
      "auth login --pure -p opencode",
    );
    expect(backend.completeOperation).toHaveBeenCalledWith(
      "op_1",
      expect.objectContaining({ verifiedProvider: "OPENCODE_ZEN" }),
    );
  });

  it("rejects a foreign credential for the bound product", async () => {
    // A Zen key does not satisfy a Go connection — the account products
    // are distinct identities.
    loginScript(respond({}), (inv) =>
      ZEN_API(inv.env.XDG_DATA_HOME.replace(/\\data$/, "")),
    );
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_NOT_CONFIRMED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("rejects a non-api credential for the bound provider", async () => {
    loginScript(respond({}), (inv) =>
      GO_OAUTH(inv.env.XDG_DATA_HOME.replace(/\\data$/, "")),
    );
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_METHOD_UNVERIFIED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects a ChatGPT credential entirely — it is not an OpenCode account", async () => {
    loginScript(respond({}), (inv) =>
      OPENAI_OAUTH(inv.env.XDG_DATA_HOME.replace(/\\data$/, "")),
    );
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_NOT_CONFIRMED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects an unclassifiable auth list — exit 0 never proves auth", async () => {
    loginScript(respond({}), "unexpected output");
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_NOT_CONFIRMED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects providers the adapter does not implement (Copilot)", async () => {
    backend.resolveTicket.mockResolvedValue(loginResolve("GITHUB_COPILOT"));
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects a ChatGPT ticket — OpenAI is never an OpenCode account", async () => {
    backend.resolveTicket.mockResolvedValue(loginResolve("OPENAI"));
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects a login ticket with no account provider pinned", async () => {
    backend.resolveTicket.mockResolvedValue(loginResolve(null));
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects the runtime vendor as an account provider", async () => {
    backend.resolveTicket.mockResolvedValue(loginResolve("OPENCODE"));
    const result = await service.startLogin({
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION");
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
      backendKind: "OPENCODE_RUNTIME",
      ticket: "t",
    });
    expect(result).toEqual({ ok: false, code: "RUNTIME_NOT_INSTALLED" });
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });
});

describe("reconnect (OpenCode)", () => {
  const connTicket = () => ({
    ok: true,
    operationId: "op_rec",
    operation: "reconnect",
    backendKind: "OPENCODE_RUNTIME",
    connection: connectionRow(),
  });

  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockImplementation(async () => connTicket());
  });

  it("re-authenticates inside the same XDG profile and keeps the row", async () => {
    loginScript(respond({}));
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.id).toBe("conn-1");
    const loginInv = invocations.find((i) =>
      i.args.join(" ").includes("auth login"),
    );
    assertManagedEnv(loginInv, PROFILE_A());
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "authenticated",
      accountIdentity: null,
      providerMetadata: {
        authType: "api",
        product: "OpenCode Go",
      },
    });
  });
});

describe("disconnect (OpenCode)", () => {
  it("logs out only inside the target profile's XDG roots", async () => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    fs.mkdirSync(PROFILE_B(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_dc",
      operation: "disconnect",
      backendKind: "OPENCODE_RUNTIME",
      connection: connectionRow(),
    });
    runnerScript = [
      {
        match: (h) => h === "auth logout opencode-go",
        respond: respond({}),
      },
    ];
    const result = await service.disconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("DISCONNECTED");

    const logoutInv = invocations.find(
      (i) => i.args.join(" ") === "auth logout opencode-go",
    );
    expect(logoutInv).toBeTruthy();
    assertManagedEnv(logoutInv, PROFILE_A());
    // Profile B's roots are never touched — every XDG root names A's dir.
    for (const key of [
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]) {
      expect(logoutInv.env[key]).not.toContain(RP_B);
    }
  });
});

describe("verify (OpenCode)", () => {
  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_v",
      operation: "verify",
      backendKind: "OPENCODE_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("reports CONNECTED for the bound vendor API-key credential", async () => {
    runnerScript = [
      {
        match: (h) => h === "auth list",
        respond: respond({ stdout: GO_API(PROFILE_A()) }),
      },
    ];
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("CONNECTED");
    const inv = invocations.find((i) => i.args.join(" ") === "auth list");
    assertManagedEnv(inv, PROFILE_A());
  });

  it("reports a foreign credential as UNKNOWN → ERROR, never CONNECTED", async () => {
    runnerScript = [
      {
        match: (h) => h === "auth list",
        respond: respond({ stdout: GO_OAUTH(PROFILE_A()) }),
      },
    ];
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.authState).toBe("UNKNOWN");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_v", {
      outcome: "auth_state",
      authState: "UNKNOWN",
    });
  });
});

describe("listModels (OpenCode)", () => {
  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_m",
      operation: "listModels",
      backendKind: "OPENCODE_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("discovers opencode-go route models and excludes other providers", async () => {
    runnerScript = [
      {
        match: (h) => h === "models opencode-go",
        respond: respond({
          stdout: "opencode-go/kimi-k2.5\nopencode-go/glm-5\nopenai/gpt-5.5\n",
        }),
      },
    ];
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.dynamicDiscoverySupported).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual([
      "opencode-go/kimi-k2.5",
      "opencode-go/glm-5",
    ]);
    for (const m of result.models) {
      expect(m.id.startsWith("opencode-go/")).toBe(true);
      expect(m.source).toBe("RUNTIME");
    }
    const inv = invocations.find((i) => i.args.join(" ") === "models opencode-go");
    assertManagedEnv(inv, PROFILE_A());
  });

  it("falls back to a filtered full listing when scoped discovery fails", async () => {
    runnerScript = [
      {
        match: (h) => h === "models opencode-go",
        respond: respond({ exitCode: 1, stderr: "Provider not found" }),
      },
      {
        match: (h) => h === "models",
        respond: respond({
          stdout:
            "opencode/minimax-m2.5\nopencode-go/kimi-k2.5\nanthropic/claude-sonnet\n",
        }),
      },
    ];
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual(["opencode-go/kimi-k2.5"]);
  });

  it("returns MODEL_DISCOVERY_UNAVAILABLE when the runtime cannot list", async () => {
    runnerScript = [
      { match: () => true, respond: respond({ exitCode: 1, stderr: "boom" }) },
    ];
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MODEL_DISCOVERY_UNAVAILABLE");
    // The ticket is still consumed — the op completed with a failure, not
    // silently dropped.
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });
});

describe("runSmoke (OpenCode)", () => {
  beforeEach(() => {
    fs.mkdirSync(PROFILE_A(), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_s",
      operation: "smoke",
      backendKind: "OPENCODE_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("runs in a temp cwd with a deny-all managed config and no --auto", async () => {
    runnerScript = [
      {
        match: (h) => h.startsWith("run "),
        respond: respond({
          stdout:
            '{"type":"text","part":{"text":"VOCATRYA_OPENCODE_OK"}}\n',
        }),
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
      model: "opencode-go/kimi-k2.5",
    });
    expect(result.ok).toBe(true);
    expect(result.matched).toBe(true);

    const smokeInv = invocations.find((i) => i.args[0] === "run");
    expect(smokeInv.args).toContain("--pure");
    expect(smokeInv.args).toContain("--format");
    expect(smokeInv.args).not.toContain("--auto");
    expect(smokeInv.args).toEqual(
      expect.arrayContaining(["-m", "opencode-go/kimi-k2.5"]),
    );
    // cwd is a fresh Vocatrya-owned temp dir, not the repo or a user dir.
    expect(smokeInv.cwd.startsWith(smokeWorkRoot)).toBe(true);
    expect(smokeInv.cwd).not.toBe(smokeWorkRoot);
    assertManagedEnv(smokeInv, PROFILE_A());

    // The deny-all config was written into the managed profile.
    const written = JSON.parse(
      fs.readFileSync(
        path.join(PROFILE_A(), "config", "opencode", "opencode.json"),
        "utf8",
      ),
    );
    expect(written.permission["*"]).toBe("deny");
    expect(written.plugin).toEqual([]);
    expect(written.mcp).toEqual({});
    // Temp cwd is cleaned up afterwards.
    expect(fs.existsSync(smokeInv.cwd)).toBe(false);
  });

  it("discovers a smoke model when none is supplied", async () => {
    runnerScript = [
      {
        match: (h) => h === "models opencode-go",
        respond: respond({ stdout: "opencode-go/kimi-k2.5\n" }),
      },
      {
        match: (h) => h.startsWith("run "),
        respond: respond({ stdout: '{"type":"text","part":{"text":"VOCATRYA_OPENCODE_OK"}}' }),
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    const smokeInv = invocations.find((i) => i.args[0] === "run");
    expect(smokeInv.args).toEqual(
      expect.arrayContaining(["-m", "opencode-go/kimi-k2.5"]),
    );
  });

  it("refuses a foreign provider route for smoke", async () => {
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
      model: "openai/gpt-5.5",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MODEL_UNAVAILABLE");
    // No run was attempted.
    expect(invocations.find((i) => i.args[0] === "run")).toBeUndefined();
  });
});

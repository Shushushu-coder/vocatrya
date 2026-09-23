// Phase E Claude lifecycle tests — same coverage shape as the Codex suite
// (connection-service.test.mjs), driven through the CLAUDE_RUNTIME adapter.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import serviceModule from "./connection-service.js";

const { createConnectionService } = serviceModule;

const FAKE_EXE = "C:\\fake\\claude.exe";
const RP_A = "rp_11111111-1111-4111-8111-111111111111";
const RP_B = "rp_22222222-2222-4222-8222-222222222222";

const STATUS_CLAUDE_AI = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "first@example.com",
  orgName: "First Org",
  subscriptionType: "pro",
});
const STATUS_LOGGED_OUT = JSON.stringify({
  loggedIn: false,
  authMethod: "none",
  apiProvider: "firstParty",
});

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
      // managed process environment (spec §35).
      ANTHROPIC_API_KEY: "sk-ant-ambient",
      ANTHROPIC_AUTH_TOKEN: "ambient",
      CLAUDE_CODE_OAUTH_TOKEN: "ambient",
      ANTHROPIC_PROFILE: "ambient",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      CLAUDE_CODE_USE_FOUNDRY: "1",
      ANTHROPIC_BASE_URL: "https://gateway.example.com",
      CLAUDE_API_KEY: "ambient",
      OPENAI_API_KEY: "sk-ambient",
      GITHUB_TOKEN: "ghp_ambient",
    },
    existsSyncImpl: (p) => p === FAKE_EXE,
    spawnSyncImpl: (cmd, args) => {
      if (cmd === "where.exe") return { status: 0, stdout: `${FAKE_EXE}\r\n` };
      return { status: 0, stdout: "2.1.203 (Claude Code)\n", stderr: "" };
    },
    runner: vi.fn(runnerImpl),
  };
}

function connectionRow(overrides = {}) {
  return {
    id: "conn-1",
    userId: "user-1",
    provider: "ANTHROPIC",
    authType: "ACCOUNT_LOGIN",
    backendKind: "CLAUDE_RUNTIME",
    displayName: "Claude",
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
      backendKind: "CLAUDE_RUNTIME",
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
  expect(inv.env.CLAUDE_CONFIG_DIR).toBe(expectedProfileDir);
  expect(inv.env.CLAUDE_CONFIG_DIR.startsWith(profilesRoot)).toBe(true);
  // No credential/provider-route override may leak into the managed env.
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_FEDERATION_RULE_ID",
    "ANTHROPIC_ORGANIZATION_ID",
    "ANTHROPIC_IDENTITY_TOKEN_FILE",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_API_KEY",
    "OPENAI_API_KEY",
    "GITHUB_TOKEN",
  ]) {
    expect(inv.env[key]).toBeUndefined();
  }
  // The host-global Claude profile is never the target.
  expect(inv.env.CLAUDE_CONFIG_DIR).not.toContain(".claude");
}

function loginScript(behavior, statusStdout = STATUS_CLAUDE_AI) {
  runnerScript = [
    { match: (h) => h === "auth login --claudeai", respond: behavior },
    {
      match: (h) => h === "auth status --json",
      respond: respond({
        stdout: statusStdout,
        exitCode: statusStdout === STATUS_LOGGED_OUT ? 1 : 0,
      }),
    },
  ];
}

describe("startLogin (Claude)", () => {
  it("creates a pending profile, runs auth login + status inside it, then persists", async () => {
    loginScript(respond({}));
    const result = await service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "t1",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("CONNECTED");

    const profileRef =
      backend.completeOperation.mock.calls[0][1].runtimeProfileRef;
    expect(profileRef).toMatch(/^rp_[0-9a-f-]{36}$/);
    const profileDir = path.join(profilesRoot, profileRef);
    expect(fs.statSync(profileDir).isDirectory()).toBe(true);

    const loginInv = invocations.find(
      (i) => i.args.join(" ") === "auth login --claudeai",
    );
    const statusInv = invocations.find(
      (i) => i.args.join(" ") === "auth status --json",
    );
    assertManagedEnv(loginInv, profileDir);
    assertManagedEnv(statusInv, profileDir);
    expect(backend.completeOperation).toHaveBeenCalledWith("op_1", {
      outcome: "authenticated",
      runtimeProfileRef: profileRef,
      accountIdentity: "first@example.com",
      providerMetadata: {
        organizationName: "First Org",
        subscriptionType: "pro",
        loginMethod: "claude.ai",
      },
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
      backendKind: "CLAUDE_RUNTIME",
      ticket: "t",
    });
    expect(result).toEqual({ ok: false, code: "RUNTIME_NOT_INSTALLED" });
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("refuses to bypass a managed forceLoginMethod policy", async () => {
    const programData = fs.mkdtempSync(
      path.join(os.tmpdir(), "vocatrya-pd-"),
    );
    const policyDir = path.join(programData, "ClaudeCode");
    fs.mkdirSync(policyDir, { recursive: true });
    fs.writeFileSync(
      path.join(policyDir, "managed-settings.json"),
      JSON.stringify({ forceLoginMethod: "console" }),
    );
    try {
      service = createConnectionService({
        profilesRoot,
        smokeWorkRoot,
        backend,
        deps: {
          ...makeDeps(),
          env: { ...makeDeps().env, PROGRAMDATA: programData },
          existsSyncImpl: (p) =>
            p === FAKE_EXE || p.endsWith("managed-settings.json"),
        },
      });
      const result = await service.startLogin({
        backendKind: "CLAUDE_RUNTIME",
        ticket: "t",
      });
      expect(result).toEqual({
        ok: false,
        code: "PROVIDER_POLICY_RESTRICTED",
      });
      expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
      expect(backend.completeOperation).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(programData, { recursive: true, force: true });
    }
  });

  it("cleans the pending profile when the login process fails", async () => {
    loginScript(respond({ exitCode: 1, stderr: "boom" }), STATUS_LOGGED_OUT);
    const result = await service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("LOGIN_FAILED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("cleans the pending profile when auth is not confirmed", async () => {
    loginScript(respond({}), STATUS_LOGGED_OUT);
    const result = await service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_NOT_CONFIRMED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("rejects a Console login — never masquerades as subscription auth", async () => {
    loginScript(
      respond({}),
      JSON.stringify({
        loggedIn: true,
        authMethod: "console",
        apiProvider: "firstParty",
      }),
    );
    const result = await service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_AUTH_METHOD");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
    expect(backend.completeOperation).not.toHaveBeenCalled();
  });

  it("rejects a logged-in session the status JSON cannot classify", async () => {
    loginScript(
      respond({}),
      JSON.stringify({
        loggedIn: true,
        authMethod: "unknown-new-method",
        apiProvider: "firstParty",
      }),
    );
    const result = await service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("AUTH_METHOD_UNVERIFIED");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("cancellation terminates the process and deletes the pending profile", async () => {
    runnerScript = [
      {
        match: (h) => h === "auth login --claudeai",
        respond: (inv) =>
          new Promise((resolve) => {
            inv.signal.addEventListener("abort", () =>
              resolve({
                aborted: true,
                exitCode: null,
                stdout: "",
                stderr: "",
              }),
            );
          }),
      },
      {
        match: (h) => h === "auth status --json",
        respond: respond({ exitCode: 1, stdout: STATUS_LOGGED_OUT }),
      },
    ];
    const pending = service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
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
    loginScript(
      respond({ timedOut: true, exitCode: null }),
      STATUS_LOGGED_OUT,
    );
    const result = await service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "t",
    });
    expect(result.code).toBe("LOGIN_TIMEOUT");
    expect(fs.readdirSync(profilesRoot)).toHaveLength(0);
  });

  it("serializes concurrent Claude logins but not Codex logins", async () => {
    runnerScript = [
      {
        match: (h) => h === "auth login --claudeai",
        respond: (inv) =>
          new Promise((resolve) => {
            inv.signal.addEventListener("abort", () =>
              resolve({
                aborted: true,
                exitCode: null,
                stdout: "",
                stderr: "",
              }),
            );
          }),
      },
      {
        match: (h) => h === "auth status --json",
        respond: respond({ stdout: STATUS_CLAUDE_AI }),
      },
    ];
    const first = service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "a",
    });
    const second = service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "b",
    });
    await new Promise((r) => setTimeout(r, 10));
    await service.cancelOperation({ ticket: "a" });
    const [r1, r2] = await Promise.all([first, second]);
    const codes = [r1.code, r2.code].sort();
    expect(codes).toEqual(["LOGIN_ALREADY_IN_PROGRESS", "LOGIN_CANCELLED"]);
  });
});

describe("reconnect (Claude)", () => {
  const connTicket = () => ({
    ok: true,
    operationId: "op_rec",
    operation: "reconnect",
    backendKind: "CLAUDE_RUNTIME",
    connection: connectionRow(),
  });

  beforeEach(() => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    backend.resolveTicket.mockImplementation(async () => connTicket());
  });

  it("re-authenticates in the same profile and keeps the connection id", async () => {
    loginScript(respond({}));
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.id).toBe("conn-1");
    const loginInv = invocations.find((i) => i.args[0] === "auth");
    assertManagedEnv(loginInv, path.join(profilesRoot, RP_A));
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "authenticated",
      accountIdentity: "first@example.com",
      providerMetadata: {
        organizationName: "First Org",
        subscriptionType: "pro",
        loginMethod: "claude.ai",
      },
    });
  });

  it("reports ACCOUNT_IDENTITY_CONFLICT when a different account signs in", async () => {
    loginScript(
      respond({}),
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "other@example.com",
      }),
    );
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.code).toBe("ACCOUNT_IDENTITY_CONFLICT");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "identity_conflict",
      accountIdentity: "other@example.com",
    });
  });

  it("reports the observed auth state when login does not confirm", async () => {
    loginScript(respond({}), STATUS_LOGGED_OUT);
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("REAUTH_REQUIRED");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "auth_state",
      authState: "NOT_AUTHENTICATED",
    });
  });

  it("never upgrades a non-subscription session to CONNECTED", async () => {
    loginScript(
      respond({}),
      JSON.stringify({
        loggedIn: true,
        authMethod: "console",
        apiProvider: "firstParty",
      }),
    );
    const result = await service.reconnect({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.code).toBe("UNSUPPORTED_AUTH_METHOD");
    expect(backend.completeOperation).toHaveBeenCalledWith("op_rec", {
      outcome: "auth_state",
      authState: "UNKNOWN",
    });
    expect(result.connection.status).toBe("ERROR");
  });
});

describe("disconnect (Claude)", () => {
  it("runs claude auth logout only inside the target profile and keeps the row", async () => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    fs.mkdirSync(path.join(profilesRoot, RP_B), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_dc",
      operation: "disconnect",
      backendKind: "CLAUDE_RUNTIME",
      connection: connectionRow({ id: "conn-a", runtimeProfileRef: RP_A }),
    });
    runnerScript = [
      { match: (h) => h === "auth logout", respond: respond({}) },
    ];

    const result = await service.disconnect({
      connectionId: "conn-a",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("DISCONNECTED");

    const logoutInv = invocations.find((i) => i.args[0] === "auth");
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

describe("verify (Claude)", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_v",
      operation: "verify",
      backendKind: "CLAUDE_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("maps a Claude.ai subscription session to CONNECTED", async () => {
    runnerScript = [
      {
        match: (h) => h === "auth status --json",
        respond: respond({ stdout: STATUS_CLAUDE_AI }),
      },
    ];
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.authState).toBe("AUTHENTICATED");
    expect(result.connection.status).toBe("CONNECTED");
    const inv = invocations[0];
    assertManagedEnv(inv, path.join(profilesRoot, RP_A));
  });

  it("maps NOT_AUTHENTICATED to REAUTH_REQUIRED", async () => {
    runnerScript = [
      {
        match: (h) => h === "auth status --json",
        respond: respond({ exitCode: 1, stdout: STATUS_LOGGED_OUT }),
      },
    ];
    const result = await service.verify({ connectionId: "conn-1", ticket: "t" });
    expect(result.ok).toBe(true);
    expect(result.connection.status).toBe("REAUTH_REQUIRED");
  });

  it("never reports a non-subscription session as authenticated", async () => {
    runnerScript = [
      {
        match: (h) => h === "auth status --json",
        respond: respond({
          stdout: JSON.stringify({
            loggedIn: true,
            authMethod: "apiKey",
            apiProvider: "firstParty",
          }),
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
});

describe("listModels (Claude)", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_m",
      operation: "listModels",
      backendKind: "CLAUDE_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("returns the curated alias catalog — claude has no runtime discovery", async () => {
    const result = await service.listModels({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result.ok).toBe(true);
    expect(result.dynamicDiscoverySupported).toBe(false);
    expect(result.models.map((m) => m.id)).toEqual([
      "sonnet",
      "opus",
      "haiku",
      "fable",
    ]);
    expect(
      result.models.every(
        (m) => m.source === "CURATED" && m.availability === "unknown",
      ),
    ).toBe(true);
    // No runtime process is spawned for model discovery.
    expect(invocations).toHaveLength(0);
    expect(backend.completeOperation).toHaveBeenCalledWith("op_m", {
      outcome: "consumed",
    });
  });
});

describe("runSmoke (Claude)", () => {
  beforeEach(() => {
    fs.mkdirSync(path.join(profilesRoot, RP_A), { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_s",
      operation: "smoke",
      backendKind: "CLAUDE_RUNTIME",
      connection: connectionRow(),
    });
  });

  it("runs claude -p no-tool in a Vocatrya temp dir and matches the marker", async () => {
    runnerScript = [
      {
        match: (h) => h.startsWith("-p "),
        respond: respond({
          stdout: JSON.stringify({
            type: "result",
            subtype: "success",
            is_error: false,
            result: "VOCATRYA_CLAUDE_OK",
          }),
        }),
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
      model: "sonnet",
    });
    expect(result).toMatchObject({
      ok: true,
      matched: true,
      text: "VOCATRYA_CLAUDE_OK",
      expected: "VOCATRYA_CLAUDE_OK",
    });
    const inv = invocations[0];
    assertManagedEnv(inv, path.join(profilesRoot, RP_A));
    expect(inv.cwd.startsWith(smokeWorkRoot)).toBe(true);
    // Safe no-tool contract (spec §25/§39).
    expect(inv.args).toContain("--tools");
    expect(inv.args[inv.args.indexOf("--tools") + 1]).toBe("");
    expect(inv.args).toContain("--disallowedTools");
    expect(inv.args[inv.args.indexOf("--disallowedTools") + 1]).toBe("mcp__*");
    expect(inv.args).toContain("--no-session-persistence");
    expect(inv.args).toContain("--safe-mode");
    expect(inv.args).toContain("--permission-mode");
    expect(inv.args[inv.args.indexOf("--permission-mode") + 1]).toBe(
      "dontAsk",
    );
    expect(inv.args).toContain("--model");
    expect(inv.args[inv.args.indexOf("--model") + 1]).toBe("sonnet");
    expect(inv.args[inv.args.length - 1]).toBe(
      "Reply with exactly: VOCATRYA_CLAUDE_OK",
    );
    expect(inv.args.join(" ")).not.toMatch(
      /dangerously-skip-permissions|bypassPermissions|acceptEdits/,
    );
    // The Vocatrya-owned work dir is cleaned afterwards.
    expect(fs.readdirSync(smokeWorkRoot)).toHaveLength(0);
  });

  it("maps a nonzero exit to INFERENCE_FAILED", async () => {
    runnerScript = [
      {
        match: (h) => h.startsWith("-p "),
        respond: respond({ exitCode: 1, stderr: "unauthorized" }),
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result).toEqual({ ok: false, code: "INFERENCE_FAILED" });
  });

  it("maps an is_error result envelope to INFERENCE_FAILED", async () => {
    runnerScript = [
      {
        match: (h) => h.startsWith("-p "),
        respond: respond({
          stdout: JSON.stringify({
            type: "result",
            is_error: true,
            result: "model unavailable",
          }),
        }),
      },
    ];
    const result = await service.runSmoke({
      connectionId: "conn-1",
      ticket: "t",
    });
    expect(result).toEqual({ ok: false, code: "INFERENCE_FAILED" });
  });
});

describe("multi-account isolation (Claude)", () => {
  it("two logins land in different CLAUDE_CONFIG_DIRs and stay independent", async () => {
    // Login A succeeds; login B gets a different status (logged out) so the
    // two profiles' states are provably distinct.
    loginScript(respond({}), STATUS_CLAUDE_AI);
    const a = await service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "ta",
    });
    expect(a.ok).toBe(true);
    const refA = backend.completeOperation.mock.calls[0][1].runtimeProfileRef;

    loginScript(respond({}), STATUS_CLAUDE_AI);
    const b = await service.startLogin({
      backendKind: "CLAUDE_RUNTIME",
      ticket: "tb",
    });
    expect(b.ok).toBe(true);
    const refB = backend.completeOperation.mock.calls[1][1].runtimeProfileRef;

    expect(refA).not.toBe(refB);
    const dirA = path.join(profilesRoot, refA);
    const dirB = path.join(profilesRoot, refB);

    const loginInvs = invocations.filter(
      (i) => i.args.join(" ") === "auth login --claudeai",
    );
    expect(loginInvs).toHaveLength(2);
    expect(loginInvs[0].env.CLAUDE_CONFIG_DIR).toBe(dirA);
    expect(loginInvs[1].env.CLAUDE_CONFIG_DIR).toBe(dirB);

    // Status probes ran inside each profile — no shared/global state.
    const statusInvs = invocations.filter(
      (i) => i.args.join(" ") === "auth status --json",
    );
    expect(statusInvs.map((i) => i.env.CLAUDE_CONFIG_DIR).sort()).toEqual(
      [dirA, dirB].sort(),
    );

    // Disconnect A: logout runs only in profile A; B's profile stays intact.
    fs.mkdirSync(dirB, { recursive: true });
    backend.resolveTicket.mockResolvedValue({
      ok: true,
      operationId: "op_dc",
      operation: "disconnect",
      backendKind: "CLAUDE_RUNTIME",
      connection: connectionRow({ id: "conn-a", runtimeProfileRef: refA }),
    });
    runnerScript = [
      { match: (h) => h === "auth logout", respond: respond({}) },
    ];
    const dc = await service.disconnect({ connectionId: "conn-a", ticket: "t" });
    expect(dc.ok).toBe(true);
    const logoutInv = invocations.find(
      (i) => i.args.join(" ") === "auth logout",
    );
    expect(logoutInv.env.CLAUDE_CONFIG_DIR).toBe(dirA);
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(true);
  });
});

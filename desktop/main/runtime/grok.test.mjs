// Phase G Grok adapter unit tests — the account-login surface is identical
// in shape to codex/claude/opencode, but auth state is proven through the
// ACP stdio handshake rather than a status command.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRuntimeDefinition } from "./registry.js";
import {
  GROK_MANAGED_CONFIG_TOML,
  buildGrokLoginInvocation,
  buildGrokLogoutInvocation,
  buildGrokPrintInvocation,
  classifyGrokAuthError,
  classifyGrokAuthMode,
  extractGrokLoginUrl,
  grokAdapter,
  parseGrokModelList,
  parseGrokPrintResult,
  resolveGrokExecutable,
  runGrokAcpAuthProbe,
  writeManagedGrokConfig,
} from "./grok.js";

const PROFILE = path.join("C:\\profiles", "rp_test");

function makeBaseEnv(overrides = {}) {
  return {
    PATH: "C:\\Windows",
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    USERPROFILE: "C:\\Users\\Real",
    HOME: "C:\\Users\\Real",
    HOMEDRIVE: "C:",
    HOMEPATH: "\\Users\\Real",
    APPDATA: "C:\\Users\\Real\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\Real\\AppData\\Local",
    ...overrides,
  };
}

// Every env var that could change auth method, endpoint, credential source,
// or the external compat/tool surface — must never reach a managed child.
const HOSTILE_ENV = {
  XAI_API_KEY: "xai-secret",
  GROK_API_KEY: "grok-secret",
  GROK_DEPLOYMENT_KEY: "deploy-secret",
  GROK_AUTH_PROVIDER_COMMAND: "corp-auth",
  GROK_AUTH_PROVIDER_LABEL: "Corp",
  GROK_AUTH_TOKEN_TTL: "60",
  GROK_AUTH_EXPIRED: "1",
  GROK_OIDC_ISSUER: "https://okta.example.com",
  GROK_OIDC_CLIENT_ID: "cid",
  GROK_OIDC_AUDIENCE: "aud",
  GROK_OIDC_SCOPES: "openid",
  GROK_OAUTH2_CLIENT_ID: "cid2",
  GROK_OAUTH2_ISSUER: "https://idp.example.com",
  GROK_OAUTH2_PRINCIPAL_ID: "pid",
  GROK_OAUTH2_PRINCIPAL_TYPE: "team",
  GROK_OAUTH2_REFERRER: "ref",
  GROK_OAUTH2_SCOPES: "s",
  GROK_CLI_CHAT_PROXY_BASE_URL: "https://proxy.example.com",
  GROK_MODELS_BASE_URL: "https://models.example.com",
  GROK_MODELS_LIST_URL: "https://list.example.com",
  GROK_XAI_API_BASE_URL: "https://api.example.com",
  GROK_WS_ORIGIN: "https://ws.example.com",
  GROK_WS_URL: "wss://ws.example.com",
  GROK_MANAGED_CONFIG_URL: "https://managed.example.com",
  GROK_FEEDBACK_BASE_URL: "https://fb.example.com",
  GROK_CONFIG: '{"models":{"default":"evil"}}',
  GROK_CONFIG_PATH: "C:\\evil.toml",
  GROK_CLAUDE_MCPS_ENABLED: "true",
  GROK_CLAUDE_HOOKS_ENABLED: "true",
  GROK_CLAUDE_SKILLS_ENABLED: "true",
  GROK_CLAUDE_RULES_ENABLED: "true",
  GROK_CLAUDE_AGENTS_ENABLED: "true",
  GROK_CURSOR_MCPS_ENABLED: "true",
  GROK_CURSOR_HOOKS_ENABLED: "true",
  GROK_CURSOR_SKILLS_ENABLED: "true",
  GROK_CURSOR_RULES_ENABLED: "true",
  GROK_CURSOR_AGENTS_ENABLED: "true",
  GROK_MEMORY: "1",
  GROK_SUBAGENTS: "1",
  GROK_DISABLE_API_KEY_AUTH: "1",
  GROK_FORCE_LOGIN_TEAM_ID: "team-1",
  GROK_SANDBOX: "off",
  GROK_DEFAULT_MODEL: "evil-model",
  GROK_DISABLE_AUTOUPDATER: "0",
  GROK_WEB_FETCH_PROXY: "http://proxy",
  GROK_TRACE_UPLOAD_URL: "https://trace.example.com",
  GROVE_AUTH_TOKEN: "tok",
};

function assertManagedEnv(env) {
  expect(env.GROK_HOME).toBe(PROFILE);
  expect(env.GROK_LEADER_SOCKET).toBe(path.join(PROFILE, "grok-leader.sock"));
  // Home is redirected into the profile so compat scanners, folder trust,
  // and the project-discovery boundary cannot see the host account.
  expect(env.HOME).toBe(path.join(PROFILE, "home"));
  expect(env.USERPROFILE).toBe(path.join(PROFILE, "home"));
  expect(env.APPDATA).toBe(
    path.join(PROFILE, "home", "AppData", "Roaming"),
  );
  expect(env.LOCALAPPDATA).toBe(
    path.join(PROFILE, "home", "AppData", "Local"),
  );
  // The home-resolution fallbacks are stripped — ~ can only resolve via the
  // redirected USERPROFILE/HOME.
  expect(env.HOMEDRIVE).toBeUndefined();
  expect(env.HOMEPATH).toBeUndefined();
  expect(env.PATH).toBe("C:\\Windows");
  for (const key of Object.keys(HOSTILE_ENV)) {
    expect(env[key], `${key} must be stripped`).toBeUndefined();
  }
}

describe("GROK_RUNTIME registry entry", () => {
  it("keeps XAI as the sole supported account provider", () => {
    const def = getRuntimeDefinition("GROK_RUNTIME");
    expect(def.supportedAccountProviders).toEqual(["XAI"]);
    expect(def.runtimeVendor).toBe("XAI");
    expect(def.profile.strategy).toBe("PROFILE_DIR_ENV");
    // The provisional `auth status` command is gone — ACP is the probe.
    expect(def.authProbe.kind).toBe("ACP_STDIO");
    expect(def.authProbe.args).toEqual(["agent", "--no-leader", "stdio"]);
    expect(def.commands.login).toEqual(["login", "--oauth"]);
    expect(def.commands.logout).toEqual(["logout"]);
    expect(def.commands.models).toEqual(["models"]);
  });
});

describe("resolveGrokExecutable", () => {
  it("accepts a real .exe path that exists", () => {
    expect(
      resolveGrokExecutable("C:\\bin\\grok.exe", {
        existsSyncImpl: (p) => p === "C:\\bin\\grok.exe",
      }),
    ).toBe("C:\\bin\\grok.exe");
  });
  it("returns null when the .exe does not exist", () => {
    expect(
      resolveGrokExecutable("C:\\bin\\grok.exe", { existsSyncImpl: () => false }),
    ).toBeNull();
  });
  it("resolves an extensionless PATH shim to the sibling grok.exe", () => {
    expect(
      resolveGrokExecutable("C:\\bin\\grok", {
        existsSyncImpl: (p) => p === path.join("C:\\bin", "grok.exe"),
      }),
    ).toBe(path.join("C:\\bin", "grok.exe"));
  });
});

describe("writeManagedGrokConfig", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a locked-down config: no compat scanners, no auto-update", () => {
    writeManagedGrokConfig(dir);
    const text = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    expect(text).toContain("auto_update = false");
    expect(text).toContain("use_leader = false");
    for (const cell of ["agents", "hooks", "mcps", "rules", "skills"]) {
      expect(text).toContain(`${cell} = false`);
    }
    // Never an API key, auth provider command, or custom endpoint.
    expect(text).not.toMatch(/api_key|auth_provider|oidc|base_url/i);
  });

  it("is idempotent — does not rewrite an identical file", () => {
    writeManagedGrokConfig(dir);
    const target = path.join(dir, "config.toml");
    const before = fs.statSync(target).mtimeMs;
    writeManagedGrokConfig(dir);
    expect(fs.statSync(target).mtimeMs).toBe(before);
  });
});

describe("login / logout invocations", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-inv-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds `grok login --oauth` inside the managed profile env", () => {
    const inv = buildGrokLoginInvocation({
      executablePath: "C:\\bin\\grok.exe",
      profileDir: dir,
      baseEnv: makeBaseEnv(HOSTILE_ENV),
    });
    expect(inv.executable).toBe("C:\\bin\\grok.exe");
    expect(inv.args).toEqual(["login", "--oauth"]);
    expect(inv.cwd).toBe(dir);
    expect(inv.env.GROK_HOME).toBe(dir);
    expect(inv.env.HOME).toBe(path.join(dir, "home"));
    expect(inv.env.USERPROFILE).toBe(path.join(dir, "home"));
    for (const key of Object.keys(HOSTILE_ENV)) {
      expect(inv.env[key], key).toBeUndefined();
    }
    // The managed config exists before the login process starts.
    expect(fs.readFileSync(path.join(dir, "config.toml"), "utf8")).toBe(
      GROK_MANAGED_CONFIG_TOML,
    );
  });

  it("builds `grok logout` in the same managed env", () => {
    const inv = buildGrokLogoutInvocation({
      executablePath: "C:\\bin\\grok.exe",
      profileDir: dir,
      baseEnv: makeBaseEnv(HOSTILE_ENV),
    });
    expect(inv.args).toEqual(["logout"]);
    expect(inv.cwd).toBe(dir);
    expect(inv.env.GROK_HOME).toBe(dir);
  });
});

describe("extractGrokLoginUrl", () => {
  it("extracts the auth.x.ai authorize URL from stderr text", () => {
    const text =
      "Signing in with Grok...\nOpen this URL to sign in:\n" +
      "  https://auth.x.ai/oauth2/authorize?response_type=code&state=abc\n";
    expect(extractGrokLoginUrl(text)).toBe(
      "https://auth.x.ai/oauth2/authorize?response_type=code&state=abc",
    );
  });
  it("accepts the device-flow accounts.x.ai origin", () => {
    expect(
      extractGrokLoginUrl(
        "open https://accounts.x.ai/oauth2/device?user_code=TT8V-DTMB",
      ),
    ).toBe("https://accounts.x.ai/oauth2/device?user_code=TT8V-DTMB");
  });
  it("rejects foreign origins", () => {
    expect(extractGrokLoginUrl("see https://evil.example.com/x")).toBeNull();
    expect(extractGrokLoginUrl("https://x.ai.notxai.com/cb")).toBeNull();
    expect(extractGrokLoginUrl("no url")).toBeNull();
  });
});

describe("classifyGrokAuthMode", () => {
  it("maps the verified personal OAuth mode", () => {
    expect(classifyGrokAuthMode("Oidc")).toBe("XAI_OAUTH_SESSION");
  });
  it("an absent or empty mode fails closed — UNKNOWN, never OAuth", () => {
    expect(classifyGrokAuthMode(null)).toBe("UNKNOWN");
    expect(classifyGrokAuthMode(undefined)).toBe("UNKNOWN");
    expect(classifyGrokAuthMode("")).toBe("UNKNOWN");
  });
  it("maps wrong-credential kinds", () => {
    expect(classifyGrokAuthMode("ApiKey")).toBe("API_KEY");
    expect(classifyGrokAuthMode("DeploymentKey")).toBe("API_KEY");
    expect(classifyGrokAuthMode("External")).toBe("EXTERNAL_AUTH_PROVIDER");
    expect(classifyGrokAuthMode("EnterpriseOidc")).toBe("ENTERPRISE_OIDC");
    expect(classifyGrokAuthMode("somethingElse")).toBe("UNKNOWN");
  });
});

describe("classifyGrokAuthError", () => {
  it("maps ACP auth-required and expiry signals", () => {
    expect(classifyGrokAuthError({ code: -32000 })).toBe("NOT_AUTHENTICATED");
    expect(
      classifyGrokAuthError({ code: -1, message: "token expired" }),
    ).toBe("REAUTH_REQUIRED");
    expect(
      classifyGrokAuthError({ code: -1, message: "unauthorized" }),
    ).toBe("NOT_AUTHENTICATED");
    expect(classifyGrokAuthError({ code: 7, message: "io error" })).toBe(
      "UNKNOWN",
    );
  });
});

// Fake ACP stdio child: records the JSON-RPC requests it receives and emits
// scripted NDJSON responses on stdout. Optional script fields:
//   preAuthenticateFrames — frames emitted right before the authenticate
//     response (e.g. an agent→client request with a colliding id)
//   authenticateSilent    — authenticate gets no response at all
//   earlyClose            — the child closes mid-handshake
function fakeAcpChild(script) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
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
              result: script.initializeResult,
            }) + "\n",
          );
        } else if (msg.method === "authenticate") {
          for (const frame of script.preAuthenticateFrames || []) {
            child.stdout.emit("data", JSON.stringify(frame) + "\n");
          }
          if (script.authenticateSilent) return;
          const response = script.authenticateError
            ? { jsonrpc: "2.0", id: msg.id, error: script.authenticateError }
            : {
                jsonrpc: "2.0",
                id: msg.id,
                result:
                  "authenticateResult" in script
                    ? script.authenticateResult
                    : {},
              };
          child.stdout.emit("data", JSON.stringify(response) + "\n");
        }
      });
      return true;
    },
    end() {},
  };
  child.kill = () => {};
  if (script.earlyClose) {
    setImmediate(() => child.emit("close", 0, null));
  }
  return child;
}

const AUTHED_META = {
  email: "user@example.com",
  auth_mode: "Oidc",
  subscription_tier: "SuperGrok",
  team_name: "Personal",
};

describe("runGrokAcpAuthProbe", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-acp-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const probe = (script, extra = {}) =>
    runGrokAcpAuthProbe({
      executablePath: "C:\\bin\\grok.exe",
      profileDir: dir,
      baseEnv: makeBaseEnv(),
      spawnImpl: () => fakeAcpChild(script),
      terminateImpl: async () => {},
      ...extra,
    });

  it("classifies a cached_token session as AUTHENTICATED XAI_OAUTH_SESSION", async () => {
    const result = await probe({
      initializeResult: {
        authMethods: [
          { id: "grok.com" },
          { id: "cached_token", name: "Existing login" },
        ],
      },
      authenticateResult: { _meta: AUTHED_META },
    });
    expect(result.authState).toBe("AUTHENTICATED");
    expect(result.authKind).toBe("XAI_OAUTH_SESSION");
    expect(result.authMethod).toBe("oauth");
    expect(result.accountIdentity).toBe("user@example.com");
    expect(result.providerMetadata).toEqual({
      authMode: "Oidc",
      subscriptionTier: "SuperGrok",
    });
  });

  it("reports NOT_AUTHENTICATED when cached_token is not advertised", async () => {
    const result = await probe({
      initializeResult: { authMethods: [{ id: "grok.com" }] },
    });
    expect(result.authState).toBe("NOT_AUTHENTICATED");
    expect(result.authKind).toBeNull();
  });

  it("reports NOT_AUTHENTICATED when authMethods is missing entirely", async () => {
    const result = await probe({ initializeResult: {} });
    expect(result.authState).toBe("NOT_AUTHENTICATED");
  });

  it("maps an authenticate error to a session-level state", async () => {
    const result = await probe({
      initializeResult: {
        authMethods: [{ id: "cached_token" }],
      },
      authenticateError: { code: -32000, message: "Auth required" },
    });
    expect(result.authState).toBe("NOT_AUTHENTICATED");
  });

  it("maps an expired session to REAUTH_REQUIRED", async () => {
    const result = await probe({
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      authenticateError: { code: -1, message: "refresh token expired" },
    });
    expect(result.authState).toBe("REAUTH_REQUIRED");
  });

  it("an API-key session kind is preserved for the caller to reject", async () => {
    const result = await probe({
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      authenticateResult: { _meta: { auth_mode: "ApiKey" } },
    });
    expect(result.authState).toBe("AUTHENTICATED");
    expect(result.authKind).toBe("API_KEY");
    expect(result.accountIdentity).toBeNull();
  });

  it("an authenticated reply without auth_mode is AUTHENTICATED but UNKNOWN kind", async () => {
    const result = await probe({
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      authenticateResult: { _meta: { email: "u@x.com" } },
    });
    expect(result.authState).toBe("AUTHENTICATED");
    expect(result.authKind).toBe("UNKNOWN");
  });

  it("ignores an agent→client request that collides with our request id", async () => {
    // ACP agent→client requests (session/request_permission, fs/*) carry
    // agent-side ids — one can legally be `2`, colliding with our
    // authenticate id. It must never be mistaken for the response.
    const result = await probe({
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      preAuthenticateFrames: [
        { jsonrpc: "2.0", id: 2, method: "session/request_permission", params: {} },
      ],
      authenticateResult: { _meta: AUTHED_META },
    });
    expect(result.authState).toBe("AUTHENTICATED");
    expect(result.authKind).toBe("XAI_OAUTH_SESSION");
  });

  it("a request frame alone never yields AUTHENTICATED", async () => {
    const result = await probe(
      {
        initializeResult: { authMethods: [{ id: "cached_token" }] },
        preAuthenticateFrames: [
          { jsonrpc: "2.0", id: 2, method: "fs/read_text_file", params: {} },
        ],
        authenticateSilent: true,
      },
      { timeoutMs: 60 },
    );
    expect(result.authState).toBe("UNKNOWN");
  });

  it("a response before authenticate is sent is ignored", async () => {
    const result = await probe(
      {
        initializeResult: { authMethods: [{ id: "grok.com" }] },
      },
      {
        // Emit an unsolicited {id:2, result:...} right after initialize —
        // nothing outstanding has id 2, so it must not authenticate.
        spawnImpl: (cmd, args, opts) => {
          const child = fakeAcpChild({
            initializeResult: { authMethods: [{ id: "grok.com" }] },
          });
          const orig = child.stdin.write.bind(child.stdin);
          child.stdin.write = (data) => {
            if (JSON.parse(data.trim()).method === "initialize") {
              setImmediate(() =>
                child.stdout.emit(
                  "data",
                  JSON.stringify({ jsonrpc: "2.0", id: 2, result: {} }) + "\n",
                ),
              );
            }
            return orig(data);
          };
          return child;
        },
      },
    );
    expect(result.authState).toBe("NOT_AUTHENTICATED");
  });

  it("a non-object authenticate result is UNKNOWN, not authenticated", async () => {
    const result = await probe({
      initializeResult: { authMethods: [{ id: "cached_token" }] },
      authenticateResult: null,
    });
    expect(result.authState).toBe("UNKNOWN");
  });

  it("an early close mid-handshake is UNKNOWN", async () => {
    const result = await probe({ earlyClose: true, initializeResult: {} });
    expect(result.authState).toBe("UNKNOWN");
  });

  it("terminates the child and closes stdin on every outcome", async () => {
    const terminate = vi.fn(async () => {});
    const child = fakeAcpChild({
      initializeResult: { authMethods: [{ id: "grok.com" }] },
    });
    const endSpy = vi.spyOn(child.stdin, "end");
    await probe(
      { initializeResult: { authMethods: [{ id: "grok.com" }] } },
      { spawnImpl: () => child, terminateImpl: terminate },
    );
    expect(endSpy).toHaveBeenCalled();
    expect(terminate).toHaveBeenCalledWith(child);
  });

  it("an aborted signal ends the probe as UNKNOWN", async () => {
    const controller = new AbortController();
    const child = fakeAcpChild({
      initializeResult: { authMethods: [{ id: "grok.com" }] },
    });
    const pending = runGrokAcpAuthProbe({
      executablePath: "C:\\bin\\grok.exe",
      profileDir: dir,
      baseEnv: makeBaseEnv(),
      spawnImpl: () => child,
      terminateImpl: async () => {},
      signal: controller.signal,
      timeoutMs: 5_000,
    });
    controller.abort();
    const result = await pending;
    expect(result.authState).toBe("UNKNOWN");
  });

  it("times out as UNKNOWN when the agent never answers", async () => {
    const silent = new EventEmitter();
    silent.stdout = new EventEmitter();
    silent.stderr = new EventEmitter();
    silent.stdin = { write: () => true, end: () => {} };
    silent.kill = () => {};
    const result = await probe(
      { initializeResult: {} },
      { spawnImpl: () => silent, timeoutMs: 30 },
    );
    expect(result.authState).toBe("UNKNOWN");
  });

  it("treats a non-JSON line on stdout as UNKNOWN", async () => {
    const noisy = new EventEmitter();
    noisy.stdout = new EventEmitter();
    noisy.stderr = new EventEmitter();
    noisy.stdin = {
      write: () => {
        setImmediate(() => noisy.stdout.emit("data", "hello\n"));
        return true;
      },
      end: () => {},
    };
    noisy.kill = () => {};
    const result = await probe(
      { initializeResult: {} },
      { spawnImpl: () => noisy },
    );
    expect(result.authState).toBe("UNKNOWN");
  });

  it("spawns with the managed env, --no-leader, and shell:false", async () => {
    let captured;
    const script = {
      initializeResult: { authMethods: [{ id: "grok.com" }] },
    };
    await probe(script, {
      spawnImpl: (cmd, args, opts) => {
        captured = { cmd, args, opts };
        return fakeAcpChild(script);
      },
    });
    expect(captured.cmd).toBe("C:\\bin\\grok.exe");
    expect(captured.args).toEqual(["agent", "--no-leader", "stdio"]);
    expect(captured.opts.shell).toBe(false);
    expect(captured.opts.env.GROK_HOME).toBe(dir);
    expect(captured.opts.env.USERPROFILE).toBe(path.join(dir, "home"));
  });
});

describe("parseGrokModelList", () => {
  const AUTHED = [
    "You are logged in with grok.com.",
    "",
    "Default model: grok-4.7",
    "",
    "Available models:",
    "  * grok-4.7 (default)",
    "  - grok-4.7-build-fast",
    "  - grok-4.6",
    "  - grok-4.5",
    "",
  ].join("\n");

  const UNAUTHED = [
    "You are not authenticated.",
    "",
    "Default model: grok-4.6",
    "",
    "Available models:",
    "  * grok-4.6 (default)",
    "  - grok-4.5",
    "",
  ].join("\n");

  it("parses the authenticated catalog with its default", () => {
    const parsed = parseGrokModelList(AUTHED);
    expect(parsed.authenticated).toBe(true);
    expect(parsed.defaultModel).toBe("grok-4.7");
    expect(parsed.models.map((m) => m.id)).toEqual([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.6",
      "grok-4.5",
    ]);
  });

  it("recognizes the unauthenticated bundled list as unauthenticated", () => {
    const parsed = parseGrokModelList(UNAUTHED);
    expect(parsed.authenticated).toBe(false);
    expect(parsed.models.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);
  });

  it("returns null on output that does not match the documented shape", () => {
    expect(parseGrokModelList("boom")).toBeNull();
    expect(parseGrokModelList("")).toBeNull();
    expect(parseGrokModelList("Available models:\nnot-a-model-line")).toBeNull();
  });
});

describe("listModels", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-models-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const run = (runner) =>
    grokAdapter.listModels({
      executablePath: "C:\\bin\\grok.exe",
      profileDir: dir,
      baseEnv: makeBaseEnv(HOSTILE_ENV),
      runner,
    });

  it("returns the runtime catalog when authenticated", async () => {
    const result = await run(async (inv) => {
      expect(inv.args).toEqual(["models"]);
      expect(inv.env.GROK_HOME).toBe(dir);
      for (const key of Object.keys(HOSTILE_ENV)) {
        expect(inv.env[key], key).toBeUndefined();
      }
      return {
        exitCode: 0,
        stdout:
          "You are logged in with grok.com.\n\nDefault model: grok-4.7\n\nAvailable models:\n  * grok-4.7 (default)\n  - grok-4.6\n",
        stderr: "",
      };
    });
    expect(result.dynamicDiscoverySupported).toBe(true);
    expect(result.models.map((m) => m.id)).toEqual(["grok-4.7", "grok-4.6"]);
    expect(result.models[0].source).toBe("RUNTIME");
  });

  it("fails discovery rather than returning the bundled fallback", async () => {
    const result = await run(async () => ({
      exitCode: 0,
      stdout:
        "You are not authenticated.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n",
      stderr: "",
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MODEL_DISCOVERY_UNAVAILABLE");
  });

  it("fails discovery on nonzero exit", async () => {
    const result = await run(async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
    }));
    expect(result.ok).toBe(false);
    expect(result.code).toBe("MODEL_DISCOVERY_UNAVAILABLE");
  });
});

describe("buildSmokeInvocation", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-smoke-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("builds a minimal-permission headless run in the managed env", () => {
    const workDir = path.join(dir, "work");
    const inv = grokAdapter.buildSmokeInvocation({
      executablePath: "C:\\bin\\grok.exe",
      profileDir: dir,
      baseEnv: makeBaseEnv(HOSTILE_ENV),
      workingDirectory: workDir,
      model: "grok-4.7",
    });
    expect(inv.executable).toBe("C:\\bin\\grok.exe");
    expect(inv.cwd).toBe(workDir);
    expect(inv.args[0]).toBe("-p");
    expect(inv.args[1]).toBe("Reply with exactly: VOCATRYA_GROK_OK");
    for (const flag of [
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
    ]) {
      expect(inv.args).toContain(flag);
    }
    // Empty allowlist — no built-in tools.
    expect(inv.args[inv.args.indexOf("--tools") + 1]).toBe("");
    // Deny rules gate every permission-bearing tool class.
    const denies = inv.args.filter((_, i) => inv.args[i - 1] === "--deny");
    expect(denies).toEqual(
      expect.arrayContaining([
        "Bash",
        "Read",
        "Edit",
        "Write",
        "Grep",
        "WebFetch",
        "MCPTool",
      ]),
    );
    // Never auto-approve anything.
    expect(inv.args.join(" ")).not.toMatch(/always-approve|yolo/);
    expect(inv.env.GROK_HOME).toBe(dir);
    for (const key of Object.keys(HOSTILE_ENV)) {
      expect(inv.env[key], key).toBeUndefined();
    }
  });
});

describe("parseGrokPrintResult", () => {
  it("extracts text from the JSON envelope", () => {
    const parsed = parseGrokPrintResult({
      stdout: JSON.stringify({
        text: "VOCATRYA_GROK_OK",
        stopReason: "end_turn",
        sessionId: "s1",
        requestId: "r1",
        usage: { input_tokens: 1 },
      }),
      stderr: "",
    });
    expect(parsed.text).toBe("VOCATRYA_GROK_OK");
    expect(parsed.reportedError).toBe(false);
  });

  it("flags error envelopes", () => {
    const parsed = parseGrokPrintResult({
      stdout: JSON.stringify({ error: "rate limited", stopReason: "error" }),
      stderr: "",
    });
    expect(parsed.reportedError).toBe(true);
  });

  it("falls back to the last non-empty line", () => {
    const parsed = parseGrokPrintResult({
      stdout: "noise\nVOCATRYA_GROK_OK\n",
      stderr: "",
    });
    expect(parsed.text).toBe("VOCATRYA_GROK_OK");
  });
});

describe("adapter contract", () => {
  it("accepts only XAI as the account provider", () => {
    expect(grokAdapter.forAccountProvider("XAI")).toBe(grokAdapter);
    expect(grokAdapter.forAccountProvider(null)).toBe(grokAdapter);
    expect(grokAdapter.forAccountProvider("OPENAI")).toBeNull();
    expect(grokAdapter.forAccountProvider("ANTHROPIC")).toBeNull();
  });

  it("maps probe outcomes onto login failure codes", () => {
    expect(
      grokAdapter.loginFailureCode({
        authState: "AUTHENTICATED",
        authKind: "XAI_OAUTH_SESSION",
      }),
    ).toBeNull();
    expect(
      grokAdapter.loginFailureCode({ authState: "NOT_AUTHENTICATED" }),
    ).toBe("AUTH_NOT_CONFIRMED");
    expect(
      grokAdapter.loginFailureCode({
        authState: "AUTHENTICATED",
        authKind: "API_KEY",
      }),
    ).toBe("UNSUPPORTED_AUTH_METHOD");
    expect(
      grokAdapter.loginFailureCode({
        authState: "AUTHENTICATED",
        authKind: "UNKNOWN",
      }),
    ).toBe("AUTH_METHOD_UNVERIFIED");
  });

  it("never reports a non-OAuth session as CONNECTED", () => {
    expect(
      grokAdapter.reportableAuthState({
        authState: "AUTHENTICATED",
        authKind: "API_KEY",
      }),
    ).toBe("UNKNOWN");
    expect(
      grokAdapter.reportableAuthState({
        authState: "AUTHENTICATED",
        authKind: "XAI_OAUTH_SESSION",
      }),
    ).toBe("AUTHENTICATED");
    expect(
      grokAdapter.reportableAuthState({ authState: "REAUTH_REQUIRED" }),
    ).toBe("REAUTH_REQUIRED");
  });
});

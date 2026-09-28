// OpenCode adapter unit tests — Zen/Go-parameterized adapter, strict
// auth-list parsing, vendor API-key classification, XDG env, the visible-
// console login launch, model discovery, and the locked-down smoke
// invocation. No real CLI is spawned.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import opencode from "./opencode.js";

const {
  OPENCODE_ACCOUNT_PROVIDERS,
  OPENCODE_SMOKE_CONFIG,
  classifyAuthListEntry,
  opencodeAdapter,
  parseOpencodeAuthList,
  parseOpencodeAuthStatus,
  parseOpencodeModels,
  resolveOpencodeExecutable,
  stripAnsi,
} = opencode;

const PROFILE_DIR = "C:\\Managed\\runtime-profiles\\rp_11111111-2222-3333-4444-555555555555";
const ESC = "\x1b";

function authList(entries, { credentialsLabel = `${PROFILE_DIR}\\data\\opencode\\auth.json` } = {}) {
  const lines = [
    `T  Credentials ${ESC}[90m${credentialsLabel}${ESC}[39m`,
    "|",
  ];
  for (const { name, type } of entries) {
    lines.push(`${ESC}[34m•${ESC}[39m  ${name} ${ESC}[90m${type}${ESC}[39m`, "|");
  }
  lines.push(`${ESC}[90m—${ESC}[39m  ${entries.length} credentials`, "");
  return lines.join("\n");
}

const GO_CFG = OPENCODE_ACCOUNT_PROVIDERS.OPENCODE_GO;
const ZEN_CFG = OPENCODE_ACCOUNT_PROVIDERS.OPENCODE_ZEN;

describe("opencode adapter binding", () => {
  it("binds OPENCODE_GO and OPENCODE_ZEN — the runtime's own products", () => {
    const go = opencodeAdapter.forAccountProvider("OPENCODE_GO");
    expect(go).not.toBeNull();
    expect(go.backendKind).toBe("OPENCODE_RUNTIME");
    expect(go.accountProvider).toBe("OPENCODE_GO");
    const zen = opencodeAdapter.forAccountProvider("OPENCODE_ZEN");
    expect(zen).not.toBeNull();
    expect(zen.accountProvider).toBe("OPENCODE_ZEN");
  });

  it("refuses ChatGPT-via-OpenCode and every other provider", () => {
    // "Connect ChatGPT via OpenCode" was removed product semantics — an
    // OPENAI provider must never bind on this runtime again. GitHub
    // Copilot stays a declared capability but is unimplemented.
    for (const provider of [
      "OPENAI",
      "GITHUB_COPILOT",
      "OPENCODE",
      "ANTHROPIC",
      "opencode-go",
      null,
      undefined,
    ]) {
      expect(opencodeAdapter.forAccountProvider(provider)).toBeNull();
    }
  });
});

describe("resolveOpencodeExecutable", () => {
  it("returns a real .exe path as-is", () => {
    const exe = "C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe";
    expect(
      resolveOpencodeExecutable(exe, { existsSyncImpl: (p) => p === exe }),
    ).toBe(exe);
  });

  it("unwraps the npm .cmd shim to the vendored opencode.exe", () => {
    const npmRoot = "C:\\Users\\u\\AppData\\Roaming\\npm";
    const pkgRoot = `${npmRoot}\\node_modules\\opencode-ai`;
    const shim = `${npmRoot}\\opencode.cmd`;
    const real = `${pkgRoot}\\bin\\opencode.exe`;
    const plat = `${pkgRoot}\\node_modules\\opencode-windows-x64\\bin\\opencode.exe`;
    const dirs = {
      [pkgRoot]: ["bin", "node_modules"],
      [`${pkgRoot}\\bin`]: ["opencode.exe"],
      [`${pkgRoot}\\node_modules`]: ["opencode-windows-x64"],
      [`${pkgRoot}\\node_modules\\opencode-windows-x64`]: ["bin"],
      [`${pkgRoot}\\node_modules\\opencode-windows-x64\\bin`]: [
        "opencode.exe",
      ],
    };
    const resolved = resolveOpencodeExecutable(shim, {
      existsSyncImpl: (p) => p === real || p === plat || p === shim,
      readdirSyncImpl: (dir) =>
        (dirs[dir] || []).map((name) => ({
          name,
          isDirectory: () => !name.endsWith(".exe"),
        })),
    });
    expect(resolved).toBe(real);
  });

  it("returns null when nothing resolves", () => {
    expect(
      resolveOpencodeExecutable(null, { existsSyncImpl: () => false }),
    ).toBeNull();
    expect(
      resolveOpencodeExecutable("C:\\npm\\opencode.cmd", {
        existsSyncImpl: () => false,
        readdirSyncImpl: () => [],
      }),
    ).toBeNull();
  });
});

describe("auth list parsing", () => {
  it("strips ANSI decoration and parses entries + footer", () => {
    const parsed = parseOpencodeAuthList(
      authList([
        { name: "OpenAI", type: "oauth" },
        { name: "OpenCode Go", type: "api" },
      ]),
    );
    expect(parsed.entries).toEqual([
      { name: "OpenAI", normalizedName: "openai", type: "oauth" },
      { name: "OpenCode Go", normalizedName: "opencodego", type: "api" },
    ]);
  });

  it("parses an empty credential list", () => {
    const parsed = parseOpencodeAuthList(authList([]));
    expect(parsed.entries).toEqual([]);
  });

  it("accepts parenthesized type labels", () => {
    const parsed = parseOpencodeAuthList(
      `T  Credentials x\n|\n•  OpenCode Zen (api)\n|\n—  1 credentials\n`,
    );
    expect(parsed.entries[0]).toMatchObject({
      normalizedName: "opencodezen",
      type: "api",
    });
  });

  it("returns null for output that is not an auth listing", () => {
    expect(parseOpencodeAuthList("")).toBeNull();
    expect(parseOpencodeAuthList("completely unrelated output")).toBeNull();
    expect(parseOpencodeAuthList(null)).toBeNull();
  });
});

describe("auth classification", () => {
  const parseGo = (stdout) =>
    parseOpencodeAuthStatus(GO_CFG, { exitCode: 0, stdout, stderr: "" });
  const parseZen = (stdout) =>
    parseOpencodeAuthStatus(ZEN_CFG, { exitCode: 0, stdout, stderr: "" });

  it("classifies an OpenCode Go api entry as OPENCODE_GO_API_KEY", () => {
    const status = parseGo(authList([{ name: "OpenCode Go", type: "api" }]));
    expect(status).toMatchObject({
      authState: "AUTHENTICATED",
      authKind: "OPENCODE_GO_API_KEY",
      authMethod: "api",
      accountIdentity: null,
    });
    expect(status.providerMetadata).toMatchObject({ product: "OpenCode Go" });
  });

  it("classifies an OpenCode Zen api entry as OPENCODE_ZEN_API_KEY", () => {
    const status = parseZen(
      authList([{ name: "OpenCode Zen", type: "api" }]),
    );
    expect(status).toMatchObject({
      authState: "AUTHENTICATED",
      authKind: "OPENCODE_ZEN_API_KEY",
      authMethod: "api",
      accountIdentity: null,
    });
    expect(status.providerMetadata).toMatchObject({ product: "OpenCode Zen" });
  });

  it("Zen also accepts the legacy 'opencode' entry name", () => {
    const status = parseZen(authList([{ name: "opencode", type: "api" }]));
    expect(status.authKind).toBe("OPENCODE_ZEN_API_KEY");
  });

  it("Go and Zen never satisfy each other's probe", () => {
    expect(
      parseGo(authList([{ name: "OpenCode Zen", type: "api" }])).authState,
    ).toBe("NOT_AUTHENTICATED");
    expect(
      parseZen(authList([{ name: "OpenCode Go", type: "api" }])).authState,
    ).toBe("NOT_AUTHENTICATED");
  });

  it("reports NOT_AUTHENTICATED when only foreign credentials exist", () => {
    const status = parseGo(
      authList([
        { name: "GitHub Copilot", type: "oauth" },
        { name: "OpenAI", type: "oauth" },
      ]),
    );
    expect(status.authState).toBe("NOT_AUTHENTICATED");
  });

  it("reports NOT_AUTHENTICATED on an empty list", () => {
    expect(parseGo(authList([])).authState).toBe("NOT_AUTHENTICATED");
  });

  it("a non-api entry for the bound provider is unclassifiable", () => {
    const status = parseGo(
      authList([{ name: "OpenCode Go", type: "oauth" }]),
    );
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.authKind).toBe("UNKNOWN");
  });

  it("reports UNKNOWN for unparseable output — exit 0 is never enough", () => {
    expect(parseGo("Login succeeded!").authState).toBe("UNKNOWN");
  });

  it("classifies foreign entries for diagnostics", () => {
    expect(
      classifyAuthListEntry({ normalizedName: "githubcopilot", type: "oauth" }),
    ).toBe("GITHUB_COPILOT_OAUTH");
    expect(
      classifyAuthListEntry({ normalizedName: "opencodezen", type: "api" }),
    ).toBe("OPENCODE_ZEN_API_KEY");
    expect(
      classifyAuthListEntry({ normalizedName: "opencodego", type: "api" }),
    ).toBe("OPENCODE_GO_API_KEY");
    expect(
      classifyAuthListEntry({ normalizedName: "anthropic", type: "api" }),
    ).toBe("OTHER_API_KEY");
  });
});

describe("login invocation", () => {
  const goAdapter = opencodeAdapter.forAccountProvider("OPENCODE_GO");
  const zenAdapter = opencodeAdapter.forAccountProvider("OPENCODE_ZEN");

  it("launches the vendor TUI inside a real console window for Go", () => {
    const inv = goAdapter.buildLoginInvocation({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv: {},
    });
    // Same mechanism as the Devin login: `auth login` reads console input
    // (method selection + API-key entry), never pipes.
    expect(inv.executable).toBe("cmd.exe");
    expect(inv.args.slice(0, 5)).toEqual(["/d", "/c", "start", "", "/wait"]);
    expect(inv.args[5]).toBe("C:\\bin\\opencode.exe");
    const head = inv.args.slice(6).join(" ");
    expect(head).toBe("auth login --pure -p opencode-go");
    // No OAuth method/URL semantics — no browser passthrough either.
    expect(head).not.toMatch(/-m|oauth|ChatGPT|api.?key/i);
    expect(inv.cwd).toBe(PROFILE_DIR);
  });

  it("pins -p opencode for the Zen login", () => {
    const inv = zenAdapter.buildLoginInvocation({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv: {},
    });
    expect(inv.args.slice(6).join(" ")).toBe(
      "auth login --pure -p opencode",
    );
  });

  it("builds logout + status invocations inside the managed XDG env", () => {
    const baseEnv = { PATH: "C:\\Windows", OPENAI_API_KEY: "sk-ambient" };
    const logout = goAdapter.buildLogoutInvocation({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
    });
    expect(logout.args.join(" ")).toBe("auth logout opencode-go");
    const zenLogout = zenAdapter.buildLogoutInvocation({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
    });
    expect(zenLogout.args.join(" ")).toBe("auth logout opencode");
    const status = goAdapter.buildStatusInvocation({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
    });
    expect(status.args.join(" ")).toBe("auth list");
    for (const inv of [logout, zenLogout, status]) {
      expect(inv.env.XDG_DATA_HOME).toBe(`${PROFILE_DIR}\\data`);
      expect(inv.env.XDG_CONFIG_HOME).toBe(`${PROFILE_DIR}\\config`);
      expect(inv.env.XDG_CACHE_HOME).toBe(`${PROFILE_DIR}\\cache`);
      expect(inv.env.XDG_STATE_HOME).toBe(`${PROFILE_DIR}\\state`);
      expect(inv.env.OPENAI_API_KEY).toBeUndefined();
    }
  });

  it("no authorize-URL surface exists — login is the vendor's own TUI", () => {
    expect(goAdapter.extractLoginUrl).toBeUndefined();
    expect(zenAdapter.extractLoginUrl).toBeUndefined();
  });

  it("accepts only the bound provider's vendor API-key credential", () => {
    for (const [adapter, kind] of [
      [goAdapter, "OPENCODE_GO_API_KEY"],
      [zenAdapter, "OPENCODE_ZEN_API_KEY"],
    ]) {
      expect(
        adapter.loginFailureCode({ authState: "AUTHENTICATED", authKind: kind }),
      ).toBeNull();
      expect(
        adapter.loginFailureCode({ authState: "AUTHENTICATED", authKind: "OPENAI_API_KEY" }),
      ).toBe("UNSUPPORTED_AUTH_METHOD");
      expect(
        adapter.loginFailureCode({ authState: "AUTHENTICATED", authKind: "UNKNOWN" }),
      ).toBe("AUTH_METHOD_UNVERIFIED");
      expect(
        adapter.loginFailureCode({ authState: "NOT_AUTHENTICATED" }),
      ).toBe("AUTH_NOT_CONFIRMED");
    }
    // Cross-product credentials are the wrong account for the connection.
    expect(
      goAdapter.loginFailureCode({
        authState: "AUTHENTICATED",
        authKind: "OPENCODE_ZEN_API_KEY",
      }),
    ).toBe("UNSUPPORTED_AUTH_METHOD");
  });

  it("never reports a foreign credential as AUTHENTICATED", () => {
    expect(
      goAdapter.reportableAuthState({
        authState: "AUTHENTICATED",
        authKind: "OPENAI_CHATGPT_OAUTH",
      }),
    ).toBe("UNKNOWN");
    expect(
      goAdapter.reportableAuthState({
        authState: "AUTHENTICATED",
        authKind: "OPENCODE_GO_API_KEY",
      }),
    ).toBe("AUTHENTICATED");
  });
});

describe("model discovery", () => {
  it("parses only provider/model lines for the bound provider", () => {
    const models = parseOpencodeModels(
      "opencode-go/kimi-k2.5\nopencode-go/glm-5\nopenai/gpt-5.5\nGarbage line\nopencode/minimax-m2.5\n",
      "opencode-go",
    );
    expect(models).toEqual([
      { id: "opencode-go/kimi-k2.5", displayName: "kimi-k2.5" },
      { id: "opencode-go/glm-5", displayName: "glm-5" },
    ]);
  });
});

describe("smoke invocation", () => {
  const adapter = opencodeAdapter.forAccountProvider("OPENCODE_GO");
  let profileDir;

  beforeAll(() => {
    profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-oc-profile-"));
  });
  afterAll(() => {
    fs.rmSync(profileDir, { recursive: true, force: true });
  });

  it("writes a deny-all managed config and builds a pure, --auto-free run", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-oc-work-"));
    try {
      const inv = adapter.buildSmokeInvocation({
        executablePath: "C:\\bin\\opencode.exe",
        profileDir,
        baseEnv: { PATH: "C:\\Windows", GITHUB_TOKEN: "ghp_x" },
        workingDirectory: workDir,
        model: "opencode-go/kimi-k2.5",
      });
      // Managed config lives inside the profile's config root.
      const configPath = path.join(
        profileDir,
        "config",
        "opencode",
        "opencode.json",
      );
      const written = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(written).toMatchObject({
        permission: { "*": "deny" },
        plugin: [],
        mcp: {},
        share: "disabled",
      });
      expect(written).toEqual(
        expect.objectContaining(OPENCODE_SMOKE_CONFIG),
      );
      // The invocation: run --pure --format json -m <model> <prompt>;
      // cwd is the temp work dir; env is the managed XDG set.
      expect(inv.args[0]).toBe("run");
      expect(inv.args).toContain("--pure");
      expect(inv.args).toContain("--format");
      expect(inv.args).not.toContain("--auto");
      expect(inv.args).not.toContain("--yolo");
      expect(inv.args.slice(-1)[0]).toBe(
        "Reply with exactly: VOCATRYA_OPENCODE_OK",
      );
      expect(inv.cwd).toBe(workDir);
      expect(inv.env.XDG_DATA_HOME).toBe(`${profileDir}\\data`);
      expect(inv.env.GITHUB_TOKEN).toBeUndefined();
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("normalizes bare model ids and refuses foreign provider routes", async () => {
    const resolved = await adapter.resolveSmokeModel({ model: "kimi-k2.5" });
    expect(resolved).toEqual({ model: "opencode-go/kimi-k2.5" });
    const prefixed = await adapter.resolveSmokeModel({
      model: "opencode-go/kimi-k2.5",
    });
    expect(prefixed).toEqual({ model: "opencode-go/kimi-k2.5" });
    const foreign = await adapter.resolveSmokeModel({
      model: "opencode/minimax-m2.5",
    });
    expect(foreign).toEqual({ error: "MODEL_UNAVAILABLE" });
  });

  it("falls back to runtime discovery when no model is given", async () => {
    const runner = async ({ args }) =>
      args.join(" ") === "models opencode-go"
        ? { exitCode: 0, stdout: "opencode-go/kimi-k2.5\nopencode-go/glm-5\n" }
        : { exitCode: 0, stdout: "" };
    const resolved = await adapter.resolveSmokeModel({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv: {},
      runner,
      model: undefined,
    });
    expect(resolved).toEqual({ model: "opencode-go/kimi-k2.5" });
  });

  it("extracts the final assistant text from JSONL events", () => {
    const stdout = [
      JSON.stringify({ type: "step_start" }),
      JSON.stringify({ type: "text", part: { text: "VOCATRYA_" } }),
      JSON.stringify({ type: "text", part: { text: "VOCATRYA_OPENCODE_OK" } }),
    ].join("\n");
    const { text, reportedError } = adapter.extractSmokeText({
      result: { exitCode: 0, stdout, stderr: "" },
    });
    expect(text).toBe("VOCATRYA_OPENCODE_OK");
    expect(reportedError).toBe(false);
    const { reportedError: err } = adapter.extractSmokeText({
      result: {
        exitCode: 1,
        stdout: JSON.stringify({ type: "error", error: { message: "x" } }),
        stderr: "",
      },
    });
    expect(err).toBe(true);
  });
});

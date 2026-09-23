// Phase F1 OpenCode adapter unit tests — provider-parameterized adapter,
// strict auth-list parsing, OAuth/API-key classification, XDG env, model
// discovery, and the locked-down smoke invocation. No real CLI is spawned.
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

const OPENAI_CFG = OPENCODE_ACCOUNT_PROVIDERS.OPENAI;

describe("opencode adapter binding", () => {
  it("binds OPENAI; unimplemented/unknown providers bind to null", () => {
    const bound = opencodeAdapter.forAccountProvider("OPENAI");
    expect(bound).not.toBeNull();
    expect(bound.backendKind).toBe("OPENCODE_RUNTIME");
    expect(bound.accountProvider).toBe("OPENAI");
    // GitHub Copilot through OpenCode is a declared capability but is not
    // implemented in this phase — binding refuses it.
    for (const provider of [
      "GITHUB_COPILOT",
      "OPENCODE",
      "ANTHROPIC",
      "openai",
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
      `T  Credentials x\n|\n•  OpenAI (oauth)\n|\n—  1 credentials\n`,
    );
    expect(parsed.entries[0]).toMatchObject({
      normalizedName: "openai",
      type: "oauth",
    });
  });

  it("returns null for output that is not an auth listing", () => {
    expect(parseOpencodeAuthList("")).toBeNull();
    expect(parseOpencodeAuthList("completely unrelated output")).toBeNull();
    expect(parseOpencodeAuthList(null)).toBeNull();
  });
});

describe("auth classification", () => {
  const parse = (stdout) =>
    parseOpencodeAuthStatus(OPENAI_CFG, { exitCode: 0, stdout, stderr: "" });

  it("classifies an OpenAI oauth entry as OPENAI_CHATGPT_OAUTH", () => {
    const status = parse(authList([{ name: "OpenAI", type: "oauth" }]));
    expect(status).toMatchObject({
      authState: "AUTHENTICATED",
      authKind: "OPENAI_CHATGPT_OAUTH",
      authMethod: "oauth",
      accountIdentity: null,
    });
  });

  it("classifies an OpenAI api entry as OPENAI_API_KEY", () => {
    const status = parse(authList([{ name: "OpenAI", type: "api" }]));
    expect(status.authKind).toBe("OPENAI_API_KEY");
  });

  it("classifies OpenAI wellknown/other types as UNKNOWN kind", () => {
    const status = parse(authList([{ name: "OpenAI", type: "wellknown" }]));
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.authKind).toBe("UNKNOWN");
  });

  it("reports NOT_AUTHENTICATED when only foreign credentials exist", () => {
    const status = parse(
      authList([
        { name: "GitHub Copilot", type: "oauth" },
        { name: "OpenCode Zen", type: "api" },
      ]),
    );
    expect(status.authState).toBe("NOT_AUTHENTICATED");
  });

  it("reports NOT_AUTHENTICATED on an empty list", () => {
    expect(parse(authList([])).authState).toBe("NOT_AUTHENTICATED");
  });

  it("reports UNKNOWN for unparseable output — exit 0 is never enough", () => {
    expect(parse("Login succeeded!").authState).toBe("UNKNOWN");
  });

  it("classifies foreign entries for diagnostics", () => {
    expect(
      classifyAuthListEntry({ normalizedName: "githubcopilot", type: "oauth" }),
    ).toBe("GITHUB_COPILOT_OAUTH");
    expect(
      classifyAuthListEntry({ normalizedName: "opencodezen", type: "api" }),
    ).toBe("ZEN_API_KEY");
    expect(
      classifyAuthListEntry({ normalizedName: "anthropic", type: "api" }),
    ).toBe("OTHER_API_KEY");
  });
});

describe("login invocation", () => {
  const adapter = opencodeAdapter.forAccountProvider("OPENAI");

  it("pins the OpenAI OAuth method non-interactively — never the API key", () => {
    const inv = adapter.buildLoginInvocation({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv: {},
    });
    const head = inv.args.join(" ");
    expect(head).toContain("auth login");
    expect(head).toContain("-p openai");
    expect(head).toContain(`-m ${OPENAI_CFG.loginMethodLabel}`);
    expect(head).toContain("--pure");
    // An API-key method label must never appear.
    expect(head).not.toMatch(/api.?key/i);
    expect(inv.cwd).toBe(PROFILE_DIR);
  });

  it("builds logout + status invocations inside the managed XDG env", () => {
    const baseEnv = { PATH: "C:\\Windows", OPENAI_API_KEY: "sk-ambient" };
    const logout = adapter.buildLogoutInvocation({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
    });
    expect(logout.args.join(" ")).toBe("auth logout openai");
    const status = adapter.buildStatusInvocation({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
    });
    expect(status.args.join(" ")).toBe("auth list");
    for (const inv of [logout, status]) {
      expect(inv.env.XDG_DATA_HOME).toBe(`${PROFILE_DIR}\\data`);
      expect(inv.env.XDG_CONFIG_HOME).toBe(`${PROFILE_DIR}\\config`);
      expect(inv.env.XDG_CACHE_HOME).toBe(`${PROFILE_DIR}\\cache`);
      expect(inv.env.XDG_STATE_HOME).toBe(`${PROFILE_DIR}\\state`);
      expect(inv.env.OPENAI_API_KEY).toBeUndefined();
    }
  });

  it("extracts only the vendor authorize URL from login stdout", () => {
    const text = `Add credential\n\nGo to: https://auth.openai.com/oauth/authorize?originator=opencode${ESC}[90m\n`;
    expect(adapter.extractLoginUrl(text)).toBe(
      "https://auth.openai.com/oauth/authorize?originator=opencode",
    );
    expect(adapter.extractLoginUrl("https://evil.example.com/x")).toBeNull();
    expect(adapter.extractLoginUrl("no url here")).toBeNull();
  });

  it("accepts only the OAuth classification for login completion", () => {
    expect(
      adapter.loginFailureCode({ authState: "AUTHENTICATED", authKind: "OPENAI_CHATGPT_OAUTH" }),
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
  });

  it("never reports a non-OAuth session as AUTHENTICATED", () => {
    expect(
      adapter.reportableAuthState({
        authState: "AUTHENTICATED",
        authKind: "OPENAI_API_KEY",
      }),
    ).toBe("UNKNOWN");
    expect(
      adapter.reportableAuthState({
        authState: "AUTHENTICATED",
        authKind: "OPENAI_CHATGPT_OAUTH",
      }),
    ).toBe("AUTHENTICATED");
  });
});

describe("model discovery", () => {
  it("parses only provider/model lines for the bound provider", () => {
    const models = parseOpencodeModels(
      "opencode/big-pickle\nopenai/gpt-5.5\nopenai/codex-mini-latest\nGarbage line\nanthropic/claude-sonnet\n",
      "openai",
    );
    expect(models).toEqual([
      { id: "openai/gpt-5.5", displayName: "gpt-5.5" },
      { id: "openai/codex-mini-latest", displayName: "codex-mini-latest" },
    ]);
  });
});

describe("smoke invocation", () => {
  const adapter = opencodeAdapter.forAccountProvider("OPENAI");
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
        model: "openai/gpt-5.5",
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
    const resolved = await adapter.resolveSmokeModel({ model: "gpt-5.5" });
    expect(resolved).toEqual({ model: "openai/gpt-5.5" });
    const prefixed = await adapter.resolveSmokeModel({
      model: "openai/gpt-5.5",
    });
    expect(prefixed).toEqual({ model: "openai/gpt-5.5" });
    const foreign = await adapter.resolveSmokeModel({
      model: "opencode/big-pickle",
    });
    expect(foreign).toEqual({ error: "MODEL_UNAVAILABLE" });
  });

  it("falls back to runtime discovery when no model is given", async () => {
    const runner = async ({ args }) =>
      args.join(" ") === "models openai"
        ? { exitCode: 0, stdout: "openai/gpt-5.5\nopenai/gpt-5\n" }
        : { exitCode: 0, stdout: "" };
    const resolved = await adapter.resolveSmokeModel({
      executablePath: "C:\\bin\\opencode.exe",
      profileDir: PROFILE_DIR,
      baseEnv: {},
      runner,
      model: undefined,
    });
    expect(resolved).toEqual({ model: "openai/gpt-5.5" });
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

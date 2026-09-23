import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import claude from "./claude.js";

const {
  CLAUDE_CURATED_MODELS,
  CLAUDE_SMOKE_PROMPT,
  buildClaudeLoginInvocation,
  buildClaudeLogoutInvocation,
  buildClaudePrintInvocation,
  buildClaudeStatusInvocation,
  claudeAdapter,
  detectManagedLoginPolicy,
  parseClaudeAuthStatus,
  parseClaudePrintResult,
  resolveClaudeExecutable,
} = claude;

const tmpRoots = [];
function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-claude-"));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const PROFILE_DIR = "C:\\managed\\profiles\\rp_test";

// All credential/provider-route env vars that must never reach a managed
// Claude process (spec §8/§35).
const POISONED_ENV = {
  PATH: "C:\\Windows",
  ANTHROPIC_API_KEY: "sk-ant-ambient",
  ANTHROPIC_AUTH_TOKEN: "ambient",
  CLAUDE_CODE_OAUTH_TOKEN: "ambient",
  ANTHROPIC_PROFILE: "ambient",
  ANTHROPIC_FEDERATION_RULE_ID: "ambient",
  ANTHROPIC_ORGANIZATION_ID: "ambient",
  ANTHROPIC_IDENTITY_TOKEN_FILE: "ambient",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_USE_FOUNDRY: "1",
  ANTHROPIC_BASE_URL: "https://gateway.example.com",
  CLAUDE_API_KEY: "ambient",
  OPENAI_API_KEY: "sk-cross-provider",
  GITHUB_TOKEN: "ghp_cross-provider",
  MY_RANDOM: "not-allowlisted",
};

function assertSanitizedManagedEnv(env, expectedProfileDir) {
  expect(env.CLAUDE_CONFIG_DIR).toBe(expectedProfileDir);
  for (const key of Object.keys(POISONED_ENV)) {
    if (key === "PATH") continue;
    expect(env[key]).toBeUndefined();
  }
  expect(env.PATH).toBe("C:\\Windows");
  // Never the host-global Claude config dir.
  expect(env.CLAUDE_CONFIG_DIR).not.toContain(".claude");
}

describe("resolveClaudeExecutable", () => {
  it("returns an .exe path unchanged when it exists", () => {
    const exe = "C:\\runtimes\\claude.exe";
    expect(
      resolveClaudeExecutable(exe, { existsSyncImpl: () => true }),
    ).toBe(exe);
  });

  it("returns null for a missing .exe", () => {
    expect(
      resolveClaudeExecutable("C:\\runtimes\\claude.exe", {
        existsSyncImpl: () => false,
      }),
    ).toBeNull();
  });

  it("unwraps the npm .cmd shim to the vendored claude.exe", () => {
    // Layout mirrors a real npm install:
    //   <npmRoot>/claude.cmd
    //   <npmRoot>/node_modules/@anthropic-ai/claude-code/bin/claude.exe
    const npmRoot = makeTmp();
    const shim = path.join(npmRoot, "claude.cmd");
    const vendorExe = path.join(
      npmRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    fs.mkdirSync(path.dirname(vendorExe), { recursive: true });
    fs.writeFileSync(shim, "@echo off");
    fs.writeFileSync(vendorExe, "MZ");

    expect(resolveClaudeExecutable(shim)).toBe(vendorExe);
    // The extensionless npm shim resolves the same way.
    fs.writeFileSync(path.join(npmRoot, "claude"), "sh");
    expect(resolveClaudeExecutable(path.join(npmRoot, "claude"))).toBe(
      vendorExe,
    );
  });

  it("prefers the platform vendor binary when both exist", () => {
    const npmRoot = makeTmp();
    const shim = path.join(npmRoot, "claude.cmd");
    const binExe = path.join(
      npmRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );
    const platformExe = path.join(
      npmRoot,
      "node_modules",
      "@anthropic-ai",
      "claude-code-win32-x64",
      "bin",
      "claude.exe",
    );
    fs.mkdirSync(path.dirname(binExe), { recursive: true });
    fs.mkdirSync(path.dirname(platformExe), { recursive: true });
    fs.writeFileSync(shim, "@echo off");
    fs.writeFileSync(binExe, "MZ");
    fs.writeFileSync(platformExe, "MZ");
    // The declared bin entry wins over the platform vendor dir.
    expect(resolveClaudeExecutable(shim)).toBe(binExe);
  });

  it("ignores npm staging dirs and returns null when no exe exists", () => {
    const npmRoot = makeTmp();
    const staging = path.join(
      npmRoot,
      "node_modules",
      "@anthropic-ai",
      ".claude-code-staging",
      "bin",
    );
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "claude.exe"), "MZ");
    const shim = path.join(npmRoot, "claude.cmd");
    fs.writeFileSync(shim, "@echo off");
    expect(resolveClaudeExecutable(shim)).toBeNull();
  });
});

describe("parseClaudeAuthStatus", () => {
  it("maps loggedIn:false to NOT_AUTHENTICATED", () => {
    const status = parseClaudeAuthStatus({
      exitCode: 1,
      stdout: JSON.stringify({
        loggedIn: false,
        authMethod: "none",
        apiProvider: "firstParty",
      }),
    });
    expect(status.authState).toBe("NOT_AUTHENTICATED");
    expect(status.authKind).toBeNull();
  });

  it("exit code 1 without JSON means not authenticated", () => {
    expect(parseClaudeAuthStatus({ exitCode: 1, stdout: "" }).authState).toBe(
      "NOT_AUTHENTICATED",
    );
  });

  it("classifies a Claude.ai subscription login with whitelisted metadata", () => {
    // Verified shape from claude 2.1.203 `auth status --json`.
    const status = parseClaudeAuthStatus({
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        apiProvider: "firstParty",
        email: "user@example.com",
        orgId: "14eb9043-2dba-42f4-9213-eecd7d0965ff",
        orgName: "user@example.com's Organization",
        subscriptionType: "pro",
      }),
    });
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.authKind).toBe("CLAUDE_AI_SUBSCRIPTION");
    expect(status.accountIdentity).toBe("user@example.com");
    expect(status.providerMetadata).toEqual({
      organizationName: "user@example.com's Organization",
      subscriptionType: "pro",
      loginMethod: "claude.ai",
    });
  });

  it("classifies a Console login as a non-subscription method", () => {
    const status = parseClaudeAuthStatus({
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "console",
        apiProvider: "firstParty",
      }),
    });
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.authKind).toBe("CONSOLE");
  });

  it("classifies API-key and env-token auth", () => {
    for (const [authMethod, expected] of [
      ["apiKey", "API_KEY"],
      ["oauthToken", "OAUTH_ENV_TOKEN"],
      ["authToken", "AUTH_TOKEN"],
    ]) {
      const status = parseClaudeAuthStatus({
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod,
          apiProvider: "firstParty",
        }),
      });
      expect(status.authState).toBe("AUTHENTICATED");
      expect(status.authKind).toBe(expected);
    }
  });

  it("classifies cloud-provider routes even when logged in", () => {
    for (const apiProvider of ["bedrock", "vertex", "foundry"]) {
      const status = parseClaudeAuthStatus({
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider,
        }),
      });
      expect(status.authKind).toBe("CLOUD_PROVIDER");
    }
  });

  it("reports UNKNOWN for unrecognized logged-in shapes — never guesses", () => {
    const status = parseClaudeAuthStatus({
      exitCode: 0,
      stdout: JSON.stringify({
        loggedIn: true,
        authMethod: "something-new",
        apiProvider: "firstParty",
      }),
    });
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.authKind).toBe("UNKNOWN");
  });

  it("maps unparseable output to UNKNOWN rather than trusting exit 0", () => {
    expect(
      parseClaudeAuthStatus({ exitCode: 0, stdout: "garbage" }).authKind,
    ).toBeNull();
  });
});

describe("adapter auth classification", () => {
  const ok = (kind) => ({
    authState: "AUTHENTICATED",
    authKind: kind,
    authMethod: kind,
    accountIdentity: null,
  });

  it("accepts only Claude.ai subscription for ACCOUNT_LOGIN", () => {
    expect(
      claudeAdapter.loginFailureCode(ok("CLAUDE_AI_SUBSCRIPTION")),
    ).toBeNull();
  });

  it("rejects recognized non-subscription methods", () => {
    for (const kind of ["CONSOLE", "API_KEY", "AUTH_TOKEN", "CLOUD_PROVIDER"]) {
      expect(claudeAdapter.loginFailureCode(ok(kind))).toBe(
        "UNSUPPORTED_AUTH_METHOD",
      );
    }
  });

  it("rejects unclassifiable sessions as AUTH_METHOD_UNVERIFIED", () => {
    expect(claudeAdapter.loginFailureCode(ok("UNKNOWN"))).toBe(
      "AUTH_METHOD_UNVERIFIED",
    );
    expect(
      claudeAdapter.loginFailureCode({ authState: "NOT_AUTHENTICATED" }),
    ).toBe("AUTH_NOT_CONFIRMED");
  });

  it("never reports a non-subscription session as AUTHENTICATED", () => {
    expect(claudeAdapter.reportableAuthState(ok("API_KEY"))).toBe("UNKNOWN");
    expect(claudeAdapter.reportableAuthState(ok("CLAUDE_AI_SUBSCRIPTION"))).toBe(
      "AUTHENTICATED",
    );
    expect(
      claudeAdapter.reportableAuthState({ authState: "NOT_AUTHENTICATED" }),
    ).toBe("NOT_AUTHENTICATED");
  });
});

describe("detectManagedLoginPolicy", () => {
  it("reports restricted when forceLoginMethod is not claudeai", () => {
    const root = makeTmp();
    const file = path.join(root, "ClaudeCode", "managed-settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ forceLoginMethod: "console" }));
    const policy = detectManagedLoginPolicy({
      platform: "win32",
      env: { PROGRAMDATA: root },
    });
    expect(policy.restricted).toBe(true);
    expect(policy.forcedLoginMethod).toBe("console");
  });

  it("is not restricted for claudeai or missing policy files", () => {
    const root = makeTmp();
    const file = path.join(root, "ClaudeCode", "managed-settings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ forceLoginMethod: "claudeai" }));
    expect(
      detectManagedLoginPolicy({
        platform: "win32",
        env: { PROGRAMDATA: root },
      }).restricted,
    ).toBe(false);
    expect(
      detectManagedLoginPolicy({
        platform: "win32",
        env: { PROGRAMDATA: path.join(root, "missing") },
      }).restricted,
    ).toBe(false);
  });
});

describe("claude invocation builders", () => {
  it("login runs `claude auth login --claudeai` inside CLAUDE_CONFIG_DIR", () => {
    const inv = buildClaudeLoginInvocation({
      executablePath: "C:\\x\\claude.exe",
      profileDir: PROFILE_DIR,
      baseEnv: POISONED_ENV,
    });
    expect(inv.executable).toBe("C:\\x\\claude.exe");
    expect(inv.args).toEqual(["auth", "login", "--claudeai"]);
    assertSanitizedManagedEnv(inv.env, PROFILE_DIR);
  });

  it("logout runs `claude auth logout` in the same isolated env", () => {
    const inv = buildClaudeLogoutInvocation({
      executablePath: "C:\\x\\claude.exe",
      profileDir: PROFILE_DIR,
      baseEnv: POISONED_ENV,
    });
    expect(inv.args).toEqual(["auth", "logout"]);
    assertSanitizedManagedEnv(inv.env, PROFILE_DIR);
  });

  it("status runs `claude auth status --json` in the isolated env", () => {
    const inv = buildClaudeStatusInvocation({
      executablePath: "C:\\x\\claude.exe",
      profileDir: PROFILE_DIR,
      baseEnv: POISONED_ENV,
    });
    expect(inv.args).toEqual(["auth", "status", "--json"]);
    assertSanitizedManagedEnv(inv.env, PROFILE_DIR);
  });

  it("print mode is no-tool, no-MCP, no-persistence, Vocatrya-cwd", () => {
    const wd = "C:\\vocatrya\\tmp\\smoke-1";
    const inv = buildClaudePrintInvocation({
      executablePath: "C:\\x\\claude.exe",
      profileDir: PROFILE_DIR,
      baseEnv: POISONED_ENV,
      workingDirectory: wd,
      model: "sonnet",
      prompt: CLAUDE_SMOKE_PROMPT,
    });
    expect(inv.args).toEqual([
      "-p",
      "--output-format",
      "json",
      "--tools",
      "",
      "--disallowedTools",
      "mcp__*",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--safe-mode",
      "--model",
      "sonnet",
      CLAUDE_SMOKE_PROMPT,
    ]);
    expect(inv.cwd).toBe(wd);
    assertSanitizedManagedEnv(inv.env, PROFILE_DIR);
    // No permission-bypass or tool-enabling flags ever appear.
    expect(inv.args.join(" ")).not.toMatch(
      /dangerously-skip-permissions|bypassPermissions|acceptEdits|--allowedTools/,
    );
  });
});

describe("parseClaudePrintResult", () => {
  it("extracts the result text from the JSON envelope", () => {
    const { text, reportedError } = parseClaudePrintResult({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "VOCATRYA_CLAUDE_OK",
      }),
    });
    expect(text).toBe("VOCATRYA_CLAUDE_OK");
    expect(reportedError).toBe(false);
  });

  it("flags is_error envelopes as reported errors", () => {
    const { reportedError } = parseClaudePrintResult({
      stdout: JSON.stringify({
        type: "result",
        is_error: true,
        result: "execution error",
      }),
    });
    expect(reportedError).toBe(true);
  });

  it("falls back to the last non-empty line for text output", () => {
    const { text } = parseClaudePrintResult({
      stdout: "banner\nVOCATRYA_CLAUDE_OK\n",
    });
    expect(text).toBe("VOCATRYA_CLAUDE_OK");
  });
});

describe("curated fallback catalog", () => {
  it("offers the official Claude Code aliases only — no fake entitlements", () => {
    const ids = CLAUDE_CURATED_MODELS.map((m) => m.id);
    expect(ids).toEqual(["sonnet", "opus", "haiku", "fable"]);
  });

  it("listModels reports CURATED with unknown availability", async () => {
    const catalog = await claudeAdapter.listModels({});
    expect(catalog.dynamicDiscoverySupported).toBe(false);
    expect(catalog.models.every((m) => m.source === "CURATED")).toBe(true);
    expect(catalog.models.every((m) => m.availability === "unknown")).toBe(
      true,
    );
  });
});

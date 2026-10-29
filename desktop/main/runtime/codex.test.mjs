import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import codex from "./codex.js";

const {
  CODEX_CURATED_MODELS,
  CODEX_SMOKE_PROMPT,
  buildCodexExecInvocation,
  buildCodexLoginInvocation,
  buildCodexLogoutInvocation,
  buildCodexModelsInvocation,
  parseCodexLoginStatus,
  parseCodexModelCatalog,
  resolveCodexExecutable,
} = codex;

const tmpRoots = [];
function makeTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-codex-"));
  tmpRoots.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpRoots) fs.rmSync(dir, { recursive: true, force: true });
});

const PROFILE_DIR = "C:\\managed\\profiles\\rp_test";

describe("resolveCodexExecutable", () => {
  it("returns an .exe path unchanged when it exists", () => {
    const exe = "C:\\runtimes\\codex.exe";
    expect(
      resolveCodexExecutable(exe, { existsSyncImpl: () => true }),
    ).toBe(exe);
  });

  it("returns null for a missing .exe", () => {
    expect(
      resolveCodexExecutable("C:\\runtimes\\codex.exe", {
        existsSyncImpl: () => false,
      }),
    ).toBeNull();
  });

  it("unwraps the npm .cmd shim to the vendored codex.exe", () => {
    // Layout mirrors a real npm install:
    //   <npmRoot>/codex.cmd
    //   <npmRoot>/node_modules/@openai/codex/node_modules/@openai/
    //     codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe
    const npmRoot = makeTmp();
    const shim = path.join(npmRoot, "codex.cmd");
    const vendorExe = path.join(
      npmRoot,
      "node_modules",
      "@openai",
      "codex",
      "node_modules",
      "@openai",
      "codex-win32-x64",
      "vendor",
      "x86_64-pc-windows-msvc",
      "bin",
      "codex.exe",
    );
    fs.mkdirSync(path.dirname(vendorExe), { recursive: true });
    fs.writeFileSync(shim, "@echo off");
    fs.writeFileSync(vendorExe, "MZ");

    expect(resolveCodexExecutable(shim)).toBe(vendorExe);
    // The extensionless npm shim resolves the same way.
    fs.writeFileSync(path.join(npmRoot, "codex"), "sh");
    expect(resolveCodexExecutable(path.join(npmRoot, "codex"))).toBe(
      vendorExe,
    );
  });

  it("ignores npm staging dirs and returns null when no exe exists", () => {
    const npmRoot = makeTmp();
    const staging = path.join(
      npmRoot,
      "node_modules",
      "@openai",
      ".codex-staging",
      "codex-win32-x64",
      "bin",
    );
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, "codex.exe"), "MZ");
    const shim = path.join(npmRoot, "codex.cmd");
    fs.writeFileSync(shim, "@echo off");
    expect(resolveCodexExecutable(shim)).toBeNull();
  });
});

describe("parseCodexLoginStatus", () => {
  it("maps 'Not logged in' to NOT_AUTHENTICATED", () => {
    expect(
      parseCodexLoginStatus({ exitCode: 1, stdout: "Not logged in\n" })
        .authState,
    ).toBe("NOT_AUTHENTICATED");
  });

  it("exit code 1 alone means not authenticated", () => {
    expect(
      parseCodexLoginStatus({ exitCode: 1, stdout: "" }).authState,
    ).toBe("NOT_AUTHENTICATED");
  });

  it("detects ChatGPT account login", () => {
    const status = parseCodexLoginStatus({
      exitCode: 0,
      stdout: "Logged in using ChatGPT\n",
    });
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.authMethod).toBe("chatgpt");
    expect(status.accountIdentity).toBeNull();
  });

  it("extracts a plain email identity when the CLI prints one", () => {
    const status = parseCodexLoginStatus({
      exitCode: 0,
      stdout: "Logged in using ChatGPT (user@example.com)\n",
    });
    expect(status.accountIdentity).toBe("user@example.com");
  });

  it("recognizes API-key auth as a different method", () => {
    const status = parseCodexLoginStatus({
      exitCode: 0,
      stdout: "Logged in using an API key - sk-abc***xyz\n",
    });
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.authMethod).toBe("api_key");
  });

  it("maps status errors to UNKNOWN", () => {
    expect(
      parseCodexLoginStatus({
        exitCode: 0,
        stderr: "Error checking login status: io error",
      }).authState,
    ).toBe("UNKNOWN");
  });
});

describe("parseCodexModelCatalog", () => {
  it("parses the debug models JSON and keeps only list-visible models", () => {
    const stdout = JSON.stringify({
      models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-Astra", visibility: "list" },
        { slug: "hidden-one", display_name: "Hidden", visibility: "hide" },
        { slug: "no-name", visibility: "list" },
      ],
    });
    expect(parseCodexModelCatalog(stdout)).toEqual([
      { id: "gpt-6-astra", displayName: "GPT-6-Astra" },
      { id: "no-name", displayName: "no-name" },
    ]);
  });

  it("returns null on malformed output", () => {
    expect(parseCodexModelCatalog("not json")).toBeNull();
    expect(parseCodexModelCatalog("{}")).toBeNull();
    expect(parseCodexModelCatalog('{"models":[]}')).toBeNull();
  });
});

describe("codex invocation builders", () => {
  const baseEnv = {
    PATH: "C:\\Windows",
    OPENAI_API_KEY: "sk-should-be-stripped",
    CODEX_API_KEY: "also-stripped",
    CODEX_ACCESS_TOKEN: "stripped-too",
    GITHUB_TOKEN: "ghp_also-stripped-cross-provider",
    MY_RANDOM: "not-allowlisted",
  };

  it("login runs `codex login` inside the managed CODEX_HOME", () => {
    const inv = buildCodexLoginInvocation({
      executablePath: "C:\\x\\codex.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
    });
    expect(inv.executable).toBe("C:\\x\\codex.exe");
    expect(inv.args).toEqual(["login"]);
    expect(inv.env.CODEX_HOME).toBe(PROFILE_DIR);
    expect(inv.env.OPENAI_API_KEY).toBeUndefined();
    expect(inv.env.CODEX_API_KEY).toBeUndefined();
    expect(inv.env.CODEX_ACCESS_TOKEN).toBeUndefined();
    expect(inv.env.GITHUB_TOKEN).toBeUndefined();
    expect(inv.env.MY_RANDOM).toBeUndefined();
    expect(inv.env.PATH).toBe("C:\\Windows");
    // Never the host-global home.
    expect(inv.env.CODEX_HOME).not.toContain(".codex");
  });

  it("logout runs `codex logout` in the same isolated env", () => {
    const inv = buildCodexLogoutInvocation({
      executablePath: "C:\\x\\codex.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
    });
    expect(inv.args).toEqual(["logout"]);
    expect(inv.env.CODEX_HOME).toBe(PROFILE_DIR);
  });

  it("models uses `codex debug models` and --bundled fallback", () => {
    const dynamic = buildCodexModelsInvocation({
      executablePath: "C:\\x\\codex.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
    });
    const bundled = buildCodexModelsInvocation({
      executablePath: "C:\\x\\codex.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
      bundled: true,
    });
    expect(dynamic.args).toEqual(["debug", "models"]);
    expect(bundled.args).toEqual(["debug", "models", "--bundled"]);
  });

  it("exec is read-only, ephemeral, Vocatrya-cwd, with optional model", () => {
    const wd = "C:\\vocatrya\\tmp\\smoke-1";
    const out = path.join(wd, "last-message.txt");
    const inv = buildCodexExecInvocation({
      executablePath: "C:\\x\\codex.exe",
      profileDir: PROFILE_DIR,
      baseEnv,
      workingDirectory: wd,
      outputFile: out,
      model: "gpt-5.5",
      prompt: CODEX_SMOKE_PROMPT,
    });
    expect(inv.args).toEqual([
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "-s",
      "read-only",
      "-C",
      wd,
      "-o",
      out,
      "-m",
      "gpt-5.5",
      "-",
    ]);
    // The prompt rides piped stdin (`codex exec -`), never an argv element.
    expect(inv.args).not.toContain(CODEX_SMOKE_PROMPT);
    expect(inv.stdinPipe).toBe(true);
    const stdin = { on() {}, end(c) { this.chunk = c; this.ended = true; } };
    inv.onStdinReady(stdin);
    expect(stdin.chunk).toBe(CODEX_SMOKE_PROMPT);
    expect(stdin.ended).toBe(true);
    expect(inv.cwd).toBe(wd);
    expect(inv.env.CODEX_HOME).toBe(PROFILE_DIR);
    // No broad-write or bypass flags ever appear.
    expect(inv.args.join(" ")).not.toMatch(/workspace-write|danger|full-access/);
  });
});

describe("curated fallback catalog", () => {
  it("is derived from the codex-cli 0.154.0 bundled catalog, not legacy OpenAI models", () => {
    const ids = CODEX_CURATED_MODELS.map((m) => m.id);
    expect(ids).toContain("gpt-6-astra");
    expect(ids).toContain("gpt-5.6-sol");
    expect(ids).toContain("gpt-5.5");
    expect(ids).not.toContain("gpt-4o");
    expect(ids).not.toContain("gpt-3.5-turbo");
  });
});

// Phase I Devin adapter unit tests — pure parsing/resolution/config helpers.
// Verified behaviors against devin 3000.10.31 are asserted literally so a
// silent upstream output change fails loudly instead of misclassifying auth.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import devinModule from "./devin.js";

const {
  DEVIN_MANAGED_CONFIG,
  buildDevinLoginInvocation,
  buildDevinLogoutInvocation,
  buildDevinPrintInvocation,
  buildDevinStatusInvocation,
  classifyDevinAuthVia,
  devinAdapter,
  devinConfigPath,
  devinEnv,
  ensureDevinProfileSkeleton,
  managedConfigHasOrgId,
  parseDevinAuthStatus,
  parseDevinModelList,
  parseDevinPrintResult,
  resolveDevinExecutable,
  writeManagedDevinConfig,
} = devinModule;

const PROFILE_DIR = "C:\\managed\\profiles\\rp_test";
const EXE = "C:\\fake\\devin\\bin\\devin.exe";

const AUTHED_STATUS = [
  "Logged in (via Devin).",
  "",
  "Credentials:",
  "  File:              C:\\managed\\devin\\credentials.toml",
  "  API server:        https://server.codeium.com",
  "",
  "User:",
  "  Name:              Test User",
  "  Email:             user@example.com",
  "  User ID:           user-abc123",
  "",
  "Account:",
  "  Tier:              Devin Pro",
  "  Plan:              Pro",
  "  Team ID:           devin-team$account-xyz",
  "  Enterprise:        no",
  "",
].join("\n");

const UNAUTHED_STATUS = [
  "Not logged in.",
  "  Credentials path: C:\\managed\\devin\\credentials.toml",
  "  Run `devin.exe auth login` to authenticate.",
].join("\n");

describe("resolveDevinExecutable", () => {
  it("keeps a real .exe path", () => {
    expect(
      resolveDevinExecutable(EXE, { existsSyncImpl: () => true }),
    ).toBe(EXE);
  });
  it("rejects a missing .exe", () => {
    expect(
      resolveDevinExecutable(EXE, { existsSyncImpl: () => false }),
    ).toBeNull();
  });
  it("unwraps a shim to the sibling devin.exe", () => {
    expect(
      resolveDevinExecutable("C:\\fake\\devin\\bin\\devin.cmd", {
        existsSyncImpl: (p) => p === EXE,
      }),
    ).toBe(EXE);
  });
});

describe("parseDevinAuthStatus", () => {
  it("classifies 'via Devin' as a personal account login", () => {
    const status = parseDevinAuthStatus({ exitCode: 0, stdout: AUTHED_STATUS });
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.authKind).toBe("DEVIN_ACCOUNT");
    expect(status.authMethod).toBe("Devin");
    expect(status.accountIdentity).toBe("user@example.com");
    expect(status.providerMetadata).toMatchObject({
      userId: "user-abc123",
      tier: "Devin Pro",
      plan: "Pro",
      teamId: "devin-team$account-xyz",
      enterprise: "no",
    });
  });

  it("classifies 'Not logged in.' as NOT_AUTHENTICATED", () => {
    const status = parseDevinAuthStatus({ exitCode: 1, stdout: UNAUTHED_STATUS });
    expect(status.authState).toBe("NOT_AUTHENTICATED");
    expect(status.authKind).toBeNull();
  });

  it("classifies token-paste sessions as PAT — never account login", () => {
    const status = parseDevinAuthStatus({
      exitCode: 0,
      stdout: "Logged in (via token).\n",
    });
    expect(status.authState).toBe("AUTHENTICATED");
    expect(status.authKind).toBe("PAT");
    expect(devinAdapter.loginFailureCode(status)).toBe(
      "UNSUPPORTED_AUTH_METHOD",
    );
  });

  it("classifies API-key sessions as API_KEY — never account login", () => {
    const status = parseDevinAuthStatus({
      exitCode: 0,
      stdout: "Logged in (via API key).\n",
    });
    expect(status.authKind).toBe("API_KEY");
    expect(devinAdapter.loginFailureCode(status)).toBe(
      "UNSUPPORTED_AUTH_METHOD",
    );
  });

  it("an unrecognized method is UNKNOWN — never accepted", () => {
    const status = parseDevinAuthStatus({
      exitCode: 0,
      stdout: "Logged in (via Windsurf).\n",
    });
    expect(status.authKind).toBe("UNKNOWN");
    expect(devinAdapter.loginFailureCode(status)).toBe(
      "AUTH_METHOD_UNVERIFIED",
    );
  });

  it("unclassifiable output is UNKNOWN, not AUTHENTICATED", () => {
    const status = parseDevinAuthStatus({ exitCode: 0, stdout: "???" });
    expect(status.authState).toBe("UNKNOWN");
    expect(devinAdapter.loginFailureCode(status)).toBe("AUTH_NOT_CONFIRMED");
  });
});

describe("classifyDevinAuthVia", () => {
  it("maps only 'Devin' to the account-login kind", () => {
    expect(classifyDevinAuthVia("Devin")).toBe("DEVIN_ACCOUNT");
    expect(classifyDevinAuthVia("token")).toBe("PAT");
    expect(classifyDevinAuthVia("service account")).toBe("API_KEY");
    expect(classifyDevinAuthVia("Windsurf")).toBe("UNKNOWN");
  });
});

describe("adapter auth gates", () => {
  it("loginFailureCode requires AUTHENTICATED + DEVIN_ACCOUNT", () => {
    expect(
      devinAdapter.loginFailureCode({
        authState: "AUTHENTICATED",
        authKind: "DEVIN_ACCOUNT",
      }),
    ).toBeNull();
    expect(
      devinAdapter.loginFailureCode({ authState: "NOT_AUTHENTICATED" }),
    ).toBe("AUTH_NOT_CONFIRMED");
  });
  it("reportableAuthState never reports a non-account login as CONNECTED", () => {
    expect(
      devinAdapter.reportableAuthState({
        authState: "AUTHENTICATED",
        authKind: "API_KEY",
      }),
    ).toBe("UNKNOWN");
    expect(
      devinAdapter.reportableAuthState({
        authState: "AUTHENTICATED",
        authKind: "DEVIN_ACCOUNT",
      }),
    ).toBe("AUTHENTICATED");
  });
});

describe("managed profile skeleton + config", () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-devin-unit-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("materializes the AppData skeleton the CLI canonicalizes", () => {
    ensureDevinProfileSkeleton(dir);
    expect(
      fs.statSync(path.join(dir, "home", "AppData", "Roaming")).isDirectory(),
    ).toBe(true);
    expect(
      fs.statSync(path.join(dir, "home", "AppData", "Local")).isDirectory(),
    ).toBe(true);
  });

  it("writes a hardened config with deny-first permissions", () => {
    writeManagedDevinConfig(dir);
    const config = JSON.parse(fs.readFileSync(devinConfigPath(dir), "utf8"));
    expect(config.auto_update).toBe(false);
    expect(config.subagents_enabled).toBe(false);
    expect(config.respect_workspace_trust).toBe(false);
    expect(config.notify).toBe("never");
    for (const key of Object.keys(config.read_config_from)) {
      expect(config.read_config_from[key]).toBe(false);
    }
    expect(config.permissions.deny).toEqual(
      expect.arrayContaining([
        "exec",
        "edit",
        "mcp__*",
        "Write(**)",
        "Write(/**)",
        "Read(/**)",
      ]),
    );
  });

  it("preserves a CLI-managed devin.org_id across rewrites", () => {
    const target = devinConfigPath(dir);
    const existing = JSON.parse(fs.readFileSync(target, "utf8"));
    existing.devin = { org_id: "org-test" };
    fs.writeFileSync(target, JSON.stringify(existing), "utf8");
    writeManagedDevinConfig(dir);
    const next = JSON.parse(fs.readFileSync(target, "utf8"));
    expect(next.devin.org_id).toBe("org-test");
    expect(next.auto_update).toBe(false);
    expect(managedConfigHasOrgId(dir)).toBe(true);
  });
});

describe("devinEnv", () => {
  it("redirects USERPROFILE-anchored roots into the profile", () => {
    const env = devinEnv({
      profileDir: PROFILE_DIR,
      baseEnv: {
        PATH: "C:\\Windows",
        USERPROFILE: "C:\\Users\\Real",
        HOME: "C:\\Users\\Real",
        HOMEDRIVE: "C:",
        HOMEPATH: "\\Users\\Real",
        APPDATA: "C:\\Users\\Real\\AppData\\Roaming",
        DEVIN_API_KEY: "ambient-key",
        WINDSURF_API_KEY: "ws-ambient",
        HTTP_PROXY: "http://127.0.0.1:7897",
      },
    });
    const home = path.join(PROFILE_DIR, "home");
    expect(env.USERPROFILE).toBe(home);
    expect(env.HOME).toBe(home);
    expect(env.APPDATA).toBe(path.join(home, "AppData", "Roaming"));
    expect(env.LOCALAPPDATA).toBe(path.join(home, "AppData", "Local"));
    expect(env.HOMEDRIVE).toBeUndefined();
    expect(env.HOMEPATH).toBeUndefined();
    expect(env.DEVIN_API_KEY).toBeUndefined();
    expect(env.WINDSURF_API_KEY).toBeUndefined();
    // Ordinary proxy settings pass through — the account's network must work.
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7897");
  });
});

describe("invocation builders", () => {
  let dir;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-devin-inv-"));
  });
  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("login launches a console window via cmd start /wait — never pipes", () => {
    const inv = buildDevinLoginInvocation({
      executablePath: EXE,
      profileDir: dir,
      baseEnv: {
        PATH: "C:\\Windows",
        APPDATA: "C:\\Users\\Real\\AppData\\Roaming",
        LOCALAPPDATA: "C:\\Users\\Real\\AppData\\Local",
      },
    });
    // The TUI method menu reads console input events — the vendor CLI owns
    // the whole flow inside a real window. cmd is a fixed launcher; argv is
    // static and the spawn boundary stays shell:false.
    expect(inv.executable).toBe("cmd.exe");
    expect(inv.args.slice(0, 5)).toEqual(["/d", "/c", "start", "", "/wait"]);
    expect(inv.args[5]).toBe(EXE);
    expect(inv.args.slice(6)).toEqual(["auth", "login"]);
    expect(inv.cwd).toBe(dir);
    // USERPROFILE — the credentials boundary — stays managed.
    expect(inv.env.USERPROFILE).toBe(path.join(dir, "home"));
    // APPDATA/LOCALAPPDATA pass through so the spawned browser resolves
    // the real user-data dir (the account's existing browser session).
    expect(inv.env.APPDATA).toBe("C:\\Users\\Real\\AppData\\Roaming");
    expect(inv.env.LOCALAPPDATA).toBe("C:\\Users\\Real\\AppData\\Local");
    // The hardened managed config exists before the login process starts.
    expect(fs.existsSync(devinConfigPath(dir))).toBe(true);
  });

  it("logout runs `auth logout` piped inside the managed profile", () => {
    const inv = buildDevinLogoutInvocation({
      executablePath: EXE,
      profileDir: dir,
      baseEnv: {},
    });
    expect(inv.executable).toBe(EXE);
    expect(inv.args).toEqual(["auth", "logout"]);
    expect(inv.cwd).toBe(dir);
    expect(inv.env.USERPROFILE).toBe(path.join(dir, "home"));
  });

  it("status runs `auth status` piped inside the managed profile", () => {
    const inv = buildDevinStatusInvocation({
      executablePath: EXE,
      profileDir: dir,
      baseEnv: {},
    });
    expect(inv.executable).toBe(EXE);
    expect(inv.args).toEqual(["auth", "status"]);
  });

  it("smoke pins permission-mode auto, no trust prompt, temp cwd, model", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-devin-wd-"));
    const inv = buildDevinPrintInvocation({
      executablePath: EXE,
      profileDir: dir,
      baseEnv: {},
      workingDirectory: workDir,
      model: "swe-2-high",
      prompt: "Reply with exactly: VOCATRYA_DEVIN_OK",
    });
    expect(inv.executable).toBe(EXE);
    const promptPath = path.join(workDir, "prompt.txt");
    expect(inv.args).toEqual([
      "-p",
      "--prompt-file",
      promptPath,
      "--permission-mode",
      "auto",
      "--respect-workspace-trust",
      "false",
      "--model",
      "swe-2-high",
    ]);
    // The prompt rides a file inside the workDir — never an argv element.
    expect(inv.args).not.toContain("Reply with exactly: VOCATRYA_DEVIN_OK");
    expect(fs.readFileSync(promptPath, "utf8")).toBe(
      "Reply with exactly: VOCATRYA_DEVIN_OK",
    );
    expect(inv.cwd).toBe(workDir);
    expect(inv.env.USERPROFILE).toBe(path.join(dir, "home"));
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it("smoke never emits cloud/auto-approve/sandbox-bypass flags", () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-devin-wd-"));
    const inv = buildDevinPrintInvocation({
      executablePath: EXE,
      profileDir: dir,
      baseEnv: {},
      workingDirectory: workDir,
      prompt: "x",
    });
    fs.rmSync(workDir, { recursive: true, force: true });
    const joined = inv.args.join(" ");
    expect(joined).not.toMatch(/--cloud|handoff|yolo|dangerous|bypass|acp/i);
    expect(inv.args).not.toContain("--sandbox");
    expect(inv.args).not.toContain("--config");
  });
});

describe("parseDevinModelList", () => {
  it("flattens families[].variants[] into runtime models", () => {
    const models = parseDevinModelList(
      JSON.stringify({
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
            variants: [
              { model_uid: "fusion-x", label: "Fusion X" },
            ],
          },
        ],
      }),
    );
    expect(models.map((m) => m.id)).toEqual([
      "swe-2-high",
      "swe-2-max",
      "fusion-x",
    ]);
    expect(models[0].displayName).toBe("SWE-2 High");
  });

  it("returns null on malformed or empty output", () => {
    expect(parseDevinModelList("not json")).toBeNull();
    expect(parseDevinModelList("{}")).toEqual([]);
    expect(parseDevinModelList('{"families":[]}')).toEqual([]);
  });
});

describe("parseDevinPrintResult", () => {
  it("prefers the exact marker line over a first-run banner", () => {
    const { text } = parseDevinPrintResult({
      stdout: "Welcome to Devin CLI!\n\nLogged in as user@example.com.\n\nVOCATRYA_DEVIN_OK\n",
      stderr: "",
    });
    expect(text).toBe("VOCATRYA_DEVIN_OK");
  });

  it("falls back to the last non-empty line", () => {
    const { text } = parseDevinPrintResult({ stdout: "a\nb\n", stderr: "" });
    expect(text).toBe("b");
  });
});

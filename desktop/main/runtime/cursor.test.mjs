// Phase H Cursor adapter unit tests — pure parsing/resolution helpers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import cursorModule from "./cursor.js";

const {
  buildCursorLoginInvocation,
  buildCursorSmokeInvocation,
  cursorAdapter,
  parseCursorAuthStatus,
  parseCursorModelList,
  parseCursorSmokeResult,
  resolveCursorExecutable,
  writeManagedCursorConfig,
} = cursorModule;

const VERSIONS_DIR = "C:\\fake-local\\cursor-agent\\versions";
const BUNDLE_DIR = path.join(VERSIONS_DIR, "2026.09.18-9a7762b");
const NODE_EXE = path.join(BUNDLE_DIR, "node.exe");
const ENTRYPOINT = path.join(BUNDLE_DIR, "index.js");

function bundleDeps({ dirs = ["2026.09.18-9a7762b"], env } = {}) {
  return {
    env: env || { LOCALAPPDATA: "C:\\fake-local" },
    existsSyncImpl: (p) => p === NODE_EXE || p === ENTRYPOINT,
    readdirSyncImpl: (p) =>
      p === VERSIONS_DIR
        ? dirs.map((name) => ({ name, isDirectory: () => true }))
        : [],
  };
}

describe("resolveCursorExecutable", () => {
  it("resolves the bundle node.exe from the versions dir", () => {
    const exe = resolveCursorExecutable(
      "C:\\fake-local\\cursor-agent\\agent.cmd",
      bundleDeps(),
    );
    expect(exe).toBe(NODE_EXE);
  });

  it("ignores a foreign PATH `agent` (e.g. Grok) when no bundle exists", () => {
    const exe = resolveCursorExecutable("C:\\grok\\bin\\agent.exe", {
      env: { LOCALAPPDATA: "C:\\fake-local" },
      existsSyncImpl: () => true,
      readdirSyncImpl: () => [],
    });
    expect(exe).toBeNull();
  });

  it("accepts a direct node.exe path when its index.js exists", () => {
    const exe = resolveCursorExecutable(NODE_EXE, {
      env: { LOCALAPPDATA: "C:\\nonexistent" },
      existsSyncImpl: (p) => p === NODE_EXE || p === ENTRYPOINT,
      readdirSyncImpl: () => {
        throw new Error("ENOENT");
      },
    });
    expect(exe).toBe(NODE_EXE);
  });
});

describe("parseCursorAuthStatus", () => {
  it("classifies a browser-authenticated session", () => {
    const parsed = parseCursorAuthStatus({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "authenticated",
        isAuthenticated: true,
        hasAccessToken: true,
        hasRefreshToken: true,
        userInfo: { email: "user@example.com" },
      }),
      stderr: "",
    });
    expect(parsed.authState).toBe("AUTHENTICATED");
    expect(parsed.authMethod).toBe("CURSOR_BROWSER_ACCOUNT");
    expect(parsed.accountIdentity).toBe("user@example.com");
  });

  it("classifies unauthenticated JSON", () => {
    const parsed = parseCursorAuthStatus({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "unauthenticated",
        isAuthenticated: false,
        hasAccessToken: false,
        hasRefreshToken: false,
        message: "Not logged in",
      }),
      stderr: "",
    });
    expect(parsed.authState).toBe("NOT_AUTHENTICATED");
    expect(parsed.accountIdentity).toBeNull();
  });

  it("classifies partially-authenticated as REAUTH_REQUIRED", () => {
    const parsed = parseCursorAuthStatus({
      exitCode: 0,
      stdout: JSON.stringify({
        status: "partially-authenticated",
        isAuthenticated: false,
        hasAccessToken: true,
        hasRefreshToken: false,
      }),
      stderr: "",
    });
    expect(parsed.authState).toBe("REAUTH_REQUIRED");
  });

  it("is UNKNOWN on malformed output", () => {
    const parsed = parseCursorAuthStatus({
      exitCode: 0,
      stdout: "???",
      stderr: "",
    });
    expect(parsed.authState).toBe("UNKNOWN");
  });

  it("falls back to text parsing for non-JSON output", () => {
    const parsed = parseCursorAuthStatus({
      exitCode: 0,
      stdout: "Logged in as user@example.com\n",
      stderr: "",
    });
    expect(parsed.authState).toBe("AUTHENTICATED");
    expect(parsed.accountIdentity).toBe("user@example.com");
  });
});

describe("parseCursorModelList", () => {
  it("extracts model ids from the human-readable list", () => {
    const models = parseCursorModelList(
      "Available models:\n  auto\n  gpt-5\n  sonnet-4.5\n",
    );
    expect(models.map((m) => m.id)).toEqual(["auto", "gpt-5", "sonnet-4.5"]);
  });

  it("returns [] for decorative-only output", () => {
    expect(parseCursorModelList("No models available\n")).toEqual([]);
    expect(parseCursorModelList("")).toEqual([]);
  });
});

describe("parseCursorSmokeResult", () => {
  it("reads the JSON result shape", () => {
    const parsed = parseCursorSmokeResult({
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "VOCATRYA_CURSOR_OK",
      }),
    });
    expect(parsed.text).toBe("VOCATRYA_CURSOR_OK");
    expect(parsed.reportedError).toBe(false);
  });

  it("flags error results", () => {
    const parsed = parseCursorSmokeResult({
      stdout: JSON.stringify({ is_error: true, result: "x" }),
    });
    expect(parsed.reportedError).toBe(true);
  });
});

describe("extractLoginUrl", () => {
  it("extracts only cursor.com loginDeepControl URLs", () => {
    expect(
      cursorAdapter.extractLoginUrl(
        "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=x&uuid=y&mode=login&redirectTarget=cli",
      ),
    ).toBe(
      "https://cursor.com/loginDeepControl?challenge=x&uuid=y&mode=login&redirectTarget=cli",
    );
    expect(
      cursorAdapter.extractLoginUrl("https://evil.example.com/loginDeepControl?x=1"),
    ).toBeNull();
    expect(cursorAdapter.extractLoginUrl("no url here")).toBeNull();
  });
});

describe("writeManagedCursorConfig", () => {
  let dir;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-cfg-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes a deny-all allowlist config inside the managed config dir", () => {
    writeManagedCursorConfig(dir);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(dir, "config", "cli-config.json"), "utf8"),
    );
    expect(parsed.approvalMode).toBe("allowlist");
    expect(parsed.permissions.allow).toEqual([]);
    expect(parsed.permissions.deny).toContain("Shell(*)");
    expect(parsed.permissions.deny).toContain("Write(**)");
    expect(parsed.sandbox.mode).toBe("enabled");
  });

  it("re-enforces denies over CLI-mutated config", () => {
    const configDir = path.join(dir, "config");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "cli-config.json"),
      JSON.stringify({
        version: 1,
        permissions: { allow: ["Shell(*)"], deny: [] },
        approvalMode: "unrestricted",
        display: { mode: "zen" },
      }),
    );
    writeManagedCursorConfig(dir);
    const parsed = JSON.parse(
      fs.readFileSync(path.join(configDir, "cli-config.json"), "utf8"),
    );
    expect(parsed.permissions.allow).toEqual([]);
    expect(parsed.approvalMode).toBe("allowlist");
    // CLI-managed fields it owns are preserved.
    expect(parsed.display.mode).toBe("zen");
  });
});

describe("invocation builders", () => {
  it("prepends the bundle entrypoint to argv", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-inv-"));
    try {
      const inv = buildCursorLoginInvocation({
        executablePath: NODE_EXE,
        profileDir: dir,
        baseEnv: {},
      });
      expect(inv.args[0]).toBe(ENTRYPOINT);
      expect(inv.args.at(-1)).toBe("login");
      expect(inv.env.NO_OPEN_BROWSER).toBe("1");
      const smoke = buildCursorSmokeInvocation({
        executablePath: NODE_EXE,
        profileDir: dir,
        baseEnv: {},
        workingDirectory: dir,
        model: "auto",
      });
      const head = smoke.args.slice(1).join(" ");
      expect(head).toContain("-p");
      expect(head).toContain("--mode ask");
      expect(head).toContain("--sandbox enabled");
      expect(head).toContain("--model auto");
      expect(head).not.toContain("--force");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

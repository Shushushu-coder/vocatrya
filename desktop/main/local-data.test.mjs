import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_APP_DIR_NAME,
  buildDesktopFilesystemConfig,
  buildDesktopLayout,
  ensureDesktopLayout,
  resolveAndEnsureDesktopLayout,
  resolveDesktopDataRoot,
  toDesktopPrismaFileUrl,
} from "./local-data.js";
import { buildBackendEnvironment } from "./runtime.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
void HERE;

function makeTempRoot(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("desktop data root resolution", () => {
  it("prefers the internal test override and resolves to absolute", () => {
    const root = makeTempRoot("vocatrya-root-");
    const resolved = resolveDesktopDataRoot({ env: { VOCATRYA_DESKTOP_DATA_ROOT: root }, platform: "win32" });
    expect(path.isAbsolute(resolved)).toBe(true);
    expect(resolved).toBe(path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("trims override whitespace", () => {
    const root = makeTempRoot("vocatrya-trim-");
    const resolved = resolveDesktopDataRoot({
      env: { VOCATRYA_DESKTOP_DATA_ROOT: `  ${root}  ` },
      platform: "win32",
    });
    expect(resolved).toBe(path.resolve(root));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("defaults to the packaged local app-data product directory on Windows", () => {
    const base = path.join(os.tmpdir(), "LocalAppData");
    const resolved = resolveDesktopDataRoot({
      env: { LOCALAPPDATA: base },
      platform: "win32",
    });
    expect(resolved).toBe(path.join(path.resolve(base), DESKTOP_APP_DIR_NAME));
  });

  it("supports standard, spaced, and Unicode local app-data roots as pure paths", () => {
    const standard = "C:\\Users\\alice\\AppData\\Local";
    const spaced = "C:\\Users\\Test User\\AppData\\Local";
    const unicode = "C:\\Users\\\u6d4b\u8bd5\u7528\u6237\\AppData\\Local";
    expect(resolveDesktopDataRoot({ env: { LOCALAPPDATA: standard }, platform: "win32" })).toBe(
      path.join(path.resolve(standard), DESKTOP_APP_DIR_NAME),
    );
    const spacedResolved = resolveDesktopDataRoot({ env: { LOCALAPPDATA: spaced }, platform: "win32" });
    expect(spacedResolved).toContain("Test User");
    const unicodeResolved = resolveDesktopDataRoot({ env: { LOCALAPPDATA: unicode }, platform: "win32" });
    expect(unicodeResolved).toContain("\u6d4b\u8bd5\u7528\u6237");
  });

  it("fails closed without LOCALAPPDATA and never falls back to process.cwd()", () => {
    expect(() => resolveDesktopDataRoot({ env: {}, platform: "win32" })).toThrow(/LOCALAPPDATA/);
    try {
      resolveDesktopDataRoot({ env: {}, platform: "win32" });
    } catch (error) {
      expect(String(error.message)).not.toContain(process.cwd());
    }
  });

  it("requires the override on non-Windows platforms", () => {
    expect(() => resolveDesktopDataRoot({ env: {}, platform: "linux" })).toThrow(/VOCATRYA_DESKTOP_DATA_ROOT/);
  });
});

describe("desktop directory layout", () => {
  it("builds the stable seven-directory layout with database and secret paths", () => {
    const root = path.resolve(makeTempRoot("vocatrya-layout-"));
    const layout = buildDesktopLayout(root);
    expect(layout.root).toBe(root);
    for (const key of ["dataDir", "filesDir", "configDir", "logsDir", "backupsDir", "tmpDir", "electronDir"]) {
      expect(layout[key]).toBe(path.join(root, key.replace("Dir", "").toLowerCase() === "electron" ? "electron" : { data: "data", files: "files", config: "config", logs: "logs", backups: "backups", tmp: "tmp" }[key.replace("Dir", "")] ?? key));
      expect(path.isAbsolute(layout[key])).toBe(true);
    }
    expect(layout.databasePath).toBe(path.join(root, "data", "vocatrya.db"));
    expect(layout.secretStorePath).toBe(path.join(root, "config", "secrets.dat"));
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("creates every required directory on disk", () => {
    const root = makeTempRoot("vocatrya-ensure-");
    const layout = ensureDesktopLayout(buildDesktopLayout(path.resolve(root)));
    for (const key of ["dataDir", "filesDir", "configDir", "logsDir", "backupsDir", "tmpDir", "electronDir"]) {
      expect(fs.statSync(layout[key]).isDirectory()).toBe(true);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("resolves and ensures through the override end to end", () => {
    const root = makeTempRoot("vocatrya-e2e-");
    const layout = resolveAndEnsureDesktopLayout({ env: { VOCATRYA_DESKTOP_DATA_ROOT: root }, platform: process.platform });
    expect(fs.statSync(layout.dataDir).isDirectory()).toBe(true);
    expect(fs.statSync(layout.electronDir).isDirectory()).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("desktop Prisma file URL helper", () => {
  it("produces a Prisma file: URL with forward slashes", () => {
    const root = makeTempRoot("vocatrya-url-");
    const dbPath = path.join(root, "data", "vocatrya.db");
    const url = toDesktopPrismaFileUrl(dbPath);
    expect(url.startsWith("file:")).toBe(true);
    expect(url).toContain("vocatrya.db");
    expect(url).not.toContain("\\");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps spaces literal for spaced Windows roots", () => {
    const spaced = path.resolve(path.join(os.tmpdir(), "spaced root", "vocatrya.db"));
    const url = toDesktopPrismaFileUrl(spaced);
    expect(url.startsWith("file:")).toBe(true);
    expect(url).not.toContain("%20");
    expect(url).not.toContain("\\");
  });

  it("preserves Unicode segments without encoding", () => {
    const unicode = path.resolve(path.join(os.tmpdir(), "\u6d4b\u8bd5\u7528\u6237", "vocatrya.db"));
    const url = toDesktopPrismaFileUrl(unicode);
    expect(url).toContain("\u6d4b\u8bd5\u7528\u6237");
    expect(url.startsWith("file:")).toBe(true);
  });

  it("rejects empty database paths and resolves relatives absolutely", () => {
    expect(() => toDesktopPrismaFileUrl("")).toThrow(/non-empty/);
    expect(() => toDesktopPrismaFileUrl("   ")).toThrow(/non-empty/);
    const resolvedRelative = toDesktopPrismaFileUrl(path.join(os.tmpdir(), "rel-check.db"));
    expect(resolvedRelative.startsWith("file:")).toBe(true);
  });
});

describe("desktop filesystem config and backend wiring", () => {
  it("maps layout to database URL, uploads, logs, and secret store", () => {
    const root = path.resolve(makeTempRoot("vocatrya-config-"));
    const layout = buildDesktopLayout(root);
    const config = buildDesktopFilesystemConfig(layout);
    expect(config.databasePath).toBe(layout.databasePath);
    expect(config.databaseUrl).toBe(toDesktopPrismaFileUrl(layout.databasePath));
    expect(config.uploadsDir).toBe(layout.filesDir);
    expect(config.logDirectory).toBe(layout.logsDir);
    expect(config.secretStorePath).toBe(layout.secretStorePath);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("injects stable desktop paths into the backend child env", () => {
    const root = path.resolve(makeTempRoot("vocatrya-child-"));
    const layout = ensureDesktopLayout(buildDesktopLayout(root));
    const config = buildDesktopFilesystemConfig(layout);
    const env = buildBackendEnvironment({
      port: 41234,
      dataDir: layout.dataDir,
      baseEnv: {},
      secret: "test-auth-secret",
      encryptionKey: "test-encryption-key",
      uploadsDir: config.uploadsDir,
      databaseUrl: config.databaseUrl,
    });
    expect(env.DATABASE_URL).toBe(config.databaseUrl);
    expect(env.UPLOADS_DIR).toBe(config.uploadsDir);
    expect(env.ENCRYPTION_KEY).toBe("test-encryption-key");
    expect(env.AUTH_SECRET).toBe("test-auth-secret");
    expect(env.HOSTNAME).toBe("127.0.0.1");
    expect(env.NEXTAUTH_URL).toBe("http://127.0.0.1:41234");
    expect(env.MCP_ENABLED).toBe("false");
    expect(env.DATABASE_URL).not.toBe("file:/data");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("keeps logs outside the install directory and repo desktop folder", () => {
    const root = path.resolve(makeTempRoot("vocatrya-logs-"));
    const config = buildDesktopFilesystemConfig(buildDesktopLayout(root));
    expect(config.logDirectory).toBe(path.join(root, "logs"));
    expect(config.logDirectory.startsWith(root)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

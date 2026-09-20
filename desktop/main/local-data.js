// Vocatrya Windows desktop local-data foundation.
// Resolves the stable local-first data root, builds the directory layout,
// and produces backend filesystem configuration. No migration, backup,
// installer, or Career logic belongs here.
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_DATA_ROOT_ENV = "VOCATRYA_DESKTOP_DATA_ROOT";
const DESKTOP_APP_DIR_NAME = "Vocatrya";
const DESKTOP_DATABASE_FILE_NAME = "vocatrya.db";
const DESKTOP_SECRET_FILE_NAME = "secrets.dat";

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function assertAbsoluteWindowsLike(target, label) {
  if (!isNonEmptyString(target) || !path.isAbsolute(target)) {
    throw new Error(`${label} must be an absolute path`);
  }
}

// Packaged Windows default: %LOCALAPPDATA%\Vocatrya.
// An internal test/dev override (VOCATRYA_DESKTOP_DATA_ROOT) redirects the
// root without touching the real user profile. No process.cwd(), install
// directory, or roaming %APPDATA% fallback is permitted here.
function resolveDesktopDataRoot({ env = process.env, platform = process.platform } = {}) {
  const override = (env[DESKTOP_DATA_ROOT_ENV] || "").trim();
  if (override) {
    const resolved = path.resolve(override);
    assertAbsoluteWindowsLike(resolved, "Desktop data root override");
    return resolved;
  }
  if (platform === "win32") {
    const localAppData = (env.LOCALAPPDATA || "").trim();
    if (!localAppData) {
      throw new Error("LOCALAPPDATA is unavailable; cannot resolve the Vocatrya desktop data root");
    }
    const resolvedBase = path.resolve(localAppData);
    assertAbsoluteWindowsLike(resolvedBase, "LOCALAPPDATA");
    return path.join(resolvedBase, DESKTOP_APP_DIR_NAME);
  }
  throw new Error("Desktop data root requires VOCATRYA_DESKTOP_DATA_ROOT on non-Windows platforms");
}

function buildDesktopLayout(root) {
  assertAbsoluteWindowsLike(root, "Desktop data root");
  const dataDir = path.join(root, "data");
  const filesDir = path.join(root, "files");
  const configDir = path.join(root, "config");
  const logsDir = path.join(root, "logs");
  const backupsDir = path.join(root, "backups");
  const tmpDir = path.join(root, "tmp");
  const electronDir = path.join(root, "electron");
  return {
    root,
    dataDir,
    filesDir,
    configDir,
    logsDir,
    backupsDir,
    tmpDir,
    electronDir,
    databasePath: path.join(dataDir, DESKTOP_DATABASE_FILE_NAME),
    secretStorePath: path.join(configDir, DESKTOP_SECRET_FILE_NAME),
  };
}

function ensureDesktopLayout(layout) {
  for (const key of ["dataDir", "filesDir", "configDir", "logsDir", "backupsDir", "tmpDir", "electronDir"]) {
    fs.mkdirSync(layout[key], { recursive: true });
  }
  return layout;
}

function resolveAndEnsureDesktopLayout(options = {}) {
  const root = resolveDesktopDataRoot(options);
  return ensureDesktopLayout(buildDesktopLayout(root));
}

// Prisma Windows file URL helper. Produces file:<absolute-forward-slashes>
// for drive-letter and UNC roots, verified against disposable databases
// (including spaces and Unicode segments). No URL-encoding of spaces:
// Prisma expects the literal path with forward slashes.
function toDesktopPrismaFileUrl(filePath) {
  if (!isNonEmptyString(filePath)) {
    throw new Error("Database path must be a non-empty string");
  }
  const resolved = path.resolve(filePath);
  assertAbsoluteWindowsLike(resolved, "Database path");
  const forward = resolved.replaceAll("\\", "/");
  return `file:${forward}`;
}

function buildDesktopFilesystemConfig(layout) {
  return {
    databasePath: layout.databasePath,
    databaseUrl: toDesktopPrismaFileUrl(layout.databasePath),
    uploadsDir: layout.filesDir,
    logDirectory: layout.logsDir,
    secretStorePath: layout.secretStorePath,
  };
}

module.exports = {
  DESKTOP_APP_DIR_NAME,
  DESKTOP_DATA_ROOT_ENV,
  DESKTOP_DATABASE_FILE_NAME,
  DESKTOP_SECRET_FILE_NAME,
  buildDesktopFilesystemConfig,
  buildDesktopLayout,
  ensureDesktopLayout,
  resolveAndEnsureDesktopLayout,
  resolveDesktopDataRoot,
  toDesktopPrismaFileUrl,
};

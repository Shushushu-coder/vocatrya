// Vocatrya desktop device settings — a small app-owned JSON document under
// the desktop config root (packaged: %LOCALAPPDATA%\Vocatrya\config;
// development/POC: the disposable state root). Only device-scope preferences
// the app itself owns live here. State owned by the OS (login items) is read
// from and written to the OS and is never mirrored into this file.
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const DESKTOP_SETTINGS_FILE_NAME = "desktop-settings.json";

const DESKTOP_SETTINGS_KEYS = Object.freeze(["closeToTray", "startMinimized"]);

// Defaults keep pre-feature behavior: closing the window quits, launches
// open a visible window. Nothing changes for existing users until they opt in.
const DESKTOP_SETTINGS_DEFAULTS = Object.freeze({
  closeToTray: false,
  startMinimized: false,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

// Reads never fail closed on a damaged file: unknown keys are dropped and
// non-boolean values fall back to defaults, so a hand-edited file can never
// wedge the lifecycle into an unrecoverable state.
function sanitizeDesktopSettings(raw) {
  const settings = { ...DESKTOP_SETTINGS_DEFAULTS };
  if (!isPlainObject(raw)) return settings;
  for (const key of DESKTOP_SETTINGS_KEYS) {
    if (typeof raw[key] === "boolean") settings[key] = raw[key];
  }
  return settings;
}

function createDesktopSettingsStore({ filePath, fsImpl = fs } = {}) {
  if (typeof filePath !== "string" || !filePath.trim()) {
    throw new Error("Desktop settings file path is required");
  }
  let lastReadError = null;

  function read() {
    lastReadError = null;
    let raw;
    try {
      raw = fsImpl.readFileSync(filePath, "utf8");
    } catch (error) {
      if (!error || error.code !== "ENOENT") lastReadError = error;
      return { ...DESKTOP_SETTINGS_DEFAULTS };
    }
    try {
      return sanitizeDesktopSettings(JSON.parse(raw));
    } catch (error) {
      lastReadError = error;
      return { ...DESKTOP_SETTINGS_DEFAULTS };
    }
  }

  // Atomic write: a full document lands in place via rename, so a crash mid
  // write can never leave a truncated file behind. Write failures propagate —
  // callers must surface them instead of pretending the setting took effect.
  function update(patch) {
    if (!isPlainObject(patch)) {
      throw new Error("Desktop settings patch must be an object");
    }
    for (const key of Object.keys(patch)) {
      if (!DESKTOP_SETTINGS_KEYS.includes(key)) {
        throw new Error(`Unknown desktop setting: ${key}`);
      }
      if (typeof patch[key] !== "boolean") {
        throw new Error(`Desktop setting ${key} must be a boolean`);
      }
    }
    const next = { ...read(), ...patch };
    fsImpl.mkdirSync(path.dirname(filePath), { recursive: true });
    const temporary = `${filePath}.${process.pid}.tmp`;
    try {
      fsImpl.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      fsImpl.renameSync(temporary, filePath);
    } catch (error) {
      try {
        fsImpl.rmSync(temporary, { force: true });
      } catch {
        // The temporary file may never have been created.
      }
      throw error;
    }
    return next;
  }

  return {
    filePath,
    read,
    update,
    get lastReadError() {
      return lastReadError;
    },
  };
}

module.exports = {
  DESKTOP_SETTINGS_DEFAULTS,
  DESKTOP_SETTINGS_FILE_NAME,
  DESKTOP_SETTINGS_KEYS,
  createDesktopSettingsStore,
  sanitizeDesktopSettings,
};

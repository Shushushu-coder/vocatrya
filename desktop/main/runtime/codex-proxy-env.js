// Codex reads proxy variables from `$CODEX_HOME/.env`. Vocatrya points
// CODEX_HOME at a managed profile, so the user-level file
// `%USERPROFILE%\.codex\.env` is no longer visible to the child. The
// managed child still needs those supported proxy variables. Process env
// wins when it already has a value. Only the proxy keys below are copied.
// The user file is never modified.
const fs = require("node:fs");
const path = require("node:path");

const CODEX_PROXY_ENV_KEYS = Object.freeze([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

const PROXY_ENV_KEY_SET = new Set(CODEX_PROXY_ENV_KEYS);

function userCodexDotenvPath(baseEnv) {
  const profile = baseEnv && baseEnv.USERPROFILE;
  if (typeof profile !== "string" || profile.length === 0) return null;
  return path.join(profile, ".codex", ".env");
}

function parseCodexProxyDotenv(text) {
  const parsed = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!PROXY_ENV_KEY_SET.has(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!value || /[\r\n]/.test(value)) continue;
    parsed[key] = value;
  }
  return parsed;
}

function loadCodexUserProxyEnv(
  baseEnv,
  { readFileSyncImpl = fs.readFileSync, dotenvPath } = {},
) {
  const filePath = dotenvPath === undefined ? userCodexDotenvPath(baseEnv) : dotenvPath;
  if (!filePath) return {};
  let text;
  try {
    text = readFileSyncImpl(filePath, "utf8");
  } catch {
    return {};
  }
  if (typeof text !== "string") return {};
  return parseCodexProxyDotenv(text);
}

// Fills proxy keys that the managed environment does not already have.
// Existing process-env values are left untouched.
function applyCodexProxyEnv(env, baseEnv, options) {
  const fromFile = loadCodexUserProxyEnv(baseEnv, options);
  const next = { ...env };
  for (const key of CODEX_PROXY_ENV_KEYS) {
    if (typeof next[key] === "string" && next[key]) continue;
    if (typeof fromFile[key] === "string" && fromFile[key]) {
      next[key] = fromFile[key];
    }
  }
  return next;
}

module.exports = {
  CODEX_PROXY_ENV_KEYS,
  applyCodexProxyEnv,
  loadCodexUserProxyEnv,
  parseCodexProxyDotenv,
  userCodexDotenvPath,
};

// Codex binary discovery + selection. A machine can hold several Codex CLIs
// (standalone installer, npm global vendor binary, stale npm staging dirs); the
// native-session gate is exact-version, so the binary the app uses must be the
// newest VERIFIED one, not merely the first on a fixed precedence list. Reads
// are existence checks + bounded `--version` probes only: no disk scans, no
// deletes. Today's precedence (registry knownLocations, then PATH order) stays
// as the tiebreaker and as the fallback when nothing is verified.
const fs = require("node:fs");
const path = require("node:path");
const { NATIVE_VERIFIED_VERSIONS } = require("./native-session");

const MAX_CANDIDATES = 8;
const DISCOVERY_TTL_MS = 15_000;
const NPM_VENDOR_REL = path.win32.join("node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");

const probeCache = new Map(); // path|mtime|size -> successful probe version
let discoveryCache = null; // production only: { at, result }

function invalidateCodexDiscovery() { discoveryCache = null; }

const keyOf = (p) => path.resolve(p).toLowerCase();
const isNpmPath = (p) => /[\\/]npm[\\/]/i.test(p);
function sourceKind(p) {
  if (/[\\/]Programs[\\/]OpenAI[\\/]Codex[\\/]/i.test(p)) return "standalone";
  if (isNpmPath(p)) return "npm";
  return "path";
}

function lookupAllOnPath(command, { platform, env, spawnSyncImpl }) {
  try {
    const result = spawnSyncImpl(platform === "win32" ? "where.exe" : "which", [command], { encoding: "utf8", windowsHide: true, timeout: 5_000, env });
    if (result.status !== 0 || !result.stdout) return [];
    return result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch { return []; }
}

function probeCached(executable, definition, { env, spawnSyncImpl, statSyncImpl }) {
  const { probeRuntimeVersion } = require("./detector");
  let key = null;
  try { const s = statSyncImpl(executable); key = `${keyOf(executable)}|${s.mtimeMs}|${s.size}`; } catch { /* uncacheable */ }
  if (key && probeCache.has(key)) return { version: probeCache.get(key), ok: true };
  const probe = probeRuntimeVersion(executable, definition, { env, spawnSyncImpl });
  if (key && probe.ok && probe.version) probeCache.set(key, probe.version);
  return probe;
}

// Every distinct, spawnable Codex binary this machine exposes, in precedence
// order, each probed once (cached by path+mtime+size). Stale = an npm staging
// dir (`@openai\.codex-*`, an interrupted/leftover install): shown, never used.
function discoverCodexInstalls(definition, deps = {}) {
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const spawnSyncImpl = deps.spawnSyncImpl || require("node:child_process").spawnSync;
  const existsSyncImpl = deps.existsSyncImpl || fs.existsSync;
  const readdirSyncImpl = deps.readdirSyncImpl || fs.readdirSync;
  const statSyncImpl = deps.statSyncImpl || fs.statSync;
  const { expandKnownLocation } = require("./detector");
  const { resolveCodexExecutable } = require("./codex");

  const raw = [];
  for (const candidate of definition.binaries || []) {
    for (const known of candidate.knownLocations || []) {
      const expanded = expandKnownLocation(known, env);
      if (!expanded.includes("{") && existsSyncImpl(expanded)) raw.push(path.resolve(expanded));
    }
    for (const command of candidate.commands || []) raw.push(...lookupAllOnPath(command, { platform, env, spawnSyncImpl }));
  }
  const seen = new Set();
  const installs = [];
  const npmRoots = new Set();
  const add = (executable, stale = false, source = null) => {
    if (!executable || installs.length >= MAX_CANDIDATES) return;
    const key = keyOf(executable);
    if (seen.has(key)) return;
    seen.add(key);
    installs.push({ path: executable, source: source || sourceKind(executable), stale, order: installs.length });
  };
  for (const hit of raw) {
    // npm PATH shims (codex / codex.cmd) are not spawnable with shell:false:
    // unwrap them to the vendored codex.exe next to them.
    if (!/\.exe$/i.test(hit) && isNpmPath(hit)) npmRoots.add(path.dirname(hit));
    const executable = /\.exe$/i.test(hit) ? hit : resolveCodexExecutable(hit, { existsSyncImpl, readdirSyncImpl }) || hit; // unresolved shim stays a (non-working) candidate
    if (executable) { add(executable); if (isNpmPath(executable)) { const m = /^(.*[\\/]npm)[\\/]node_modules[\\/]/i.exec(executable); if (m) npmRoots.add(m[1]); } }
  }
  for (const root of npmRoots) {
    const scope = path.join(root, "node_modules", "@openai");
    let entries = [];
    try { entries = readdirSyncImpl(scope, { withFileTypes: true }); } catch { /* no npm scope */ }
    for (const entry of entries) {
      if (!entry.isDirectory?.() || !entry.name.startsWith(".codex-")) continue;
      const staged = path.join(scope, entry.name, NPM_VENDOR_REL);
      if (existsSyncImpl(staged)) add(staged, true, "npm-staging");
    }
  }
  const verified = deps.verifiedVersions || NATIVE_VERIFIED_VERSIONS;
  for (const install of installs) {
    const probe = probeCached(install.path, definition, { env, spawnSyncImpl, statSyncImpl });
    install.ok = probe.ok === true;
    install.version = probe.ok ? probe.version ?? null : null;
    install.verified = install.version !== null && verified.includes(install.version);
  }
  return installs;
}

// Per-purpose selection over one discovered list (stale is never chosen).
//   default  today's precedence: first working non-stale install (else the first
//            non-stale one, which reports BROKEN). Login, auth probe, update
//            check/apply: login state lives in CODEX_HOME so any binary will do,
//            and update flows describe the install the user actually runs.
//   native   newest VERIFIED version (list order = oldest to newest), precedence
//            as tiebreaker; nothing verified -> default, so the gate fails closed.
//   exec     streaming/structured exec is pinned to one capability-verified
//            version: the working install at exactly `version`; none -> default,
//            so the existing gate still decides.
function selectCodexInstall(installs, verifiedVersions = NATIVE_VERIFIED_VERSIONS, purpose = "default", version = null) {
  const live = installs.filter((i) => !i.stale);
  const def = live.find((i) => i.ok) || live[0] || null;
  if (purpose === "native") {
    const rank = (i) => verifiedVersions.indexOf(i.version);
    return live.filter((i) => i.ok && i.version && verifiedVersions.includes(i.version))
      .sort((a, b) => rank(b) - rank(a) || a.order - b.order)[0] || def;
  }
  if (purpose === "exec") return (version && live.find((i) => i.ok && i.version === version)) || def;
  return def;
}

const PURPOSES = ["default", "native", "exec"];
function streamingTarget() {
  try { return require("./capabilities").getAccountRuntimeCapabilities("CODEX_RUNTIME")?.execution?.streamingVerifiedRuntimeVersion ?? null; } catch { return null; }
}

// -> { installs: [{path, source, version, verified, stale, selected, selectedFor}],
//      selections: {default, native, exec}, selected (= default), verifiedVersions }
// `selected` = the default (login/update) choice; selectedFor lists every purpose
// an install was chosen for.
function resolveCodexInstalls(definition, deps = {}) {
  const production = !deps.spawnSyncImpl && !deps.existsSyncImpl;
  if (production && discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) return discoveryCache.result;
  const verifiedVersions = [...(deps.verifiedVersions || NATIVE_VERIFIED_VERSIONS)];
  const target = deps.streamingVersion !== undefined ? deps.streamingVersion : streamingTarget();
  const all = discoverCodexInstalls(definition, deps);
  const selections = {};
  for (const purpose of PURPOSES) selections[purpose] = selectCodexInstall(all, verifiedVersions, purpose, target);
  const result = {
    selected: selections.default,
    selections,
    verifiedVersions,
    installs: all.map((i) => {
      const selectedFor = PURPOSES.filter((p) => selections[p] === i);
      return { path: i.path, source: i.source, version: i.version, verified: i.verified, stale: i.stale, selected: selectedFor.includes("default"), selectedFor };
    }),
  };
  if (production) discoveryCache = { at: Date.now(), result };
  return result;
}

module.exports = { discoverCodexInstalls, selectCodexInstall, resolveCodexInstalls, invalidateCodexDiscovery };

// Phase C RuntimeDetector + RuntimeVersionProbe — safe, read-only binary
// discovery for the seven managed runtimes.
//
// Detection order: registry-declared known install locations (existence
// check only) → PATH lookup via where.exe (Windows) / which (POSIX). No disk
// scans, no registry reads, no user-directory crawls.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getRuntimeDefinition } = require("./registry");

const PATH_LOOKUP_TIMEOUT_MS = 5_000;
const VERSION_PROBE_TIMEOUT_MS = 10_000;

function expandKnownLocation(template, env) {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name) => {
    const value = env?.[name];
    return typeof value === "string" && value.length > 0 ? value : match;
  });
}

function resolvePathLookupCommand(platform) {
  return platform === "win32" ? "where.exe" : "which";
}

function lookupOnPath(command, { platform, env, spawnSyncImpl }) {
  const lookup = resolvePathLookupCommand(platform);
  try {
    const result = spawnSyncImpl(lookup, [command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: PATH_LOOKUP_TIMEOUT_MS,
      env,
    });
    if (result.status !== 0 || !result.stdout) return null;
    const first = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)[0];
    return first || null;
  } catch {
    return null;
  }
}

// Returns the first resolvable executable path for the definition, or null.
function findRuntimeExecutable(definition, { platform, env, spawnSyncImpl, existsSyncImpl }) {
  for (const candidate of definition.binaries || []) {
    for (const known of candidate.knownLocations || []) {
      const expanded = expandKnownLocation(known, env);
      if (expanded.includes("{")) continue; // unresolved placeholder
      if (existsSyncImpl(expanded)) return path.resolve(expanded);
    }
    for (const command of candidate.commands || []) {
      const found = lookupOnPath(command, { platform, env, spawnSyncImpl });
      if (found) return found;
    }
  }
  return null;
}

// Some runtimes install as a versioned interpreter bundle rather than a
// spawnable executable: the PATH/knownLocation hits are launcher shims
// that dispatch into `versions/<ver>/<interpreter> <entrypoint>`
// (cursor-agent → versions/<YYYY.MM.DD-sha>/node.exe index.js). For those
// definitions the real binary is resolved by scanning the bundle's
// versions directory — authoritative for both detection and identity, so
// an unrelated PATH binary with a colliding command name (e.g. Grok's
// agent.exe) is never mistaken for this runtime.
function resolveRuntimeBundle(
  definition,
  env,
  { existsSyncImpl, readdirSyncImpl } = {},
) {
  const bundle = definition?.bundle;
  if (!bundle || bundle.kind !== "node-versions") return null;
  const exists = existsSyncImpl || fs.existsSync;
  const readdir = readdirSyncImpl || fs.readdirSync;
  const versionsDir = expandKnownLocation(
    bundle.versionsDir,
    env || process.env,
  );
  if (versionsDir.includes("{")) return null;
  const dirPattern = new RegExp(bundle.versionDirPattern || ".");
  let entries;
  try {
    entries = readdir(versionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const versions = entries
    .filter((entry) => entry.isDirectory?.() && dirPattern.test(entry.name))
    .map((entry) => entry.name)
    // Version dir names start YYYY.MM.DD — lexicographic order is
    // chronological order, so the newest bundle sorts last.
    .sort()
    .reverse();
  for (const version of versions) {
    const dir = path.join(versionsDir, version);
    const executable = path.join(dir, bundle.interpreter);
    const entrypoint = path.join(dir, bundle.entrypoint);
    if (exists(executable) && exists(entrypoint)) {
      return { executable, entrypoint, versionDir: dir, bundleVersion: version };
    }
  }
  return null;
}

// argv prefix for a resolved bundle executable: `[entrypoint]` when the
// definition declares a bundle, else []. Callers spawning a resolved
// bundle binary (version probe, auth probe, adapter invocations) must
// prepend this so `node.exe <entrypoint> <args>` is the real CLI call.
function bundleEntrypointArgs(definition, executablePath) {
  const bundle = definition?.bundle;
  if (!bundle || !bundle.entrypoint || !executablePath) return [];
  return [path.join(path.dirname(executablePath), bundle.entrypoint)];
}

function parseVersionFromOutput(output) {
  if (typeof output !== "string") return null;
  const match = output.match(/\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

// Read-only version probe: runs the detected binary with the definition's
// version args and a bounded timeout. Never logs raw output.
function probeRuntimeVersion(
  executablePath,
  definition,
  { env, spawnSyncImpl, argsPrefix },
) {
  const args = [
    ...(Array.isArray(argsPrefix) ? argsPrefix : []),
    ...(definition.versionProbe?.args || ["--version"]),
  ];
  const result = spawnSyncImpl(executablePath, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: VERSION_PROBE_TIMEOUT_MS,
    env,
    shell: false,
  });
  if (result.error || result.status === null) {
    return { version: null, ok: false };
  }
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  const version = parseVersionFromOutput(output);
  // Identity guard for bundle runtimes: a PATH name collision (e.g.
  // `agent` resolving to a different product) must not be reported as a
  // healthy install of this runtime.
  const identityPattern = definition.bundle?.versionDirPattern;
  if (
    result.status === 0 &&
    identityPattern &&
    version &&
    !new RegExp(identityPattern).test(version)
  ) {
    return { version: null, ok: false, code: "IDENTITY_MISMATCH" };
  }
  return { version, ok: result.status === 0 };
}

// detectRuntime(backendKind, deps) →
//   { backendKind, runtimeVendor, state, installed, executablePath?, version? }
// state ∈ NOT_INSTALLED | READY | UPDATE_AVAILABLE | BROKEN
// The synchronous local probe never produces UPDATE_AVAILABLE — that
// verdict is computed by update-check.js's online comparison, which
// reports it as effectiveState on top of this local state.
function detectRuntime(backendKind, deps = {}) {
  const definition = getRuntimeDefinition(backendKind);
  if (!definition) {
    throw new Error(`Unknown runtime backendKind: ${backendKind}`);
  }
  const platform = deps.platform || process.platform;
  const env = deps.env || process.env;
  const spawnSyncImpl = deps.spawnSyncImpl || spawnSync;
  const existsSyncImpl = deps.existsSyncImpl || fs.existsSync;

  let executablePath = null;
  let argsPrefix;
  if (definition.bundle) {
    // The bundle's versions dir is the authoritative install location;
    // PATH/knownLocation hits are launcher shims that are not spawnable
    // (shell:false) and may belong to a different product entirely.
    const bundle = resolveRuntimeBundle(definition, env, {
      existsSyncImpl,
      readdirSyncImpl: deps.readdirSyncImpl,
    });
    if (!bundle) {
      return {
        backendKind,
        runtimeVendor: definition.runtimeVendor,
        state: "NOT_INSTALLED",
        installed: false,
      };
    }
    executablePath = bundle.executable;
    argsPrefix = [bundle.entrypoint];
  } else {
    executablePath = findRuntimeExecutable(definition, {
      platform,
      env,
      spawnSyncImpl,
      existsSyncImpl,
    });
    if (!executablePath) {
      return {
        backendKind,
        runtimeVendor: definition.runtimeVendor,
        state: "NOT_INSTALLED",
        installed: false,
      };
    }
  }

  const version = probeRuntimeVersion(executablePath, definition, {
    env,
    spawnSyncImpl,
    argsPrefix,
  });
  if (!version.ok && version.code === "IDENTITY_MISMATCH") {
    return {
      backendKind,
      runtimeVendor: definition.runtimeVendor,
      state: "NOT_INSTALLED",
      installed: false,
    };
  }
  if (!version.ok) {
    return {
      backendKind,
      runtimeVendor: definition.runtimeVendor,
      state: "BROKEN",
      installed: true,
      executablePath,
    };
  }
  return {
    backendKind,
    runtimeVendor: definition.runtimeVendor,
    state: "READY",
    installed: true,
    executablePath,
    version: version.version,
  };
}

module.exports = {
  bundleEntrypointArgs,
  detectRuntime,
  expandKnownLocation,
  findRuntimeExecutable,
  parseVersionFromOutput,
  probeRuntimeVersion,
  resolveRuntimeBundle,
};

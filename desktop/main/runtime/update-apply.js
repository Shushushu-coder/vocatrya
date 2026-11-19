// One-click runtime update execution — the audited write counterpart of
// update-check.js's read-only report. Execution is deliberately narrow:
// the renderer picks a backendKind (registry-keyed) and a target enum
// ("latest" | "required"); every executable, package name, and version is
// resolved here from registry constants and capability data — never from
// renderer-supplied strings.
//
// Flavors:
//   npm-global  — the detected binary lives under the user's npm prefix
//                 (…\npm\… or …/npm/…). `npm install -g <pkg>@<ver>` pins
//                 either target deterministically (the registry's own
//                 declared recovery path for codex/claude).
//   self-update — a spawnable vendor binary runs its declared built-in
//                 updater (`codex update`, …) which always tracks latest;
//                 it can also repair a BROKEN install. It cannot pin a
//                 required version — that target reports MANUAL_REQUIRED.
//   unknown     — nothing honest can be executed; MANUAL_REQUIRED.
//
// Results never echo raw stderr verbatim beyond a short sanitized tail —
// npm failures (EPERM/registry errors) are the actionable part users see.
const { getRuntimeDefinition } = require("./registry");
const { getAccountRuntimeCapabilities } = require("./capabilities");
const { detectRuntime } = require("./detector");
const { invalidateCodexDiscovery } = require("./codex-install");
const { collectCertifiedVersions } = require("./update-check");
const { runRuntimeCommand } = require("./runner");

const APPLY_TARGETS = Object.freeze(["latest", "required"]);
const DEFAULT_APPLY_TIMEOUT_MS = 180_000;
const STDERR_TAIL_CHARS = 300;

function fail(code, extra = {}) {
  return { ok: false, code, ...extra };
}

// A path segment "npm" marks a user-level npm global install — covers both
// the .cmd shim and the vendored binary inside node_modules.
function isNpmGlobalPath(executablePath) {
  if (typeof executablePath !== "string") return false;
  return /[\\/]npm[\\/]/.test(executablePath) || /[\\/]npm$/.test(executablePath);
}

// The pinned package name comes only from registry-declared update data —
// the npm-pin recovery block first, then the npm-latest check source.
function npmPackageFor(definition) {
  const recovery = definition.update?.recovery;
  if (recovery?.kind === "npm-pin" && typeof recovery.package === "string") {
    return recovery.package;
  }
  const check = definition.update?.check;
  if (check?.kind === "npm-latest" && typeof check.package === "string") {
    return check.package;
  }
  return null;
}

// "required" = the strictest version the app's capabilities certify.
// Codex's native-session gate is the only strict runtime requirement so
// far; other backends fall back to their capability-certified version.
function requiredVersionFor(backendKind) {
  if (backendKind === "CODEX_RUNTIME") {
    // native-session.js is a leaf module (runner only) — no cycle.
    return require("./native-session").NATIVE_VERSION;
  }
  const certified = collectCertifiedVersions(
    getAccountRuntimeCapabilities(backendKind),
  );
  return certified[0] ?? null;
}

// The npm channel is usable when the selected binary is npm-global, or (pinned
// "required" target only) when any live discovered install is — the pin then
// lands as an npm vendor binary the selection prefers once it is verified.
function hasNpmInstall(detected) {
  return Array.isArray(detected.installs) && detected.installs.some((i) => i.source === "npm" && !i.stale);
}

// What the settings surface may offer as executable targets — detection
// only, nothing runs. Mirrors the rules applyRuntimeUpdate enforces.
function applySupportFor(definition, detected) {
  const npmPackage = npmPackageFor(definition);
  const executable = detected.executablePath ?? null;
  const spawnable =
    typeof executable === "string" && executable.length > 0 && !executable.toLowerCase().endsWith(".cmd") && !executable.toLowerCase().endsWith(".bat");
  const npmGlobal = isNpmGlobalPath(executable);
  const selfUpdate = definition.update?.methods?.some(
    (m) => m?.kind === "self-update",
  );
  return {
    flavor: npmGlobal ? "npm-global" : spawnable ? "self-update" : "unknown",
    canLatest: Boolean(npmGlobal && npmPackage) || Boolean(spawnable && selfUpdate),
    canRequired: Boolean((npmGlobal || hasNpmInstall(detected)) && npmPackage),
  };
}

function createRuntimeUpdateApplier(deps = {}) {
  const env = deps.env || process.env;
  const runCommand =
    deps.runCommand ||
    ((input) => runRuntimeCommand({ ...input, spawnImpl: deps.spawnImpl }));
  const timeoutMs = deps.applyTimeoutMs ?? DEFAULT_APPLY_TIMEOUT_MS;
  // One update per backend at a time — a second click while npm is still
  // resolving is refused, not queued.
  const inFlight = new Set();

  async function applyRuntimeUpdate(backendKind, { target = "latest" } = {}) {
    const definition = getRuntimeDefinition(backendKind);
    if (!definition) {
      const error = new Error(`Unknown runtime backendKind: ${backendKind}`);
      error.code = "UNKNOWN_BACKEND_KIND";
      throw error;
    }
    if (!APPLY_TARGETS.includes(target)) {
      const error = new Error(`Unknown update target: ${target}`);
      error.code = "UNKNOWN_UPDATE_TARGET";
      throw error;
    }
    if (inFlight.has(backendKind)) return fail("IN_PROGRESS");
    inFlight.add(backendKind);
    try {
      invalidateCodexDiscovery();
      const detected = detectRuntime(backendKind, deps);
      const executable = detected.executablePath ?? null;
      const npmPackage = npmPackageFor(definition);
      const npmGlobal = isNpmGlobalPath(executable) || (target === "required" && hasNpmInstall(detected));
      const spawnable =
        typeof executable === "string" &&
        executable.length > 0 &&
        !executable.toLowerCase().endsWith(".cmd") &&
        !executable.toLowerCase().endsWith(".bat");

      let version = null;
      if (target === "required") {
        version = requiredVersionFor(backendKind);
        if (!version) return fail("NO_TARGET");
      }

      let run;
      if (npmGlobal && npmPackage) {
        const spec = `${npmPackage}@${version ?? "latest"}`;
        // cmd.exe resolves npm(.cmd) on PATH; package+version come from
        // registry/certification constants — the only interpolated parts.
        run = await runCommand({
          executable: "cmd.exe",
          args: ["/d", "/s", "/c", "npm", "install", "-g", spec],
          env,
          timeoutMs,
        });
      } else if (spawnable && target === "latest") {
        const method = definition.update?.methods?.find(
          (m) => m?.kind === "self-update",
        );
        if (!method) return fail("MANUAL_REQUIRED");
        run = await runCommand({
          executable,
          args: method.args.slice(),
          env,
          timeoutMs,
        });
      } else {
        // Standalone/unknown flavor, or a pinned target with no npm path.
        return fail("MANUAL_REQUIRED");
      }

      if (run.timedOut) return fail("UPDATE_TIMEOUT");
      if (run.error || run.exitCode !== 0) {
        const stderrTail =
          typeof run.stderr === "string" && run.stderr.trim().length > 0
            ? run.stderr.trim().slice(-STDERR_TAIL_CHARS)
            : null;
        return fail("UPDATE_FAILED", {
          exitCode: run.exitCode ?? null,
          stderrTail,
        });
      }
      // Honest completion: re-probe the installed version after the run —
      // a 0 exit is not proof the expected binary landed.
      invalidateCodexDiscovery();
      const after = detectRuntime(backendKind, deps);
      // A pinned "required" install is judged by the binary native sessions
      // will run (selected per purpose), not the login/default one.
      const pinned = target === "required" ? after.installs?.find((i) => i.selectedFor?.includes("native")) : null;
      return {
        ok: true,
        backendKind,
        target,
        version: pinned?.version ?? after.version ?? null,
        state: after.state,
      };
    } finally {
      inFlight.delete(backendKind);
    }
  }

  return { applyRuntimeUpdate, applySupportFor };
}

module.exports = {
  APPLY_TARGETS,
  createRuntimeUpdateApplier,
  isNpmGlobalPath,
  requiredVersionFor,
  applySupportFor,
};

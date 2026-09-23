// Phase C RuntimeStatusService — thin facade over the registry, detector,
// profile manager, and auth probe. This is the object the Electron IPC
// boundary talks to; it exposes ONLY registry-driven operations, never a
// generic "run this command" surface.
const {
  getRuntimeDefinition,
  isRegisteredBackendKind,
  listRuntimeDefinitions,
} = require("./registry");
const { detectRuntime } = require("./detector");
const { probeRuntimeAuthState } = require("./auth-probe");
const { RuntimeProfileManager } = require("./profiles");
const {
  getAccountRuntimeCapabilities,
} = require("./capabilities");

function summarizeDefinition(definition) {
  return {
    backendKind: definition.backendKind,
    runtimeVendor: definition.runtimeVendor,
    supportedAccountProviders: definition.supportedAccountProviders.slice(),
    displayName: definition.displayName,
    profileStrategy: definition.profile.strategy,
    // The consolidated capability descriptor — the UI and any future
    // execution surface read capabilities ONLY from here, never by
    // branching on backendKind.
    capabilities: getAccountRuntimeCapabilities(definition.backendKind),
  };
}

// createRuntimeStatusService({ profilesRoot, deps })
// deps are injected for tests: { platform, env, spawnSyncImpl, existsSyncImpl, runner }
function createRuntimeStatusService({ profilesRoot, deps = {} } = {}) {
  const profileManager = new RuntimeProfileManager({ profilesRoot });

  function assertKnown(backendKind) {
    if (!isRegisteredBackendKind(backendKind)) {
      const error = new Error(`Unknown runtime backendKind: ${backendKind}`);
      error.code = "UNKNOWN_BACKEND_KIND";
      throw error;
    }
  }

  return {
    profileManager,

    listRuntimes() {
      return listRuntimeDefinitions().map(summarizeDefinition);
    },

    detectRuntime(backendKind) {
      assertKnown(backendKind);
      return detectRuntime(backendKind, deps);
    },

    getRuntimeVersion(backendKind) {
      const detected = this.detectRuntime(backendKind);
      return {
        backendKind,
        installed: detected.installed,
        version: detected.version ?? null,
        state: detected.state,
      };
    },

    // Composite status: install state + optional auth probe when a managed
    // profile is supplied. Runtime state and AIConnection.status stay
    // separate by design — this service reports runtime truth only.
    async getRuntimeStatus(backendKind, { runtimeProfileRef } = {}) {
      // Validate the ref before anything else — a malformed or traversal-
      // shaped ref is a bad request even when the runtime is not installed.
      const profileDir = runtimeProfileRef
        ? profileManager.resolveProfileDir(runtimeProfileRef)
        : null;
      const detected = this.detectRuntime(backendKind);
      const status = { ...detected, authState: null };
      if (!detected.installed || !profileDir) return status;
      if (!profileManager.profileExists(runtimeProfileRef)) {
        status.authState = "UNKNOWN";
        return status;
      }
      const probe = await probeRuntimeAuthState({
        backendKind,
        executablePath: detected.executablePath,
        profileDir,
        baseEnv: deps.env,
        runner: deps.runner,
        spawnImpl: deps.spawnImpl,
        terminateImpl: deps.terminateImpl,
      });
      status.authState = probe.authState;
      return status;
    },

    // The consolidated capability descriptor for one runtime — the unified
    // query entry for Settings and future execution surfaces.
    getRuntimeCapabilities(backendKind) {
      assertKnown(backendKind);
      return getAccountRuntimeCapabilities(backendKind);
    },

    // Structured install/update metadata only. Phase C does not execute
    // installers — executionEnabled stays false until a dedicated, audited
    // installer service lands.
    getInstallInfo(backendKind) {
      assertKnown(backendKind);
      const definition = getRuntimeDefinition(backendKind);
      return {
        backendKind,
        executionEnabled: false,
        methods: definition.install.methods,
      };
    },

    getUpdateInfo(backendKind) {
      assertKnown(backendKind);
      const definition = getRuntimeDefinition(backendKind);
      return {
        backendKind,
        executionEnabled: false,
        methods: definition.update.methods,
      };
    },
  };
}

module.exports = { createRuntimeStatusService };

// Phase D/E AIConnection orchestrator — the only place account-login
// operations are coordinated.
//
// Boundaries this module enforces:
// - The renderer supplies ONLY {backendKind|connectionId, ticket, model?}.
//   Tickets are single-use proofs minted by an authenticated backend action;
//   they bind the userId (and for connection ops, the connectionId) so the
//   renderer can never drive operations on someone else's connection.
// - The provider runtime owns authentication. We spawn the vendor's
//   documented login/logout/status/print commands inside the managed
//   profile env and never read credential files.
// - AIConnection rows are mutated ONLY by the backend through the internal
//   loopback client, after the runtime verified the outcome.
// - Every spawned process goes through runRuntimeCommand: shell:false,
//   capped output, timeout/abort support, sanitized capture.
//
// Phase E refactor: provider specifics live behind a small adapter
// contract (codex.js / claude.js). This module coordinates tickets,
// guards, pending profiles, and outcome reporting — it contains no
// provider-specific command knowledge.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getRuntimeDefinition } = require("./registry");
const { findRuntimeExecutable, probeRuntimeVersion } = require("./detector");
const { runRuntimeCommand } = require("./runner");
const { RuntimeProfileManager } = require("./profiles");
const { AUTH_PROBE_TIMEOUT_MS } = require("./auth-probe");
const { CODEX_BACKEND_KIND, codexAdapter } = require("./codex");
const { CLAUDE_BACKEND_KIND, claudeAdapter } = require("./claude");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // browser auth is user-paced
const LOGOUT_TIMEOUT_MS = 30 * 1000;
const MODELS_TIMEOUT_MS = 20 * 1000;
const SMOKE_TIMEOUT_MS = 120 * 1000;

// Implemented account-login providers. Each adapter owns its login guard
// key (`<vendor>:login`) so a login process per provider can run in
// parallel while same-provider logins stay serialized — the CLIs bind
// fixed local callback resources that would otherwise collide.
const PROVIDER_ADAPTERS = Object.freeze({
  [CODEX_BACKEND_KIND]: codexAdapter,
  [CLAUDE_BACKEND_KIND]: claudeAdapter,
});

const CONNECTION_OP_CODES = Object.freeze({
  RUNTIME_NOT_INSTALLED: "RUNTIME_NOT_INSTALLED",
  RUNTIME_BROKEN: "RUNTIME_BROKEN",
  LOGIN_ALREADY_IN_PROGRESS: "LOGIN_ALREADY_IN_PROGRESS",
  LOGIN_CANCELLED: "LOGIN_CANCELLED",
  LOGIN_TIMEOUT: "LOGIN_TIMEOUT",
  LOGIN_FAILED: "LOGIN_FAILED",
  AUTH_NOT_CONFIRMED: "AUTH_NOT_CONFIRMED",
  AUTH_METHOD_UNVERIFIED: "AUTH_METHOD_UNVERIFIED",
  UNSUPPORTED_AUTH_METHOD: "UNSUPPORTED_AUTH_METHOD",
  PROVIDER_POLICY_RESTRICTED: "PROVIDER_POLICY_RESTRICTED",
  REAUTH_REQUIRED: "REAUTH_REQUIRED",
  ACCOUNT_IDENTITY_CONFLICT: "ACCOUNT_IDENTITY_CONFLICT",
  CONNECTION_NOT_FOUND: "CONNECTION_NOT_FOUND",
  CONNECTION_ARCHIVED: "CONNECTION_ARCHIVED",
  MODEL_DISCOVERY_UNAVAILABLE: "MODEL_DISCOVERY_UNAVAILABLE",
  INFERENCE_FAILED: "INFERENCE_FAILED",
  UNSUPPORTED_BACKEND: "UNSUPPORTED_BACKEND",
  INVALID_TICKET: "INVALID_TICKET",
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE",
});

function createConnectionService({
  profilesRoot,
  smokeWorkRoot,
  backend,
  deps = {},
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  statusTimeoutMs = AUTH_PROBE_TIMEOUT_MS,
  logoutTimeoutMs = LOGOUT_TIMEOUT_MS,
  modelsTimeoutMs = MODELS_TIMEOUT_MS,
  smokeTimeoutMs = SMOKE_TIMEOUT_MS,
  diag = () => {},
} = {}) {
  if (!backend || typeof backend.resolveTicket !== "function") {
    throw new Error("A backend client with resolveTicket is required");
  }
  const profileManager = new RuntimeProfileManager({ profilesRoot });
  const runner = deps.runner || runRuntimeCommand;
  const activeOps = new Map(); // guard key -> AbortController

  const fail = (code, extra) => ({ ok: false, code, ...(extra || {}) });

  function acquire(keys) {
    for (const key of keys) {
      if (activeOps.has(key)) return null;
    }
    const controller = new AbortController();
    for (const key of keys) activeOps.set(key, controller);
    return controller;
  }

  function release(keys) {
    for (const key of keys) activeOps.delete(key);
  }

  function adapterFor(backendKind) {
    return PROVIDER_ADAPTERS[backendKind] || null;
  }

  // Runtime resolution that survives shim installs: findRuntimeExecutable
  // may return an extensionless/.cmd shim which cannot be spawned with
  // shell:false, so the adapter unwraps it to the real vendored binary
  // before the version probe decides READY vs BROKEN.
  function resolveRuntime(adapter) {
    const definition = getRuntimeDefinition(adapter.backendKind);
    const rawPath = findRuntimeExecutable(definition, {
      platform: deps.platform || process.platform,
      env: deps.env || process.env,
      spawnSyncImpl: deps.spawnSyncImpl || spawnSync,
      existsSyncImpl: deps.existsSyncImpl || fs.existsSync,
    });
    if (!rawPath) {
      return { error: fail(CONNECTION_OP_CODES.RUNTIME_NOT_INSTALLED) };
    }
    const executable = adapter.resolveExecutable(rawPath, deps);
    if (!executable) {
      return { error: fail(CONNECTION_OP_CODES.RUNTIME_BROKEN) };
    }
    const version = probeRuntimeVersion(executable, definition, {
      env: deps.env || process.env,
      spawnSyncImpl: deps.spawnSyncImpl || spawnSync,
    });
    if (!version.ok) {
      return { error: fail(CONNECTION_OP_CODES.RUNTIME_BROKEN) };
    }
    return { executable, version: version.version };
  }

  async function resolveOperation(ticket, expectedOperation, connectionId) {
    if (typeof ticket !== "string" || ticket.length === 0) {
      return { error: fail(CONNECTION_OP_CODES.INVALID_TICKET) };
    }
    let resolved;
    try {
      resolved = await backend.resolveTicket(ticket);
    } catch {
      return { error: fail(CONNECTION_OP_CODES.BACKEND_UNAVAILABLE) };
    }
    if (!resolved || resolved.ok !== true) {
      return {
        error: fail(resolved?.code || CONNECTION_OP_CODES.INVALID_TICKET),
      };
    }
    if (resolved.operation !== expectedOperation) {
      return { error: fail(CONNECTION_OP_CODES.INVALID_TICKET) };
    }
    const adapter = adapterFor(resolved.backendKind);
    if (!adapter) {
      return { error: fail(CONNECTION_OP_CODES.UNSUPPORTED_BACKEND) };
    }
    if (expectedOperation === "login") {
      return { resolved, adapter };
    }
    const connection = resolved.connection;
    if (!connection || connection.id !== connectionId) {
      return { error: fail(CONNECTION_OP_CODES.CONNECTION_NOT_FOUND) };
    }
    return { resolved, connection, adapter };
  }

  async function probeAccountStatus(adapter, executable, profileDir) {
    const invocation = adapter.buildStatusInvocation({
      executablePath: executable,
      profileDir,
      baseEnv: deps.env,
    });
    const result = await runner({ ...invocation, timeoutMs: statusTimeoutMs });
    if (result.error || result.timedOut) {
      return { authState: "UNKNOWN", authMethod: null, accountIdentity: null };
    }
    return adapter.parseAuthStatus(result);
  }

  // Spawns the provider login command and waits. The CLI owns the browser
  // flow entirely; its stdout (which may contain the OAuth authorize URL)
  // stays inside the sanitized runner capture and is never forwarded or
  // logged.
  async function runLoginProcess(adapter, executable, profileDir, signal) {
    const invocation = adapter.buildLoginInvocation({
      executablePath: executable,
      profileDir,
      baseEnv: deps.env,
    });
    return runner({
      ...invocation,
      timeoutMs: loginTimeoutMs,
      signal,
      sanitize: true,
    });
  }

  function classifyLoginOutcome(adapter, loginResult, status, signal) {
    if (loginResult.aborted || signal.aborted) {
      return CONNECTION_OP_CODES.LOGIN_CANCELLED;
    }
    if (loginResult.timedOut) {
      return CONNECTION_OP_CODES.LOGIN_TIMEOUT;
    }
    if (loginResult.error || loginResult.exitCode !== 0) {
      return CONNECTION_OP_CODES.LOGIN_FAILED;
    }
    // The process finished — the adapter decides whether the verified auth
    // state is a real account login for this provider.
    return adapter.loginFailureCode(status);
  }

  async function startLogin({ backendKind, ticket } = {}) {
    const adapter = adapterFor(backendKind);
    if (!adapter) {
      return fail(CONNECTION_OP_CODES.UNSUPPORTED_BACKEND);
    }
    const guardKeys = [adapter.loginGuardKey, `ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    let pendingProfile = null;
    try {
      const resolved = await resolveOperation(ticket, "login");
      if (resolved.error) return resolved.error;
      if (resolved.resolved.backendKind !== adapter.backendKind) {
        return fail(CONNECTION_OP_CODES.UNSUPPORTED_BACKEND);
      }

      // An org/device managed policy that forces a non-Claude.ai login
      // method is surfaced, never circumvented.
      const policy = adapter.checkLoginPolicy?.({
        platform: deps.platform || process.platform,
        env: deps.env || process.env,
        existsSyncImpl: deps.existsSyncImpl || fs.existsSync,
        readFileSyncImpl: deps.readFileSyncImpl || fs.readFileSync,
      });
      if (policy && policy.restricted) {
        diag({
          operation: "login",
          code: CONNECTION_OP_CODES.PROVIDER_POLICY_RESTRICTED,
          forcedLoginMethod: policy.forcedLoginMethod,
        });
        return fail(CONNECTION_OP_CODES.PROVIDER_POLICY_RESTRICTED);
      }

      const runtime = resolveRuntime(adapter);
      if (runtime.error) return runtime.error;

      pendingProfile = profileManager.createProfile();
      const loginResult = await runLoginProcess(
        adapter,
        runtime.executable,
        pendingProfile.profileDir,
        controller.signal,
      );
      const status = await probeAccountStatus(
        adapter,
        runtime.executable,
        pendingProfile.profileDir,
      );
      const failure = classifyLoginOutcome(
        adapter,
        loginResult,
        status,
        controller.signal,
      );
      if (failure) {
        diag({
          operation: "login",
          code: failure,
          authState: status.authState,
          authMethod: status.authMethod,
        });
        return fail(failure);
      }

      const complete = await backend.completeOperation(resolved.resolved.operationId, {
        outcome: "authenticated",
        runtimeProfileRef: pendingProfile.runtimeProfileRef,
        accountIdentity: status.accountIdentity ?? null,
        ...(status.providerMetadata
          ? { providerMetadata: status.providerMetadata }
          : {}),
      });
      if (!complete || complete.ok !== true) {
        return fail(complete?.code || CONNECTION_OP_CODES.LOGIN_FAILED);
      }
      const profileRef = pendingProfile.runtimeProfileRef;
      pendingProfile = null; // ownership moved to the new AIConnection row
      diag({ operation: "login", code: "OK", runtimeProfileRef: profileRef });
      return { ok: true, connection: complete.connection };
    } finally {
      release(guardKeys);
      if (pendingProfile) {
        // Failed/cancelled login leaves no zombie profile behind.
        profileManager.deleteProfile(pendingProfile.runtimeProfileRef);
      }
    }
  }

  async function reconnect({ connectionId, ticket } = {}) {
    const guardKeys = [`conn:${connectionId}`, `ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    try {
      const resolved = await resolveOperation(ticket, "reconnect", connectionId);
      if (resolved.error) return resolved.error;
      const { adapter, connection } = resolved;

      const guardWithLogin = [adapter.loginGuardKey];
      if (!acquire(guardWithLogin)) {
        return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
      }
      try {
        const runtime = resolveRuntime(adapter);
        if (runtime.error) return runtime.error;

        const profileDir = profileManager.ensureProfile(
          connection.runtimeProfileRef,
        );
        const loginResult = await runLoginProcess(
          adapter,
          runtime.executable,
          profileDir,
          controller.signal,
        );
        const status = await probeAccountStatus(adapter, runtime.executable, profileDir);
        const failure = classifyLoginOutcome(
          adapter,
          loginResult,
          status,
          controller.signal,
        );

        if (
          !failure &&
          connection.accountIdentity &&
          status.accountIdentity &&
          connection.accountIdentity !== status.accountIdentity
        ) {
          // The re-auth landed on a different account. Never silently swap
          // identity — surface the conflict for explicit user action.
          await backend.completeOperation(resolved.resolved.operationId, {
            outcome: "identity_conflict",
            accountIdentity: status.accountIdentity,
          });
          return fail(CONNECTION_OP_CODES.ACCOUNT_IDENTITY_CONFLICT);
        }

        if (
          failure === CONNECTION_OP_CODES.LOGIN_CANCELLED ||
          failure === CONNECTION_OP_CODES.LOGIN_TIMEOUT
        ) {
          return fail(failure);
        }
        if (!failure) {
          const complete = await backend.completeOperation(
            resolved.resolved.operationId,
            {
              outcome: "authenticated",
              accountIdentity:
                status.accountIdentity ?? connection.accountIdentity ?? null,
              ...(status.providerMetadata
                ? { providerMetadata: status.providerMetadata }
                : {}),
            },
          );
          if (!complete || complete.ok !== true) {
            return fail(complete?.code || CONNECTION_OP_CODES.LOGIN_FAILED);
          }
          return { ok: true, connection: complete.connection };
        }
        // Process ran but no valid session materialized — report the
        // observed auth state so the row reflects reality
        // (REAUTH_REQUIRED / ERROR). A wrong-method session is reported as
        // UNKNOWN so it can never flip ACCOUNT_LOGIN to CONNECTED.
        const complete = await backend.completeOperation(
          resolved.resolved.operationId,
          {
            outcome: "auth_state",
            authState: adapter.reportableAuthState(status),
          },
        );
        const updated =
          complete && complete.ok === true ? complete.connection : null;
        return fail(
          status.authState === "AUTHENTICATED"
            ? failure
            : failure === CONNECTION_OP_CODES.AUTH_NOT_CONFIRMED
              ? CONNECTION_OP_CODES.REAUTH_REQUIRED
              : failure,
          updated ? { connection: updated } : undefined,
        );
      } finally {
        release(guardWithLogin);
      }
    } finally {
      release(guardKeys);
    }
  }

  async function disconnect({ connectionId, ticket } = {}) {
    const guardKeys = [`conn:${connectionId}`, `ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    try {
      const resolved = await resolveOperation(ticket, "disconnect", connectionId);
      if (resolved.error) return resolved.error;
      const { adapter, connection } = resolved;

      // Best-effort official logout inside the connection's own profile.
      // If the runtime is gone the local disconnect still proceeds — the
      // connection row and profile ref are retained either way.
      const runtime = resolveRuntime(adapter);
      if (!runtime.error) {
        const profileDir = profileManager.ensureProfile(
          connection.runtimeProfileRef,
        );
        const invocation = adapter.buildLogoutInvocation({
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
        });
        const logout = await runner({
          ...invocation,
          timeoutMs: logoutTimeoutMs,
          signal: controller.signal,
        });
        diag({
          operation: "disconnect",
          logoutExitCode: logout.exitCode,
          timedOut: logout.timedOut,
        });
      }
      const complete = await backend.completeOperation(
        resolved.resolved.operationId,
        { outcome: "disconnected" },
      );
      if (!complete || complete.ok !== true) {
        return fail(complete?.code || CONNECTION_OP_CODES.BACKEND_UNAVAILABLE);
      }
      return { ok: true, connection: complete.connection };
    } finally {
      release(guardKeys);
    }
  }

  async function verify({ connectionId, ticket } = {}) {
    const guardKeys = [`conn:${connectionId}`, `ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    try {
      const resolved = await resolveOperation(ticket, "verify", connectionId);
      if (resolved.error) return resolved.error;
      const { adapter, connection } = resolved;

      const runtime = resolveRuntime(adapter);
      if (runtime.error) return runtime.error; // runtime state stays separate

      const profileDir = profileManager.ensureProfile(
        connection.runtimeProfileRef,
      );
      const status = await probeAccountStatus(adapter, runtime.executable, profileDir);
      const reported = adapter.reportableAuthState(status);
      const complete = await backend.completeOperation(
        resolved.resolved.operationId,
        { outcome: "auth_state", authState: reported },
      );
      if (!complete || complete.ok !== true) {
        return fail(complete?.code || CONNECTION_OP_CODES.BACKEND_UNAVAILABLE);
      }
      return { ok: true, connection: complete.connection, authState: reported };
    } finally {
      release(guardKeys);
    }
  }

  async function listModels({ connectionId, ticket } = {}) {
    const guardKeys = [`conn:${connectionId}`, `ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    try {
      const resolved = await resolveOperation(ticket, "listModels", connectionId);
      if (resolved.error) return resolved.error;
      const { adapter, connection } = resolved;

      const runtime = resolveRuntime(adapter);
      if (runtime.error) return runtime.error;
      const profileDir = profileManager.ensureProfile(
        connection.runtimeProfileRef,
      );

      // The adapter decides between runtime discovery and a curated
      // fallback; either way the response is {id, displayName, source,
      // availability}[] — a catalog, never an entitlement claim.
      const catalog = await adapter.listModels({
        executablePath: runtime.executable,
        profileDir,
        baseEnv: deps.env,
        runner,
        timeoutMs: modelsTimeoutMs,
        signal: controller.signal,
      });
      await backend.completeOperation(resolved.resolved.operationId, {
        outcome: "consumed",
      });
      return {
        ok: true,
        dynamicDiscoverySupported: catalog.dynamicDiscoverySupported === true,
        models: catalog.models,
      };
    } finally {
      release(guardKeys);
    }
  }

  async function runSmoke({ connectionId, ticket, model } = {}) {
    const guardKeys = [`conn:${connectionId}`, `ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    let workDir = null;
    try {
      const resolved = await resolveOperation(ticket, "smoke", connectionId);
      if (resolved.error) return resolved.error;
      const { adapter, connection } = resolved;

      const runtime = resolveRuntime(adapter);
      if (runtime.error) return runtime.error;
      const profileDir = profileManager.ensureProfile(
        connection.runtimeProfileRef,
      );

      fs.mkdirSync(smokeWorkRoot, { recursive: true });
      workDir = fs.mkdtempSync(
        path.join(smokeWorkRoot, `${adapter.backendKind.toLowerCase()}-smoke-`),
      );
      const invocation = adapter.buildSmokeInvocation({
        executablePath: runtime.executable,
        profileDir,
        baseEnv: deps.env,
        workingDirectory: workDir,
        model,
      });
      const result = await runner({
        ...invocation,
        timeoutMs: smokeTimeoutMs,
        signal: controller.signal,
      });
      await backend.completeOperation(resolved.resolved.operationId, {
        outcome: "consumed",
      });
      if (result.aborted) return fail(CONNECTION_OP_CODES.LOGIN_CANCELLED);
      if (result.timedOut || result.error || result.exitCode !== 0) {
        diag({ operation: "smoke", exitCode: result.exitCode });
        return fail(CONNECTION_OP_CODES.INFERENCE_FAILED);
      }
      const { text, reportedError } = adapter.extractSmokeText({
        result,
        workDir,
      });
      if (reportedError) {
        diag({ operation: "smoke", exitCode: result.exitCode, reportedError });
        return fail(CONNECTION_OP_CODES.INFERENCE_FAILED);
      }
      return {
        ok: true,
        text,
        expected: adapter.smokeExpected,
        matched: text === adapter.smokeExpected,
      };
    } finally {
      release(guardKeys);
      if (workDir) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }
  }

  function cancelOperation({ ticket, connectionId } = {}) {
    const keys = [];
    if (typeof ticket === "string" && ticket) keys.push(`ticket:${ticket}`);
    if (typeof connectionId === "string" && connectionId) {
      keys.push(`conn:${connectionId}`);
    }
    let cancelled = false;
    for (const key of keys) {
      const controller = activeOps.get(key);
      if (controller) {
        controller.abort();
        cancelled = true;
      }
    }
    return { ok: true, cancelled };
  }

  return {
    profileManager,
    startLogin,
    cancelOperation,
    reconnect,
    disconnect,
    verify,
    listModels,
    runSmoke,
  };
}

module.exports = {
  CONNECTION_OP_CODES,
  LOGIN_TIMEOUT_MS,
  PROVIDER_ADAPTERS,
  createConnectionService,
};

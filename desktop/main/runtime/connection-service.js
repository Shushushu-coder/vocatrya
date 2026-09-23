// Phase D AIConnection orchestrator — the only place account-login
// operations are coordinated.
//
// Boundaries this module enforces:
// - The renderer supplies ONLY {backendKind|connectionId, ticket, model?}.
//   Tickets are single-use proofs minted by an authenticated backend action;
//   they bind the userId (and for connection ops, the connectionId) so the
//   renderer can never drive operations on someone else's connection.
// - Codex owns authentication. We spawn `codex login`/`logout`/`login
//   status`/`debug models`/`exec` inside the managed profile env and never
//   read auth.json or any credential material.
// - AIConnection rows are mutated ONLY by the backend through the internal
//   loopback client, after the runtime verified the outcome.
// - Every spawned process goes through runRuntimeCommand: shell:false,
//   capped output, timeout/abort support, sanitized capture.
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getRuntimeDefinition } = require("./registry");
const { findRuntimeExecutable, probeRuntimeVersion } = require("./detector");
const { runRuntimeCommand } = require("./runner");
const { RuntimeProfileManager } = require("./profiles");
const { AUTH_PROBE_TIMEOUT_MS } = require("./auth-probe");
const {
  CODEX_BACKEND_KIND,
  CODEX_CURATED_MODELS,
  CODEX_SMOKE_EXPECTED,
  CODEX_SMOKE_PROMPT,
  buildCodexExecInvocation,
  buildCodexLoginInvocation,
  buildCodexLogoutInvocation,
  buildCodexModelsInvocation,
  buildCodexStatusInvocation,
  parseCodexLoginStatus,
  parseCodexModelCatalog,
  resolveCodexExecutable,
} = require("./codex");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // browser auth is user-paced
const LOGOUT_TIMEOUT_MS = 30 * 1000;
const MODELS_TIMEOUT_MS = 20 * 1000;
const SMOKE_TIMEOUT_MS = 120 * 1000;

// `codex login` binds a fixed local callback port — two concurrent login
// processes (connect or reconnect) would collide, so all login spawns share
// one in-process mutex on top of the per-ticket/per-connection guards.
const LOGIN_GUARD = "codex:login";

const CONNECTION_OP_CODES = Object.freeze({
  RUNTIME_NOT_INSTALLED: "RUNTIME_NOT_INSTALLED",
  RUNTIME_BROKEN: "RUNTIME_BROKEN",
  LOGIN_ALREADY_IN_PROGRESS: "LOGIN_ALREADY_IN_PROGRESS",
  LOGIN_CANCELLED: "LOGIN_CANCELLED",
  LOGIN_TIMEOUT: "LOGIN_TIMEOUT",
  LOGIN_FAILED: "LOGIN_FAILED",
  AUTH_NOT_CONFIRMED: "AUTH_NOT_CONFIRMED",
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

  // Runtime resolution that survives npm .cmd shims: findRuntimeExecutable
  // may return an extensionless/.cmd shim which cannot be spawned with
  // shell:false, so it is unwrapped to the vendored codex.exe before the
  // version probe decides READY vs BROKEN.
  function resolveCodexRuntime() {
    const definition = getRuntimeDefinition(CODEX_BACKEND_KIND);
    const rawPath = findRuntimeExecutable(definition, {
      platform: deps.platform || process.platform,
      env: deps.env || process.env,
      spawnSyncImpl: deps.spawnSyncImpl || spawnSync,
      existsSyncImpl: deps.existsSyncImpl || fs.existsSync,
    });
    if (!rawPath) {
      return { error: fail(CONNECTION_OP_CODES.RUNTIME_NOT_INSTALLED) };
    }
    const executable = resolveCodexExecutable(rawPath, deps);
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
    if (resolved.backendKind !== CODEX_BACKEND_KIND) {
      return { error: fail(CONNECTION_OP_CODES.UNSUPPORTED_BACKEND) };
    }
    if (expectedOperation === "login") {
      return { resolved };
    }
    const connection = resolved.connection;
    if (!connection || connection.id !== connectionId) {
      return { error: fail(CONNECTION_OP_CODES.CONNECTION_NOT_FOUND) };
    }
    return { resolved, connection };
  }

  async function probeAccountStatus(executable, profileDir) {
    const invocation = buildCodexStatusInvocation({
      executablePath: executable,
      profileDir,
      baseEnv: deps.env,
    });
    const result = await runner({ ...invocation, timeoutMs: statusTimeoutMs });
    if (result.error) {
      return { authState: "UNKNOWN", authMethod: null, accountIdentity: null };
    }
    if (result.timedOut) {
      return { authState: "UNKNOWN", authMethod: null, accountIdentity: null };
    }
    return parseCodexLoginStatus(result);
  }

  // Spawns `codex login` and waits. The CLI owns the browser flow entirely;
  // its stdout (which contains the OAuth authorize URL) stays inside the
  // sanitized runner capture and is never forwarded or logged.
  async function runLoginProcess(executable, profileDir, signal) {
    const invocation = buildCodexLoginInvocation({
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

  function classifyLoginOutcome(loginResult, status, signal) {
    if (loginResult.aborted || signal.aborted) {
      return CONNECTION_OP_CODES.LOGIN_CANCELLED;
    }
    if (loginResult.timedOut) {
      return CONNECTION_OP_CODES.LOGIN_TIMEOUT;
    }
    if (loginResult.error || loginResult.exitCode !== 0) {
      return CONNECTION_OP_CODES.LOGIN_FAILED;
    }
    if (status.authState !== "AUTHENTICATED") {
      return CONNECTION_OP_CODES.AUTH_NOT_CONFIRMED;
    }
    // A verified session that is not ChatGPT account auth means a credential
    // override slipped in — never treat it as ACCOUNT_LOGIN.
    if (status.authMethod !== "chatgpt") {
      return CONNECTION_OP_CODES.AUTH_NOT_CONFIRMED;
    }
    return null;
  }

  // Auth state as it may be reported to the backend. An authenticated
  // session that is not ChatGPT account login (e.g. an API key slipping
  // through) must never mark an ACCOUNT_LOGIN connection as CONNECTED —
  // it is reported as UNKNOWN, which maps to ERROR.
  function reportableAuthState(status) {
    if (
      status.authState === "AUTHENTICATED" &&
      status.authMethod &&
      status.authMethod !== "chatgpt"
    ) {
      return "UNKNOWN";
    }
    return status.authState;
  }

  async function startLogin({ backendKind, ticket } = {}) {
    if (backendKind !== CODEX_BACKEND_KIND) {
      return fail(CONNECTION_OP_CODES.UNSUPPORTED_BACKEND);
    }
    const guardKeys = [LOGIN_GUARD, `ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    let pendingProfile = null;
    try {
      const resolved = await resolveOperation(ticket, "login");
      if (resolved.error) return resolved.error;

      const runtime = resolveCodexRuntime();
      if (runtime.error) return runtime.error;

      pendingProfile = profileManager.createProfile();
      const loginResult = await runLoginProcess(
        runtime.executable,
        pendingProfile.profileDir,
        controller.signal,
      );
      const status = await probeAccountStatus(
        runtime.executable,
        pendingProfile.profileDir,
      );
      const failure = classifyLoginOutcome(
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
    const guardKeys = [LOGIN_GUARD, `conn:${connectionId}`, `ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    try {
      const resolved = await resolveOperation(ticket, "reconnect", connectionId);
      if (resolved.error) return resolved.error;
      const connection = resolved.connection;

      const runtime = resolveCodexRuntime();
      if (runtime.error) return runtime.error;

      const profileDir = profileManager.ensureProfile(
        connection.runtimeProfileRef,
      );
      const loginResult = await runLoginProcess(
        runtime.executable,
        profileDir,
        controller.signal,
      );
      const status = await probeAccountStatus(runtime.executable, profileDir);
      const failure = classifyLoginOutcome(
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

      if (failure === CONNECTION_OP_CODES.LOGIN_CANCELLED) {
        return fail(failure);
      }
      if (failure === CONNECTION_OP_CODES.LOGIN_TIMEOUT) {
        return fail(failure);
      }
      if (!failure) {
        const complete = await backend.completeOperation(
          resolved.resolved.operationId,
          {
            outcome: "authenticated",
            accountIdentity:
              status.accountIdentity ?? connection.accountIdentity ?? null,
          },
        );
        if (!complete || complete.ok !== true) {
          return fail(complete?.code || CONNECTION_OP_CODES.LOGIN_FAILED);
        }
        return { ok: true, connection: complete.connection };
      }
      // Process ran but no valid session materialized — report the observed
      // auth state so the row reflects reality (REAUTH_REQUIRED / ERROR).
      // A wrong-method session (e.g. API key) is reported as UNKNOWN so it
      // can never flip an ACCOUNT_LOGIN connection to CONNECTED.
      const complete = await backend.completeOperation(
        resolved.resolved.operationId,
        { outcome: "auth_state", authState: reportableAuthState(status) },
      );
      const updated = complete && complete.ok === true ? complete.connection : null;
      return fail(
        status.authState === "AUTHENTICATED"
          ? CONNECTION_OP_CODES.AUTH_NOT_CONFIRMED
          : failure === CONNECTION_OP_CODES.AUTH_NOT_CONFIRMED
            ? CONNECTION_OP_CODES.REAUTH_REQUIRED
            : failure,
        updated ? { connection: updated } : undefined,
      );
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
      const connection = resolved.connection;

      // Best-effort official logout inside the connection's own profile. If
      // the runtime is gone the local disconnect still proceeds — the
      // connection row and profile ref are retained either way.
      const runtime = resolveCodexRuntime();
      if (!runtime.error) {
        const profileDir = profileManager.ensureProfile(
          connection.runtimeProfileRef,
        );
        const invocation = buildCodexLogoutInvocation({
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
      const connection = resolved.connection;

      const runtime = resolveCodexRuntime();
      if (runtime.error) return runtime.error; // runtime state stays separate

      const profileDir = profileManager.ensureProfile(
        connection.runtimeProfileRef,
      );
      const status = await probeAccountStatus(runtime.executable, profileDir);
      const reported = reportableAuthState(status);
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
      const connection = resolved.connection;

      const runtime = resolveCodexRuntime();
      if (runtime.error) return runtime.error;
      const profileDir = profileManager.ensureProfile(
        connection.runtimeProfileRef,
      );

      // Official machine-readable catalog: `codex debug models` (account-
      // aware refresh), then the binary's bundled catalog, then the curated
      // fallback — every step still produces {id, displayName, source}.
      for (const bundled of [false, true]) {
        const invocation = buildCodexModelsInvocation({
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
          bundled,
        });
        const result = await runner({
          ...invocation,
          timeoutMs: modelsTimeoutMs,
          signal: controller.signal,
        });
        if (result.error || result.timedOut || result.exitCode !== 0) continue;
        const models = parseCodexModelCatalog(result.stdout);
        if (models) {
          await backend.completeOperation(resolved.resolved.operationId, {
            outcome: "consumed",
          });
          return {
            ok: true,
            dynamicDiscoverySupported: true,
            models: models.map((m) => ({
              ...m,
              source: "RUNTIME",
              availability: "available",
            })),
          };
        }
      }
      await backend.completeOperation(resolved.resolved.operationId, {
        outcome: "consumed",
      });
      return {
        ok: true,
        dynamicDiscoverySupported: false,
        models: CODEX_CURATED_MODELS.map((m) => ({
          ...m,
          source: "CURATED",
          availability: "unknown",
        })),
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
      const connection = resolved.connection;

      const runtime = resolveCodexRuntime();
      if (runtime.error) return runtime.error;
      const profileDir = profileManager.ensureProfile(
        connection.runtimeProfileRef,
      );

      fs.mkdirSync(smokeWorkRoot, { recursive: true });
      workDir = fs.mkdtempSync(path.join(smokeWorkRoot, "codex-smoke-"));
      const outputFile = path.join(workDir, "last-message.txt");
      const invocation = buildCodexExecInvocation({
        executablePath: runtime.executable,
        profileDir,
        baseEnv: deps.env,
        workingDirectory: workDir,
        outputFile,
        model,
        prompt: CODEX_SMOKE_PROMPT,
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
      let text = "";
      try {
        text = fs.readFileSync(outputFile, "utf8");
      } catch {
        text = "";
      }
      if (!text.trim()) {
        // Fallback: last non-empty stdout line carries the final message in
        // non-json exec output.
        const lines = (result.stdout || "")
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        text = lines[lines.length - 1] || "";
      }
      return {
        ok: true,
        text: text.trim(),
        expected: CODEX_SMOKE_EXPECTED,
        matched: text.trim() === CODEX_SMOKE_EXPECTED,
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
  createConnectionService,
};

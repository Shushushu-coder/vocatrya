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
// - One-shot processes go through runRuntimeCommand: shell:false,
//   capped output, timeout/abort support, sanitized capture.
// - Foreground Codex streaming may reuse a persistent app-server child.
//   That child uses the same invocation builder and is still shell:false.
//   Abort, timeout, and fatal protocol errors retire it.
//
// Phase E refactor: provider specifics live behind a small adapter
// contract (codex.js / claude.js). This module coordinates tickets,
// guards, pending profiles, and outcome reporting — it contains no
// provider-specific command knowledge.
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { resolveCodexInstalls } = require("./codex-install");
const { NATIVE_VERSION,NATIVE_VERIFIED_VERSIONS, NATIVE_MODELS, NATIVE_CONFIG_HASH, nativeSessionReady, runNativeSession } = require("./native-session");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { getRuntimeDefinition } = require("./registry");
const {
  bundleEntrypointArgs,
  findRuntimeExecutable,
  probeRuntimeVersion,
} = require("./detector");
const { runRuntimeCommand } = require("./runner");
const { RuntimeProfileManager } = require("./profiles");
const { AUTH_PROBE_TIMEOUT_MS } = require("./auth-probe");
const {
  getAccountRuntimeCapabilities,
  streamingRuntimeVersionMatches,
} = require("./capabilities");
const { getCapabilityCache } = require("./runtime-capability-cache");
const { runDevinCapabilityProbe } = require("./devin-capability-probe");
const { CODEX_BACKEND_KIND, codexAdapter } = require("./codex");
const {
  createCodexPersistentRuntimeManager,
} = require("./codex-persistent-runtime");
const { CLAUDE_BACKEND_KIND, claudeAdapter } = require("./claude");
const { CURSOR_BACKEND_KIND, cursorAdapter } = require("./cursor");
const { GROK_BACKEND_KIND, grokAdapter } = require("./grok");
const { OPENCODE_BACKEND_KIND, opencodeAdapter } = require("./opencode");
const { DEVIN_BACKEND_KIND, devinAdapter } = require("./devin");
const { ANTIGRAVITY_BACKEND_KIND, antigravityAdapter } = require("./antigravity");

const LOGIN_TIMEOUT_MS = 10 * 60 * 1000; // browser auth is user-paced
const LOGOUT_TIMEOUT_MS = 30 * 1000;
const MODELS_TIMEOUT_MS = 20 * 1000;
const SMOKE_TIMEOUT_MS = 120 * 1000;
const EXEC_TIMEOUT_MS = 120 * 1000;
const EXEC_MAX_TIMEOUT_MS = 300 * 1000;

// Implemented account-login runtimes. Each adapter owns its login guard
// key (`<vendor>:login`) so a login process per runtime can run in
// parallel while same-runtime logins stay serialized — the CLIs bind
// fixed local callback resources that would otherwise collide.
// Multi-provider runtimes (OpenCode) expose forAccountProvider() so the
// account provider is bound only after the minted ticket / connection row
// has been resolved — never from raw renderer input.
const PROVIDER_ADAPTERS = Object.freeze({
  [CODEX_BACKEND_KIND]: codexAdapter,
  [CLAUDE_BACKEND_KIND]: claudeAdapter,
  [CURSOR_BACKEND_KIND]: cursorAdapter,
  [GROK_BACKEND_KIND]: grokAdapter,
  [OPENCODE_BACKEND_KIND]: opencodeAdapter,
  [DEVIN_BACKEND_KIND]: devinAdapter,
  [ANTIGRAVITY_BACKEND_KIND]: antigravityAdapter,
});

// The consolidated ACCOUNT_LOGIN error taxonomy — kept in exact parity
// with AI_CONNECTION_OP_ERROR_CODES in src/lib/ai/connections.ts (pinned
// by the consolidation tests). Provider-specific detail travels in diag
// metadata, never as new per-provider codes.
const CONNECTION_OP_CODES = Object.freeze({
  RUNTIME_NOT_INSTALLED: "RUNTIME_NOT_INSTALLED",
  RUNTIME_BROKEN: "RUNTIME_BROKEN",
  RUNTIME_UPDATE_REQUIRED: "RUNTIME_UPDATE_REQUIRED",
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
  UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION:
    "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  CONNECTION_NOT_FOUND: "CONNECTION_NOT_FOUND",
  CONNECTION_ARCHIVED: "CONNECTION_ARCHIVED",
  MODEL_DISCOVERY_UNAVAILABLE: "MODEL_DISCOVERY_UNAVAILABLE",
  MODEL_UNAVAILABLE: "MODEL_UNAVAILABLE",
  PERMISSION_BOUNDARY_NOT_READY: "PERMISSION_BOUNDARY_NOT_READY",
  INFERENCE_FAILED: "INFERENCE_FAILED",
  UNSUPPORTED_BACKEND: "UNSUPPORTED_BACKEND",
  INVALID_TICKET: "INVALID_TICKET",
  BACKEND_UNAVAILABLE: "BACKEND_UNAVAILABLE",
  // TEXT_ONLY execution gates — kept in parity with the backend
  // AI_CONNECTION_OP_ERROR_CODES.
  CONNECTION_DISCONNECTED: "CONNECTION_DISCONNECTED",
  CONNECTION_ERROR: "CONNECTION_ERROR",
  AI_EXECUTION_TIMEOUT: "AI_EXECUTION_TIMEOUT",
  // The structuredOutput payload could not be carried by this runtime's
  // invocation (e.g. inline schema exceeds the command-line budget).
  STRUCTURED_OUTPUT_UNSUPPORTED: "STRUCTURED_OUTPUT_UNSUPPORTED",
  // The runtime's structured-output mechanism has not completed real
  // managed verification (or the verified version no longer matches the
  // installed one). Business structured consumers fail closed here —
  // capability metadata decides, never a caller-supplied backend kind.
  STRUCTURED_OUTPUT_NOT_VERIFIED: "STRUCTURED_OUTPUT_NOT_VERIFIED",
});

function summarizeSanitizedStderr(rawStderr, maxChars = 500) {
  if (typeof rawStderr !== "string" || rawStderr.trim().length === 0) return null;
  const trimmed = rawStderr.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const half = Math.floor(maxChars / 2) - 3;
  return `${trimmed.slice(0, half)}...${trimmed.slice(-half)}`;
}

function createConnectionService({
  profilesRoot,
  smokeWorkRoot,
  execWorkRoot,
  backend,
  deps = {},
  loginTimeoutMs = LOGIN_TIMEOUT_MS,
  statusTimeoutMs = AUTH_PROBE_TIMEOUT_MS,
  logoutTimeoutMs = LOGOUT_TIMEOUT_MS,
  modelsTimeoutMs = MODELS_TIMEOUT_MS,
  smokeTimeoutMs = SMOKE_TIMEOUT_MS,
  execTimeoutMs = EXEC_TIMEOUT_MS,
  diag = () => {},
} = {}) {
  if (!backend || typeof backend.resolveTicket !== "function") {
    throw new Error("A backend client with resolveTicket is required");
  }
  const profileManager = new RuntimeProfileManager({ profilesRoot });
  const runner = deps.runner || runRuntimeCommand;
  // Per-version capability snapshots (see runtime-capability-cache.js). For
  // cache-managed runtimes (Devin) this — not a version string — decides
  // whether streaming / structured output may run.
  const capabilityCache =
    deps.capabilityCache || getCapabilityCache(profilesRoot);
  const persistentCwdRoot = execWorkRoot || smokeWorkRoot;
  const codexPersistentRuntime =
    deps.persistentCodexRuntime === false
      ? null
      : deps.persistentCodexRuntime ||
        (persistentCwdRoot
          ? createCodexPersistentRuntimeManager({
              spawnImpl: deps.spawnImpl,
              terminateImpl: deps.terminateImpl,
              now: deps.now,
              diag,
              stableCwd: path.join(persistentCwdRoot, "codex-persistent"),
              buildInvocation: (input) =>
                codexAdapter.buildStreamingInvocation(input),
            })
          : null);
  const activeOps = new Map(); // guard key -> AbortController
  const nativeRuns = new Set();
  let nativeDisposed = false;
  // In-flight TEXT_ONLY execs per connection. Execs may run concurrently
  // on the same connection, but lifecycle ops (disconnect/reconnect/
  // verify/listModels/smoke) must not mutate the shared runtime profile
  // underneath them — a `conn:` guard key is therefore also considered
  // busy while any exec count is non-zero.
  const execCounts = new Map(); // connectionId -> in-flight count

  const fail = (code, extra) => ({ ok: false, code, ...(extra || {}) });

  function acquire(keys) {
    for (const key of keys) {
      if (activeOps.has(key)) return null;
      if (key.startsWith("conn:") && (execCounts.get(key.slice(5)) ?? 0) > 0) {
        return null;
      }
    }
    const controller = new AbortController();
    for (const key of keys) activeOps.set(key, controller);
    return controller;
  }

  function execAcquire(connectionId) {
    execCounts.set(connectionId, (execCounts.get(connectionId) ?? 0) + 1);
  }

  function execRelease(connectionId) {
    const next = (execCounts.get(connectionId) ?? 1) - 1;
    if (next <= 0) execCounts.delete(connectionId);
    else execCounts.set(connectionId, next);
  }

  function release(keys) {
    for (const key of keys) activeOps.delete(key);
  }

  function adapterFor(backendKind) {
    return PROVIDER_ADAPTERS[backendKind] || null;
  }

  // Binds the backend adapter to the account provider proven by the
  // minted ticket (login) or the persisted connection row (connection
  // ops). A pairing the runtime cannot authenticate binds to null —
  // never to a guessed provider.
  function bindAdapter(backendKind, accountProvider) {
    const adapter = adapterFor(backendKind);
    if (!adapter) return null;
    return typeof adapter.forAccountProvider === "function"
      ? adapter.forAccountProvider(accountProvider)
      : adapter;
  }

  // Runtime resolution that survives shim installs: findRuntimeExecutable
  // may return an extensionless/.cmd shim which cannot be spawned with
  // shell:false, so the adapter unwraps it to the real vendored binary
  // before the version probe decides READY vs BROKEN.
  // purpose: "default" (login/verify/models/smoke), "native", or "exec"
  // (streaming + structured exec, pinned to the capability-verified version).
  function resolveRuntime(adapter, purpose = "default") {
    const definition = getRuntimeDefinition(adapter.backendKind);
    let executable = null;
    if (definition.bundle) {
      // Bundle runtimes (cursor-agent) resolve authoritatively from the
      // versions dir — a PATH hit may be a launcher shim or an unrelated
      // product reusing the command name, so it is never trusted.
      executable = adapter.resolveExecutable(null, deps);
      if (!executable) {
        return { error: fail(CONNECTION_OP_CODES.RUNTIME_NOT_INSTALLED) };
      }
    } else if (adapter.backendKind === CODEX_BACKEND_KIND) {
      // The spawned binary IS the selected install: newest verified wins,
      // shims are already unwrapped to the vendored codex.exe.
      const found = resolveCodexInstalls(definition, deps);
      const listing = { installs: found.installs, verifiedVersions: found.verifiedVersions };
      const chosen = found.selections[purpose] || found.selected;
      if (!chosen) return { error: fail(CONNECTION_OP_CODES.RUNTIME_NOT_INSTALLED), ...listing };
      if (!chosen.ok) return { error: fail(CONNECTION_OP_CODES.RUNTIME_BROKEN), ...listing };
      return { executable: chosen.path, version: chosen.version, ...listing, selections: found.selections };
    } else {
      const rawPath = findRuntimeExecutable(definition, {
        platform: deps.platform || process.platform,
        env: deps.env || process.env,
        spawnSyncImpl: deps.spawnSyncImpl || spawnSync,
        existsSyncImpl: deps.existsSyncImpl || fs.existsSync,
      });
      if (!rawPath) {
        return { error: fail(CONNECTION_OP_CODES.RUNTIME_NOT_INSTALLED) };
      }
      executable = adapter.resolveExecutable(rawPath, deps);
      if (!executable) {
        return { error: fail(CONNECTION_OP_CODES.RUNTIME_BROKEN) };
      }
    }
    const version = probeRuntimeVersion(executable, definition, {
      env: deps.env || process.env,
      spawnSyncImpl: deps.spawnSyncImpl || spawnSync,
      argsPrefix: bundleEntrypointArgs(definition, executable),
    });
    if (!version.ok) {
      return {
        error: fail(
          version.code === "IDENTITY_MISMATCH"
            ? CONNECTION_OP_CODES.RUNTIME_NOT_INSTALLED
            : CONNECTION_OP_CODES.RUNTIME_BROKEN,
        ),
      };
    }
    return { executable, version: version.version };
  }


  // Cache-driven capability gate. Returns null when the capability is
  // verified for exactly this installed build, else the failure code.
  // PASS -> allow (fast path, no spawn). FAIL/UNVERIFIED -> refuse
  // ("runtime self-check failed"). Never judged -> run the one-time probe
  // (a single minimal `devin -p` call), cache the verdict, then decide.
  // Runtimes the cache does not manage keep their static gates.
  async function capabilityGate({
    adapter,
    runtime,
    profileDir,
    model,
    dimension,
    notVerifiedCode,
    signal,
  }) {
    if (!capabilityCache.manages(adapter.backendKind)) return null;
    if (typeof adapter.buildCapabilityProbeInvocation !== "function") {
      return notVerifiedCode;
    }
    const verdict = await capabilityCache.ensure(
      adapter.backendKind,
      runtime.version,
      dimension,
      async () => {
        const probeRoot = execWorkRoot || smokeWorkRoot;
        fs.mkdirSync(probeRoot, { recursive: true });
        const probeDir = fs.mkdtempSync(
          path.join(probeRoot, `${adapter.backendKind.toLowerCase()}-probe-`),
        );
        try {
          const verdicts = await runDevinCapabilityProbe({
            adapter,
            runner,
            executablePath: runtime.executable,
            profileDir,
            baseEnv: deps.env,
            workingDirectory: probeDir,
            model,
            signal,
            timeoutMs: deps.capabilityProbeTimeoutMs,
          });
          diag({
            operation: "capabilityProbe",
            backendKind: adapter.backendKind,
            version: runtime.version,
            streaming: verdicts?.streaming ?? "ABORTED",
            structured: verdicts?.structured ?? "ABORTED",
          });
          return verdicts;
        } finally {
          try {
            fs.rmSync(probeDir, { recursive: true, force: true });
          } catch {
            // Temp cleanup is best-effort.
          }
        }
      },
    );
    return verdict === "PASS" ? null : notVerifiedCode;
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
    if (!adapterFor(resolved.backendKind)) {
      return { error: fail(CONNECTION_OP_CODES.UNSUPPORTED_BACKEND) };
    }
    if (expectedOperation === "login") {
      // The minted ticket pins the account provider (server-validated);
      // the adapter binds it or the combination is refused.
      const adapter = bindAdapter(
        resolved.backendKind,
        resolved.accountProvider,
      );
      if (!adapter) {
        return {
          error: fail(
            CONNECTION_OP_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
          ),
        };
      }
      return { resolved, adapter };
    }
    const connection = resolved.connection;
    if (!connection || connection.id !== connectionId) {
      return { error: fail(CONNECTION_OP_CODES.CONNECTION_NOT_FOUND) };
    }
    // Defense in depth: the ticket's runtime must be the connection's
    // runtime — profile/provider bind to the row, never to the caller.
    if (resolved.backendKind !== connection.backendKind) {
      return { error: fail(CONNECTION_OP_CODES.INVALID_TICKET) };
    }
    // The persisted row is the provider source of truth for connection
    // ops — the renderer never re-states it.
    const adapter = bindAdapter(resolved.backendKind, connection.provider);
    if (!adapter) {
      return {
        error: fail(
          CONNECTION_OP_CODES.UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION,
        ),
      };
    }
    return { resolved, connection, adapter };
  }

  async function probeAccountStatus(adapter, executable, profileDir, signal) {
    // Adapters whose runtime has no one-shot status command (Grok: auth is
    // only observable through the ACP stdio handshake) expose probeAuth,
    // which drives the exchange itself under the same managed env.
    if (typeof adapter.probeAuth === "function") {
      return adapter.probeAuth({
        executablePath: executable,
        profileDir,
        baseEnv: deps.env,
        timeoutMs: statusTimeoutMs,
        signal,
        spawnImpl: deps.spawnImpl,
        terminateImpl: deps.terminateImpl,
      });
    }
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

  // Spawns the provider login command and waits. The CLI owns the auth
  // flow entirely (browser, console TUI, or device flow). When the
  // runtime cannot open a browser itself (e.g. grok login), the adapter's
  // extractLoginUrl pulls the vendor's authorize URL out of the raw
  // output stream and it is forwarded to the renderer via
  // deps.notifyOAuthUrl — the URL is the official authorization entry
  // point, not credential material, and it is never written to diag/logs.
  async function runLoginProcess(adapter, executable, profileDir, signal) {
    const invocation = adapter.buildLoginInvocation({
      executablePath: executable,
      profileDir,
      baseEnv: deps.env,
    });
    let loginOutputBuffer = "";
    let urlSent = false;
    // Some CLIs print the authorize URL on stdout, others on stderr
    // (`grok login`); both streams feed the same bounded buffer.
    const observeChunk =
      typeof adapter.extractLoginUrl === "function" &&
      typeof deps.notifyOAuthUrl === "function"
        ? (chunk) => {
            if (urlSent || loginOutputBuffer.length > 64 * 1024) return;
            loginOutputBuffer += chunk;
            const url = adapter.extractLoginUrl(loginOutputBuffer);
            if (url) {
              urlSent = true;
              deps.notifyOAuthUrl({
                backendKind: adapter.backendKind,
                accountProvider: adapter.accountProvider,
                url,
              });
            }
          }
        : undefined;
    return runner({
      ...invocation,
      timeoutMs: loginTimeoutMs,
      signal,
      sanitize: true,
      onStdout: observeChunk,
      onStderr: observeChunk,
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
    const baseAdapter = adapterFor(backendKind);
    if (!baseAdapter) {
      return fail(CONNECTION_OP_CODES.UNSUPPORTED_BACKEND);
    }
    const guardKeys = [baseAdapter.loginGuardKey, `ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    let pendingProfile = null;
    try {
      const resolved = await resolveOperation(ticket, "login");
      if (resolved.error) return resolved.error;
      if (resolved.resolved.backendKind !== baseAdapter.backendKind) {
        return fail(CONNECTION_OP_CODES.UNSUPPORTED_BACKEND);
      }
      // The provider-bound adapter — for multi-provider runtimes this is
      // the only object carrying provider-specific command knowledge.
      const adapter = resolved.adapter;

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
        controller.signal,
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

      // Provider-specific post-auth setup inside the managed profile
      // (Devin pins devin.org_id so `devin -p` never hits the interactive
      // organization picker). Best-effort — it never blocks the flow.
      if (typeof adapter.prepareSession === "function") {
        await adapter.prepareSession({
          executablePath: runtime.executable,
          profileDir: pendingProfile.profileDir,
          baseEnv: deps.env,
          runner,
          timeoutMs: statusTimeoutMs,
          signal: controller.signal,
        });
      }

      const complete = await backend.completeOperation(resolved.resolved.operationId, {
        outcome: "authenticated",
        // The adapter-verified provider — only a successful account-auth
        // classification reached this point, so this is proven, not
        // asserted. The backend re-validates it against the matrix.
        verifiedProvider: adapter.accountProvider,
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
        // Failed/cancelled login leaves no zombie profile behind. A
        // just-terminated console login (`start /wait` detaches the TUI)
        // may still hold files inside the directory on Windows — deletion
        // is best-effort with short async retries rather than propagating
        // EPERM back to the renderer.
        const ref = pendingProfile.runtimeProfileRef;
        void (async () => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            try {
              profileManager.deleteProfile(ref);
              return;
            } catch {
              await new Promise((r) => setTimeout(r, 1000));
            }
          }
        })();
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
        const status = await probeAccountStatus(
          adapter,
          runtime.executable,
          profileDir,
          controller.signal,
        );
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
          if (typeof adapter.prepareSession === "function") {
            await adapter.prepareSession({
              executablePath: runtime.executable,
              profileDir,
              baseEnv: deps.env,
              runner,
              timeoutMs: statusTimeoutMs,
              signal: controller.signal,
            });
          }
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
      const status = await probeAccountStatus(
        adapter,
        runtime.executable,
        profileDir,
        controller.signal,
      );
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
      if (catalog && catalog.ok === false) {
        return fail(
          catalog.code || CONNECTION_OP_CODES.MODEL_DISCOVERY_UNAVAILABLE,
        );
      }
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

      // Provider-specific session prerequisites (Devin org pinning) —
      // best-effort, the smoke itself reports failure if they are unmet.
      if (typeof adapter.prepareSession === "function") {
        await adapter.prepareSession({
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
          runner,
          timeoutMs: statusTimeoutMs,
          signal: controller.signal,
        });
      }

      // Multi-provider runtimes must pin the smoke to the account
      // provider's route; adapters can normalize, refuse foreign routes,
      // or discover a model when none was supplied.
      let smokeModel = model;
      if (typeof adapter.resolveSmokeModel === "function") {
        const resolvedModel = await adapter.resolveSmokeModel({
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
          runner,
          timeoutMs: modelsTimeoutMs,
          signal: controller.signal,
          model,
        });
        if (resolvedModel.error) {
          return fail(resolvedModel.error);
        }
        smokeModel = resolvedModel.model;
      }

      fs.mkdirSync(smokeWorkRoot, { recursive: true });
      workDir = fs.mkdtempSync(
        path.join(smokeWorkRoot, `${adapter.backendKind.toLowerCase()}-smoke-`),
      );
      const invocation = adapter.buildSmokeInvocation({
        executablePath: runtime.executable,
        profileDir,
        baseEnv: deps.env,
        workingDirectory: workDir,
        model: smokeModel,
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

  // Business TEXT_ONLY execution. Reached only through the authenticated
  // internal execution endpoint (backend → desktop), never through the
  // renderer IPC surface. The minted ticket is redeemed for the trusted
  // connection binding; the prompt is business data that rides the
  // adapter's locked-down one-shot invocation — piped stdin or a
  // --prompt-file inside the fresh Vocatrya-owned temp cwd, never an argv
  // element. No install, login, reconnect, file access, or
  // working-directory override is possible from here.
  // `verificationProbe` is an in-process-only flag for the structured-output
  // validation harness (scripts/structured-output-probe.mts) — it lets the
  // probe exercise runtimes whose structuredOutput.verification is still
  // PENDING. It is deliberately NOT part of the HTTP contract: execute-server
  // never forwards it, so backend business calls always run the gate.
  async function executeText({
    ticket,
    connectionId,
    model,
    prompt,
    structuredOutput,
    verificationProbe = false,
    timeoutMs,
    signal,
  } = {}) {
    const guardKeys = [`ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    // The caller's deadline also aborts the child process tree.
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      return fail(CONNECTION_OP_CODES.INFERENCE_FAILED);
    }
    let workDir = null;
    const startedAt = Date.now();
    let execRegistered = false;
    // Once the ticket resolves, the operation is always reported complete —
    // the ticket is spent whether the invocation ran or a gate refused it.
    let completedOperationId = null;
    const completeResolved = async () => {
      if (!completedOperationId) return;
      try {
        await backend.completeOperation(completedOperationId, {
          outcome: "consumed",
        });
      } catch {
        // Completion is best-effort hygiene; the ticket TTL sweeps it.
      }
      completedOperationId = null;
    };
    try {
      const resolved = await resolveOperation(ticket, "executeText", connectionId);
      if (resolved.error) return resolved.error;
      const { adapter, connection } = resolved;
      completedOperationId = resolved.resolved.operationId;

      // Connection status is re-gated here even though the backend checked
      // it before minting — the row is the source of truth at run time.
      if (connection.status === "REAUTH_REQUIRED") {
        return fail(CONNECTION_OP_CODES.REAUTH_REQUIRED);
      }
      if (connection.status === "DISCONNECTED") {
        return fail(CONNECTION_OP_CODES.CONNECTION_DISCONNECTED);
      }
      if (connection.status !== "CONNECTED") {
        return fail(CONNECTION_OP_CODES.CONNECTION_ERROR);
      }

      // TEXT_ONLY readiness: the runtime must implement the lifecycle and
      // expose headless one-shot execution. This is the desktop-side
      // equivalent of checkTextOnlyExecutionReadiness — the descriptor is
      // resolved locally from the bound backendKind.
      const execCaps = getAccountRuntimeCapabilities(adapter.backendKind);
      if (!execCaps?.execution?.localOneShot) {
        return fail(CONNECTION_OP_CODES.PERMISSION_BOUNDARY_NOT_READY);
      }

      // Structured-output freeze: a business structured request may only
      // run on a runtime whose mechanism completed real managed
      // verification (verification === "PASS") for the version actually
      // installed. PENDING/FAIL/UNSUPPORTED runtimes — including ones
      // whose adapter mechanically supports a schema flag — are refused
      // here at the trusted boundary. Only the in-process verification
      // probe may bypass this.
      const structuredCaps = structuredOutput
        ? execCaps?.structuredOutput
        : null;
      if (
        structuredOutput &&
        verificationProbe !== true &&
        (!structuredCaps ||
          structuredCaps.strategy === "UNSUPPORTED" ||
          structuredCaps.verification !== "PASS")
      ) {
        return fail(CONNECTION_OP_CODES.STRUCTURED_OUTPUT_NOT_VERIFIED);
      }

      execAcquire(connection.id);
      execRegistered = true;

      const runtime = resolveRuntime(adapter, "exec");
      if (runtime.error) return runtime.error;

      // The verified structured contract is bound to the probed version —
      // a different installed version is an unverified surface, never a
      // silent accept and never an automatic update.
      // Cache-managed runtimes (Devin) are gated by the per-version
      // capability snapshot after the profile/model are ready (below);
      // every other runtime keeps the exact-version binding.
      const structuredByCache =
        Boolean(structuredOutput) &&
        capabilityCache.manages(adapter.backendKind);
      if (
        structuredOutput &&
        !structuredByCache &&
        verificationProbe !== true &&
        runtime.version !== structuredCaps.verifiedRuntimeVersion
      ) {
        return fail(CONNECTION_OP_CODES.STRUCTURED_OUTPUT_NOT_VERIFIED);
      }
      const profileDir = profileManager.ensureProfile(
        connection.runtimeProfileRef,
      );

      if (typeof adapter.prepareSession === "function") {
        await adapter.prepareSession({
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
          runner,
          timeoutMs: statusTimeoutMs,
          signal: controller.signal,
        });
      }

      // Multi-provider runtimes validate/normalize the requested model
      // route; single-provider adapters pass the model through unchanged.
      let execModel = model;
      if (typeof adapter.resolveSmokeModel === "function") {
        const resolvedModel = await adapter.resolveSmokeModel({
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
          runner,
          timeoutMs: modelsTimeoutMs,
          signal: controller.signal,
          model,
        });
        if (resolvedModel.error) {
          return fail(resolvedModel.error);
        }
        execModel = resolvedModel.model;
      }

      if (structuredByCache && verificationProbe !== true) {
        const code = await capabilityGate({
          adapter,
          runtime,
          profileDir,
          model: execModel,
          dimension: "structured",
          notVerifiedCode: CONNECTION_OP_CODES.STRUCTURED_OUTPUT_NOT_VERIFIED,
          signal: controller.signal,
        });
        if (code) return fail(code);
      }

      const execRoot = execWorkRoot || smokeWorkRoot;
      fs.mkdirSync(execRoot, { recursive: true });
      workDir = fs.mkdtempSync(
        path.join(execRoot, `${adapter.backendKind.toLowerCase()}-exec-`),
      );
      const invocationInput = {
        executablePath: runtime.executable,
        profileDir,
        baseEnv: deps.env,
        workingDirectory: workDir,
        model: execModel,
        prompt,
      };
      // Structured-output probe contract: when the request carries a
      // Vocatrya-owned schema and the adapter exposes a native schema
      // transport, the schema rides the invocation itself (e.g.
      // codex --output-schema <file inside the fresh workDir>). Prompt-only
      // runtimes ignore the payload — the schema is already inside the
      // prompt — and the result reports which strategy actually ran. Any
      // schema file the adapter materializes lives inside workDir and is
      // removed with it in the finally below.
      let structuredStrategy = null;
      let invocation;
      if (
        structuredOutput &&
        (!structuredOutput.schema ||
          typeof structuredOutput.schema !== "object" ||
          Array.isArray(structuredOutput.schema) ||
          typeof structuredOutput.schemaName !== "string" ||
          structuredOutput.schemaName.length === 0)
      ) {
        return fail(CONNECTION_OP_CODES.STRUCTURED_OUTPUT_UNSUPPORTED);
      }
      if (structuredOutput) {
        if (typeof adapter.buildStructuredInvocation === "function") {
          try {
            invocation = adapter.buildStructuredInvocation({
              ...invocationInput,
              schema: structuredOutput.schema,
              schemaName: structuredOutput.schemaName,
            });
          } catch {
            return fail(CONNECTION_OP_CODES.STRUCTURED_OUTPUT_UNSUPPORTED);
          }
          structuredStrategy = "NATIVE_JSON_SCHEMA";
        } else {
          invocation = adapter.buildTextInvocation(invocationInput);
          structuredStrategy = "PROMPT_AND_VALIDATE";
        }
      } else {
        invocation = adapter.buildTextInvocation(invocationInput);
      }
      const result = await runner({
        ...invocation,
        timeoutMs: Math.min(
          Math.max(timeoutMs ?? execTimeoutMs, 1_000),
          EXEC_MAX_TIMEOUT_MS,
        ),
        signal: controller.signal,
      });
      await completeResolved();
      if (result.timedOut) {
        return fail(CONNECTION_OP_CODES.AI_EXECUTION_TIMEOUT);
      }
      if (result.error || result.exitCode !== 0 || result.aborted) {
        diag({
          operation: "executeText",
          backendKind: adapter.backendKind,
          provider: connection.provider,
          executable: runtime.executable,
          version: runtime.version,
          model: execModel,
          cwd: workDir,
          exitCode: result.exitCode,
          signal: result.signal ?? null,
          timedOut: result.timedOut === true,
          aborted: result.aborted === true,
          stdoutLength: (result.stdout || "").length,
          stderrLength: (result.stderr || "").length,
          stderrSummary: summarizeSanitizedStderr(result.stderr),
          hasStructuredOutput: Boolean(structuredOutput),
          schemaByteLength: structuredOutput
            ? Buffer.byteLength(JSON.stringify(structuredOutput.schema))
            : 0,
          schemaName: structuredOutput?.schemaName || null,
        });
        return fail(CONNECTION_OP_CODES.INFERENCE_FAILED);
      }
      const { text, reportedError, stopReason } = adapter.extractText({
        result,
        workDir,
      });
      if (reportedError || !text) {
        diag({
          operation: "executeText",
          backendKind: adapter.backendKind,
          provider: connection.provider,
          executable: runtime.executable,
          version: runtime.version,
          model: execModel,
          cwd: workDir,
          reportedError: reportedError === true,
          stdoutLength: (result.stdout || "").length,
          stderrLength: (result.stderr || "").length,
          stderrSummary: summarizeSanitizedStderr(result.stderr),
          hasStructuredOutput: Boolean(structuredOutput),
          hasExtractedText: Boolean(text),
        });
        return fail(CONNECTION_OP_CODES.INFERENCE_FAILED);
      }
      return {
        ok: true,
        text,
        provider: connection.provider,
        backendKind: adapter.backendKind,
        model: execModel,
        connectionId: connection.id,
        durationMs: Date.now() - startedAt,
        structuredStrategy,
        stopReason: typeof stopReason === "string" ? stopReason : null,
      };
    } finally {
      if (signal) signal.removeEventListener("abort", onExternalAbort);
      if (execRegistered) execRelease(connectionId);
      release(guardKeys);
      await completeResolved();
      if (workDir) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }
  }

  // Streaming TEXT_ONLY execution — in-process diagnostic/validation seam
  // for VOCATRYA_ACCOUNT_RUNTIME_STREAMING_VALIDATION. Same security
  // boundary as executeText (ticket → connection binding → managed profile
  // → locked-down invocation in a fresh Vocatrya-owned cwd, shell:false),
  // plus two additions:
  //   - the adapter's streaming invocation is observed live through the
  //     runner's binary stdout observer; the vendor stream is normalized
  //     into {text-delta|completed|error} events with arrival offsets and
  //     forwarded to the optional onEvent callback
  //   - the delta concatenation is reconciled against the canonical final
  //     text (vendor terminal event or adapter.extractText), so a
  //     completed run can never silently disagree with its own stream
  // Business gating mirrors the structured-output freeze: without
  // verificationProbe (in-process only) the runtime must carry
  // execution.streaming + streamingVerification PASS bound to the
  // installed version, otherwise STREAMING_NOT_VERIFIED. Abort resolves to
  // the stable ABORTED code — never generic INFERENCE_FAILED — and no
  // events are delivered after the terminal abort.
  async function executeTextStream({
    ticket,
    connectionId,
    model,
    prompt,
    onEvent,
    verificationProbe = false,
    timeoutMs,
    signal,
  } = {}) {
    const guardKeys = [`ticket:${ticket}`];
    const controller = acquire(guardKeys);
    if (!controller) {
      return fail(CONNECTION_OP_CODES.LOGIN_ALREADY_IN_PROGRESS);
    }
    const onExternalAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", onExternalAbort, { once: true });
    }
    if (typeof prompt !== "string" || prompt.length === 0) {
      return fail(CONNECTION_OP_CODES.INFERENCE_FAILED);
    }
    let workDir = null;
    let runtimeMeta = null;
    const startedAt = Date.now();
    let execRegistered = false;
    let completedOperationId = null;
    const completeResolved = async () => {
      if (!completedOperationId) return;
      try {
        await backend.completeOperation(completedOperationId, {
          outcome: "consumed",
        });
      } catch {
        // Completion is best-effort hygiene; the ticket TTL sweeps it.
      }
      completedOperationId = null;
    };

    // Ordered normalized events with arrival offsets — the probe's timing
    // evidence (firstTextDeltaAt < completedAt) comes from these.
    const streamEvents = [];
    let deltaCount = 0;
    let deltaChunkCount = 0;
    let totalDeltaChars = 0;
    let firstDeltaOffsetMs = null;
    let lastDeltaOffsetMs = null;
    let completedOffsetMs = null;
    let terminalErrorCode = null;

    const emit = (event) => {
      const offsetMs = Date.now() - startedAt;
      if (
        event.type === "text-delta" &&
        typeof event.delta === "string" &&
        event.delta.length > 0
      ) {
        deltaCount += 1;
        totalDeltaChars += event.delta.length;
        if (firstDeltaOffsetMs === null) firstDeltaOffsetMs = offsetMs;
        lastDeltaOffsetMs = offsetMs;
      } else if (event.type === "completed") {
        completedOffsetMs = offsetMs;
      } else if (event.type === "error") {
        terminalErrorCode = event.code;
      }
      streamEvents.push({ ...event, offsetMs });
      // Observers are never called after abort — a late delta must not be
      // presented as delivered content.
      if (typeof onEvent === "function" && !controller.signal.aborted) {
        try {
          onEvent(event);
        } catch {
          // An observer failure must never break the run.
        }
      }
    };

    const streamStats = (extra) => ({
      deltaCount,
      deltaChunkCount,
      totalDeltaChars,
      firstDeltaOffsetMs,
      lastDeltaOffsetMs,
      completedOffsetMs,
      eventCount: streamEvents.length,
      ...(extra || {}),
    });

    const withRuntime = (payload) => {
      if (!runtimeMeta) return payload;
      const safe = { ...runtimeMeta, threadReuseHit: false };
      return {
        ...payload,
        runtime: safe,
        stream: payload.stream ? { ...payload.stream, ...safe } : payload.stream,
      };
    };

    try {
      const resolved = await resolveOperation(
        ticket,
        "executeText",
        connectionId,
      );
      if (resolved.error) return resolved.error;
      const { adapter, connection } = resolved;
      completedOperationId = resolved.resolved.operationId;

      if (
        codexPersistentRuntime &&
        adapter.backendKind === CODEX_BACKEND_KIND &&
        (connection.status !== "CONNECTED" || connection.archivedAt)
      ) {
        codexPersistentRuntime.retireConnection(connection.id, "status");
      }
      if (connection.status === "REAUTH_REQUIRED") {
        return fail(CONNECTION_OP_CODES.REAUTH_REQUIRED);
      }
      if (connection.status === "DISCONNECTED") {
        return fail(CONNECTION_OP_CODES.CONNECTION_DISCONNECTED);
      }
      if (connection.status !== "CONNECTED") {
        return fail(CONNECTION_OP_CODES.CONNECTION_ERROR);
      }

      const execCaps = getAccountRuntimeCapabilities(adapter.backendKind);
      if (!execCaps?.execution?.localOneShot) {
        return fail(CONNECTION_OP_CODES.PERMISSION_BOUNDARY_NOT_READY);
      }
      // The adapter must actually expose a streaming path — a missing hook
      // is a mechanism gap, not a verification gap.
      if (
        typeof adapter.buildStreamingInvocation !== "function" ||
        typeof adapter.createStreamParser !== "function"
      ) {
        return fail("STREAM_PROTOCOL_UNSUPPORTED");
      }
      // Business gate (verificationProbe bypasses — in-process only, same
      // contract as the structured-output probe): streaming must be a
      // verified capability of the runtime version actually installed.
      if (
        verificationProbe !== true &&
        (execCaps.execution.streaming !== true ||
          execCaps.execution.streamingVerification !== "PASS")
      ) {
        return fail("STREAMING_NOT_VERIFIED");
      }

      execAcquire(connection.id);
      execRegistered = true;

      const runtime = resolveRuntime(adapter, "exec");
      if (runtime.error) return runtime.error;
      // Cache-managed runtimes (Devin) are gated by the per-version
      // capability snapshot once the profile/model are ready (below).
      const streamingByCache = capabilityCache.manages(adapter.backendKind);
      if (
        verificationProbe !== true &&
        !streamingByCache &&
        !streamingRuntimeVersionMatches(
          execCaps.execution.streamingVerifiedRuntimeVersion,
          runtime.version,
        )
      ) {
        if (
          codexPersistentRuntime &&
          adapter.backendKind === CODEX_BACKEND_KIND &&
          connection.userId
        ) {
          codexPersistentRuntime.retireVersionSkew({
            userId: connection.userId,
            connectionId: connection.id,
            runtimeVersion: runtime.version,
          });
        }
        return fail("STREAMING_NOT_VERIFIED");
      }
      const profileDir = profileManager.ensureProfile(
        connection.runtimeProfileRef,
      );

      if (typeof adapter.prepareSession === "function") {
        await adapter.prepareSession({
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
          runner,
          timeoutMs: statusTimeoutMs,
          signal: controller.signal,
        });
      }

      let execModel = model;
      if (typeof adapter.resolveSmokeModel === "function") {
        const resolvedModel = await adapter.resolveSmokeModel({
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
          runner,
          timeoutMs: modelsTimeoutMs,
          signal: controller.signal,
          model,
        });
        if (resolvedModel.error) {
          return fail(resolvedModel.error);
        }
        execModel = resolvedModel.model;
      }

      if (streamingByCache && verificationProbe !== true) {
        const code = await capabilityGate({
          adapter,
          runtime,
          profileDir,
          model: execModel,
          dimension: "streaming",
          notVerifiedCode: "STREAMING_NOT_VERIFIED",
          signal: controller.signal,
        });
        if (code) return fail(code);
      }

      const execRoot = execWorkRoot || smokeWorkRoot;
      fs.mkdirSync(execRoot, { recursive: true });
      workDir = fs.mkdtempSync(
        path.join(execRoot, `${adapter.backendKind.toLowerCase()}-stream-`),
      );
      const boundedTimeout = Math.min(
        Math.max(timeoutMs ?? execTimeoutMs, 1_000),
        EXEC_MAX_TIMEOUT_MS,
      );
      let result = null;
      let parserStats = {};
      const deliverStdoutEvents = (events) => {
        if (controller.signal.aborted) return;
        let producedDelta = false;
        for (const event of events) {
          if (
            event.type === "text-delta" &&
            typeof event.delta === "string" &&
            event.delta.length > 0
          ) {
            producedDelta = true;
          }
          emit(event);
        }
        if (producedDelta) deltaChunkCount += 1;
      };
      // Foreground Codex streaming reuses one app-server per isolation
      // key. A busy key gets an isolated one-shot child so a second
      // conversation is not queued behind the first generation. Summary
      // and structured exec never enter this branch.
      const usePool =
        codexPersistentRuntime &&
        adapter.backendKind === CODEX_BACKEND_KIND &&
        typeof connection.userId === "string" &&
        connection.userId.length > 0;
      if (usePool) {
        const lease = await codexPersistentRuntime.acquire({
          userId: connection.userId,
          connectionId: connection.id,
          resolvedModel: execModel,
          runtimeVersion: runtime.version,
          runtimeProfileRef: connection.runtimeProfileRef,
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
          status: connection.status,
          archived: Boolean(connection.archivedAt),
          timeoutMs: boundedTimeout,
          signal: controller.signal,
        });
        runtimeMeta = lease.meta || null;
        if (lease.kind === "aborted") {
          result = { aborted: true, timedOut: false, exitCode: null, error: null };
        } else if (lease.kind === "failed") {
          result = {
            aborted: false,
            timedOut: lease.timedOut === true,
            exitCode: lease.timedOut ? null : 1,
            error: lease.timedOut ? null : "persistent-runtime-failed",
          };
        } else if (lease.kind === "fresh" || lease.kind === "reuse") {
          result = await codexPersistentRuntime.runTurn(lease.entry, {
            prompt,
            model: execModel,
            workingDirectory: workDir,
            timeoutMs: boundedTimeout,
            signal: controller.signal,
            onEvent: (event) => deliverStdoutEvents([event]),
          });
        }
      }
      if (!result) {
        const invocation = adapter.buildStreamingInvocation({
          executablePath: runtime.executable,
          profileDir,
          baseEnv: deps.env,
          workingDirectory: workDir,
          model: execModel,
          prompt,
        });
        // Protocol drivers (codex app-server) need the turn params to write
        // their JSON-RPC handshake; plain mappers ignore the context.
        const parser = adapter.createStreamParser({
          prompt,
          model: execModel,
          workingDirectory: workDir,
        });
        result = await runner({
          ...invocation,
          timeoutMs: boundedTimeout,
          signal: controller.signal,
          binaryStdout: true,
          // stdio-protocol adapters get the child's stdin the moment it
          // exists — the handshake cannot wait for first output.
          ...(typeof parser.attachStdin === "function"
            ? { onStdinReady: (stdin) => parser.attachStdin(stdin) }
            : {}),
          onStdout: (chunk) => {
            if (controller.signal.aborted) return;
            deliverStdoutEvents(parser.push(chunk));
          },
        });
        // Flush the parser only for a run that actually completed — abort and
        // timeout leave the stream terminal without a completed event.
        if (!result.aborted && !controller.signal.aborted) {
          for (const event of parser.finish()) emit(event);
        }
        parserStats =
          typeof parser.stats === "function" ? parser.stats() : {};
      }
      await completeResolved();

      if (result.aborted || controller.signal.aborted) {
        // Terminal abort event is recorded and delivered even though the
        // controller is aborted — deltas are suppressed, the terminal
        // state is not.
        const abortEvent = {
          type: "error",
          code: "ABORTED",
          offsetMs: Date.now() - startedAt,
        };
        streamEvents.push(abortEvent);
        if (typeof onEvent === "function") {
          try {
            onEvent(abortEvent);
          } catch {
            // An observer failure must never break the run.
          }
        }
        return withRuntime({
          ok: false,
          code: "ABORTED",
          stream: streamStats({ ...parserStats, aborted: true }),
        });
      }
      if (result.timedOut) {
        return withRuntime({
          ok: false,
          code: CONNECTION_OP_CODES.AI_EXECUTION_TIMEOUT,
          stream: streamStats(parserStats),
        });
      }
      if (result.error || result.exitCode !== 0) {
        diag({
          operation: "executeTextStream",
          exitCode: result.exitCode,
        });
        return withRuntime({
          ok: false,
          code: CONNECTION_OP_CODES.INFERENCE_FAILED,
          stream: streamStats(parserStats),
        });
      }
      if (terminalErrorCode) {
        diag({
          operation: "executeTextStream",
          code: terminalErrorCode,
        });
        return withRuntime({
          ok: false,
          code:
            terminalErrorCode === "STREAM_COMPLETION_INCONSISTENT"
              ? "STREAM_COMPLETION_INCONSISTENT"
              : CONNECTION_OP_CODES.INFERENCE_FAILED,
          stream: streamStats(parserStats),
        });
      }

      // Deterministic reconstruction: the delta concatenation must equal
      // the canonical final text — the vendor terminal text when the
      // protocol carries one, else the adapter's extracted text, else the
      // concatenation itself (the vendor emitted no separate envelope).
      const deltaText = streamEvents
        .filter((e) => e.type === "text-delta")
        .map((e) => e.delta)
        .join("");
      const completedEvent = [...streamEvents]
        .reverse()
        .find((e) => e.type === "completed");
      let canonical =
        typeof completedEvent?.text === "string" ? completedEvent.text : null;
      if (canonical === null) {
        // extractStreamText (when the adapter defines it) is the
        // streaming-run extractor — protocol channels like JSON-RPC must
        // never let generic output scraping pick up a framed line as the
        // canonical answer.
        const extractor =
          typeof adapter.extractStreamText === "function"
            ? adapter.extractStreamText
            : adapter.extractText;
        const extracted = extractor({ result, workDir });
        if (
          !extracted?.reportedError &&
          typeof extracted?.text === "string" &&
          extracted.text.length > 0
        ) {
          canonical = extracted.text;
        }
      }
      let reconstruction;
      if (canonical === null) {
        reconstruction = deltaText.length > 0 ? "DELTA_ONLY" : "NONE";
      } else if (deltaText === canonical) {
        reconstruction = "MATCH";
      } else if (deltaText.trim() === canonical.trim()) {
        // Whitespace-only difference — a canonicalization artifact of the
        // vendor envelope, not a reconstruction failure.
        reconstruction = "MATCH_TRIMMED";
      } else {
        reconstruction = "MISMATCH";
      }
      if (reconstruction === "MISMATCH") {
        diag({ operation: "executeTextStream", code: "RECONSTRUCTION_MISMATCH" });
        return withRuntime({
          ok: false,
          code: "STREAM_COMPLETION_INCONSISTENT",
          stream: streamStats({ ...parserStats, reconstruction }),
        });
      }
      const text = canonical !== null ? canonical : deltaText;
      if (!text) {
        return withRuntime({
          ok: false,
          code: CONNECTION_OP_CODES.INFERENCE_FAILED,
          stream: streamStats({ ...parserStats, reconstruction }),
        });
      }
      return withRuntime({
        ok: true,
        text,
        provider: connection.provider,
        backendKind: adapter.backendKind,
        model: execModel,
        connectionId: connection.id,
        runtimeVersion: runtime.version,
        durationMs: Date.now() - startedAt,
        stream: streamStats({
          ...parserStats,
          reconstruction,
          mechanism: adapter.streamMechanism ?? null,
          aborted: false,
        }),
      });
    } finally {
      if (runtimeMeta) {
        diag({
          operation: "executeTextStream",
          runtimeReuseHit: runtimeMeta.runtimeReuseHit === true,
          runtimeProcessAgeMs: runtimeMeta.runtimeProcessAgeMs ?? null,
          runtimeProcessId: runtimeMeta.runtimeProcessId ?? null,
          runtimeIdleMs: runtimeMeta.runtimeIdleMs ?? null,
          runtimeSpawnMs: runtimeMeta.runtimeSpawnMs ?? null,
          runtimeInitMs: runtimeMeta.runtimeInitMs ?? null,
          runtimeRestartReason: runtimeMeta.runtimeRestartReason ?? null,
          threadReuseHit: false,
        });
      }
      if (signal) signal.removeEventListener("abort", onExternalAbort);
      if (execRegistered) execRelease(connectionId);
      release(guardKeys);
      await completeResolved();
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

  // Non-ticketed capability probe for the backend's readiness pre-flight:
  // reports the static capability descriptor plus the version actually
  // probed on the installed binary. No credential, profile path, or
  // connection state crosses this boundary — the internal bearer is the
  // same one guarding the execution endpoint, and the result is exactly
  // what the local gates would consult anyway.
  async function executeNativeSession({ ticket, connectionId, model, prompt, instructions, nativeSession, onEvent, timeoutMs, signal } = {}) {
    if (nativeDisposed || !nativeSession || typeof nativeSession.conversationId !== "string") return fail("NATIVE_BOUNDARY_NOT_READY");
    const keys = [`ticket:${ticket}`, `native:${connectionId}:${nativeSession.conversationId}`];
    const controller = acquire(keys);
    if (!controller) return fail("NATIVE_BUSY");
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    let operationId = null;
    let registered = false;
    try {
      const resolved = await resolveOperation(ticket, "executeText", connectionId);
      if (resolved.error) return resolved.error;
      operationId = resolved.resolved.operationId;
      const { adapter, connection } = resolved;
      if (adapter.backendKind !== CODEX_BACKEND_KIND) return fail("NATIVE_BOUNDARY_NOT_READY");
      if (connection.status !== "CONNECTED") return fail(connection.status === "REAUTH_REQUIRED" ? "REAUTH_REQUIRED" : "CONNECTION_DISCONNECTED");
      if (controller.signal.aborted) return fail("NATIVE_CANCELLED");
      const runtime = resolveRuntime(adapter, "native");
      if (runtime.error) return runtime.error;
      if (!nativeSessionReady(runtime.version, model)) return fail("NATIVE_BOUNDARY_NOT_READY");
      const identity = { runtimeVersion: runtime.version, runtimeProfileRef: connection.runtimeProfileRef, configHash: NATIVE_CONFIG_HASH };
      if (nativeSession.threadId && Object.entries(identity).some(([key, value]) => nativeSession[key] !== value)) return fail("NATIVE_IDENTITY_MISMATCH");
      // Managed profiles are established by login. Missing profiles cannot be
      // silently recreated and treated as resumable sessions.
      if (!profileManager.profileExists(connection.runtimeProfileRef)) return fail("REAUTH_REQUIRED");
      const profileDir = profileManager.resolveProfileDir(connection.runtimeProfileRef);
      const scope = createHash("sha256").update(`${connection.userId}:${nativeSession.conversationId}`).digest("hex");
      const cwd = path.join(execWorkRoot || smokeWorkRoot, "codex-native", scope);
      fs.mkdirSync(cwd, { recursive: true });
      if (activeOps.has(`conn:${connection.id}`)) return fail("NATIVE_BUSY");
      execAcquire(connection.id); registered = true;
      const invocation = adapter.buildStreamingInvocation({ executablePath: runtime.executable, profileDir, baseEnv: deps.env, workingDirectory: cwd });
      const execution = runNativeSession({ expectedVersion: runtime.version, invocation, model, prompt, instructions, threadId: nativeSession.threadId, profileDir,
        signal: controller.signal, timeoutMs: Math.min(timeoutMs || execTimeoutMs, EXEC_MAX_TIMEOUT_MS), runner,
        onEvent: event => { if (!controller.signal.aborted) onEvent?.(event.type === "native-session" ? { ...event, ...identity } : event); },
      });
      nativeRuns.add(execution);
      try { return await execution; } finally { nativeRuns.delete(execution); }
    } catch { return fail("NATIVE_PROTOCOL_ERROR"); }
    finally {
      if (registered) execRelease(connectionId);
      if (operationId) { try { await backend.completeOperation(operationId, { outcome: "consumed" }); } catch { /* ticket TTL */ } }
      signal?.removeEventListener("abort", abort);
      release(keys);
    }
  }

  function runtimeState({ backendKind, accountProvider } = {}) {
    const adapter = bindAdapter(backendKind, accountProvider);
    if (!adapter) {
      return { ok: false, code: CONNECTION_OP_CODES.UNSUPPORTED_BACKEND };
    }
    const baseCapabilities =
      getAccountRuntimeCapabilities(adapter.backendKind) || null;
    const runtime = resolveRuntime(adapter, "exec");
    // Cache-managed runtimes report the verdict for the installed build, so
    // every downstream version comparison (backend, UI) follows the cache.
    const capabilities = capabilityCache.overlayDescriptor(
      baseCapabilities,
      runtime.error ? null : runtime.version,
    );
    if (runtime.error) {
      return {
        ok: true,
        capabilities,
        runtimeVersion: null,
        runtimeReady: false,
        runtimeCode: runtime.error.code,
        ...(runtime.installs ? { installs: runtime.installs, verifiedVersions: runtime.verifiedVersions } : {}),
      };
    }
    return {
      ok: true,
      capabilities,
      runtimeVersion: runtime.version,
      runtimeReady: true,
      ...(runtime.installs ? { runtimePath: runtime.executable, installs: runtime.installs, verifiedVersions: runtime.verifiedVersions } : {}),
      // runtimeVersion/runtimePath = the streaming/exec binary; the native binary
      // is selected separately (nativeSession.runtimeVersion/runtimePath).
      nativeSession: adapter.backendKind === CODEX_BACKEND_KIND ? (() => {
        const native = resolveRuntime(adapter, "native");
        const nativeVersion = native.error ? null : native.version;
        return { version: NATIVE_VERSION, verifiedVersions: [...NATIVE_VERIFIED_VERSIONS], models: NATIVE_MODELS, configHash: NATIVE_CONFIG_HASH, runtimeVersion: nativeVersion, runtimePath: native.error ? null : native.executable, ready: NATIVE_VERIFIED_VERSIONS.includes(nativeVersion) };
      })() : null,
    };
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
    executeText,
    executeTextStream,
    executeNativeSession,
    runtimeState,
    capabilityCache,
    // Explicit re-verify: forget this runtime's cached verdicts so the next
    // use probes again. TODO: expose as a Settings "Re-verify" button.
    resetRuntimeCapabilities(backendKind) {
      capabilityCache.clear(backendKind);
      return { ok: true };
    },
    async dispose() {
      nativeDisposed = true;
      for (const [key, controller] of activeOps) if (key.startsWith("native:")) controller.abort();
      await Promise.allSettled([...nativeRuns]);
      try {
        await codexPersistentRuntime?.disposeAll();
      } catch {
        // Process-tree cleanup on quit is best-effort.
      }
    },
  };
}

module.exports = {
  CONNECTION_OP_CODES,
  LOGIN_TIMEOUT_MS,
  PROVIDER_ADAPTERS,
  createConnectionService,
};

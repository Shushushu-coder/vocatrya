// Process-local pool of Codex app-server children for foreground
// Career Dialogue streaming. One process per isolation key, one active
// turn at a time, a new Codex thread on every Vocatrya turn.
//
// The pool does not own transcripts, tool state, approvals, or summary
// state. Structured `codex exec` and P3 summary generation must not
// acquire it. Nothing here is written to the database: a desktop restart
// starts from an empty map.
//
// V1 key (deliberately conservative — model reuse across threads was
// observed, but cross-model sharing stays out of this change):
//   userId + connectionId + resolvedModel + runtimeVersion + configFingerprint
//
// Busy policy: if the pooled process is already in a turn, the caller
// gets a one-shot non-pooled process. Turns are not queued. A busy
// process is never killed to satisfy the per-user cap.
//
// Abort, timeout, crash, and fatal protocol errors retire the process.
// A clean turn/completed failure (model refusal / vendor error with
// valid framing) keeps it. Stderr alone does not retire a live process;
// Codex logs on stderr during healthy turns.
const crypto = require("node:crypto");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const { terminateChildTree } = require("../runtime");
const { NETWORK_ENV_PASSTHROUGH } = require("./environment");
const { createCodexStreamParser } = require("./streaming");

const MAX_PERSISTENT_CODEX_PROCESSES_PER_USER = 3;
const PERSISTENT_CODEX_IDLE_TTL_MS = 10 * 60 * 1000;

const FINGERPRINT_ENV_KEYS = Object.freeze([
  "CODEX_HOME",
  ...NETWORK_ENV_PASSTHROUGH,
]);

function stableStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

// Hash of non-secret runtime inputs captured at spawn. Proxy values are
// inside the hash so a config change retires the child; the preimage is
// never logged.
function fingerprintInvocation(invocation, identity) {
  const env = invocation?.env || {};
  const trackedEnv = {};
  for (const key of FINGERPRINT_ENV_KEYS) {
    if (typeof env[key] === "string" && env[key]) trackedEnv[key] = env[key];
  }
  const payload = {
    executable: invocation?.executable ?? null,
    runtimeVersion: identity.runtimeVersion,
    runtimeProfileRef: identity.runtimeProfileRef,
    sandbox: "read-only",
    approvalPolicy: "never",
    resolvedModel: identity.resolvedModel,
    env: trackedEnv,
  };
  return crypto
    .createHash("sha256")
    .update(stableStringify(payload))
    .digest("hex");
}

function isolationKey(identity, configFingerprint) {
  return [
    identity.userId,
    identity.connectionId,
    identity.resolvedModel,
    identity.runtimeVersion,
    configFingerprint,
  ].join("\0");
}

function emptyRuntimeMeta() {
  return {
    runtimeReuseHit: false,
    runtimeProcessAgeMs: null,
    runtimeProcessId: null,
    runtimeIdleMs: null,
    runtimeSpawnMs: null,
    runtimeInitMs: null,
    runtimeRestartReason: null,
    threadReuseHit: false,
  };
}

function processAlive(child) {
  if (!child || child.killed) return false;
  if (child.exitCode !== null && child.exitCode !== undefined) return false;
  if (child.signalCode) return false;
  const stdinOk = child.stdin && child.stdin.destroyed !== true;
  const stdoutOk = child.stdout && child.stdout.destroyed !== true;
  return Boolean(stdinOk && stdoutOk);
}

function createCodexPersistentRuntimeManager({
  spawnImpl = spawn,
  terminateImpl = terminateChildTree,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  stableCwd,
  buildInvocation,
  maxPerUser = MAX_PERSISTENT_CODEX_PROCESSES_PER_USER,
  ttlMs = PERSISTENT_CODEX_IDLE_TTL_MS,
} = {}) {
  if (typeof buildInvocation !== "function") {
    throw new Error("buildInvocation is required");
  }
  if (typeof stableCwd !== "string" || stableCwd.length === 0) {
    throw new Error("stableCwd is required");
  }
  const spawnProcess = spawnImpl || spawn;
  const terminateProcess = terminateImpl || terminateChildTree;
  const clock = typeof now === "function" ? now : Date.now;
  const armTimer = setTimer || setTimeout;
  const disarmTimer = clearTimer || clearTimeout;

  const entries = new Map();
  // Replacement processes report why the previous child for the same
  // user/connection/model was retired. The isolation key includes version
  // and fingerprint, so the reason cannot be stored on that key.
  const restartReasons = new Map();

  function reuseScope(entry) {
    return [entry.userId, entry.connectionId, entry.resolvedModel].join("\0");
  }

  function activeEntries() {
    return [...entries.values()].filter((entry) => !entry.disposed);
  }

  function metaFor(entry, { reuse }) {
    const timestamp = clock();
    const restartReason = reuse
      ? null
      : restartReasons.get(reuseScope(entry)) || null;
    if (!reuse) restartReasons.delete(reuseScope(entry));
    return {
      runtimeReuseHit: reuse,
      runtimeProcessAgeMs: timestamp - entry.createdAt,
      runtimeProcessId: entry.pid ?? null,
      runtimeIdleMs: timestamp - entry.lastUsedAt,
      runtimeSpawnMs: reuse ? 0 : entry.spawnMs,
      runtimeInitMs: reuse ? 0 : entry.initMs,
      runtimeRestartReason: restartReason,
      threadReuseHit: false,
    };
  }

  function disposeEntry(entryOrKey, reason) {
    const entry =
      typeof entryOrKey === "string" ? entries.get(entryOrKey) : entryOrKey;
    if (!entry || entry.disposed) return;
    entry.disposed = true;
    entry.dead = true;
    entry.busy = false;
    entries.delete(entry.key);
    restartReasons.set(reuseScope(entry), reason);
    const notify = entry.onUnexpectedExit;
    entry.onUnexpectedExit = null;
    const child = entry.child;
    entry.child = null;
    entry.session = null;
    try {
      terminateProcess(child);
    } catch {
      // Shutdown is best-effort. The OS process tree is the fallback.
    }
    if (typeof notify === "function") {
      try {
        notify();
      } catch {
        // The turn settler must not throw out of the exit handler.
      }
    }
  }

  function retireConnection(connectionId, reason = "status") {
    if (typeof connectionId !== "string" || !connectionId) return;
    for (const entry of activeEntries()) {
      if (entry.connectionId === connectionId) disposeEntry(entry, reason);
    }
  }

  function retireVersionSkew({ userId, connectionId, runtimeVersion } = {}) {
    for (const entry of activeEntries()) {
      if (entry.userId !== userId || entry.connectionId !== connectionId) {
        continue;
      }
      if (entry.runtimeVersion !== runtimeVersion) {
        disposeEntry(entry, "version");
      }
    }
  }

  function evictIdleForCap(userId) {
    const mine = activeEntries().filter((entry) => entry.userId === userId);
    if (mine.length < maxPerUser) return true;
    const idle = mine
      .filter((entry) => !entry.busy)
      .sort(
        (a, b) => a.lastUsedAt - b.lastUsedAt || a.createdAt - b.createdAt,
      );
    if (idle.length === 0) return false;
    disposeEntry(idle[0], "lru");
    return true;
  }

  function bindChild(entry, child) {
    entry.child = child;
    entry.pid = child.pid ?? null;
    if (child.stdout && typeof child.stdout.on === "function") {
      child.stdout.on("data", (chunk) => {
        if (entry.disposed || !entry.session) return;
        let events = [];
        try {
          events = entry.session.push(chunk);
        } catch {
          disposeEntry(entry, "protocol");
          return;
        }
        const deliver = entry.onEvents;
        if (typeof deliver === "function") deliver(events);
      });
    }
    const onExit = () => {
      if (entry.disposed) return;
      try {
        entry.session?.abandon?.("crash");
      } catch {
        // Rejecting the init waiter must not escape the exit handler.
      }
      disposeEntry(entry, "crash");
    };
    if (typeof child.once === "function") {
      child.once("exit", onExit);
      child.once("error", onExit);
    }
  }

  async function spawnEntry(identity, configFingerprint, invocation) {
    fs.mkdirSync(stableCwd, { recursive: true });
    const spawnedAt = clock();
    let child;
    try {
      child = spawnProcess(invocation.executable, invocation.args, {
        cwd: stableCwd,
        env: invocation.env,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      return null;
    }
    const session = createCodexStreamParser({ persistent: true });
    const ready = session.whenReady();
    ready.catch(() => {
      // Observed by acquire. Prevents an unhandled rejection when
      // initialize fails synchronously inside attachStdin.
    });
    const entry = {
      key: isolationKey(identity, configFingerprint),
      userId: identity.userId,
      connectionId: identity.connectionId,
      resolvedModel: identity.resolvedModel,
      runtimeVersion: identity.runtimeVersion,
      runtimeProfileRef: identity.runtimeProfileRef,
      configFingerprint,
      createdAt: spawnedAt,
      lastUsedAt: spawnedAt,
      busy: false,
      disposed: false,
      dead: false,
      pid: child?.pid ?? null,
      child,
      session,
      spawnMs: 0,
      initMs: 0,
      onEvents: null,
      onUnexpectedExit: null,
    };
    bindChild(entry, child);
    entries.set(entry.key, entry);
    const initStarted = clock();
    try {
      if (child.stdin) session.attachStdin(child.stdin);
    } catch {
      disposeEntry(entry, "protocol");
      return null;
    }
    let timer;
    const timedOut = new Promise((resolve) => {
      timer = armTimer(
        () => resolve("timeout"),
        identity.timeoutMs ?? ttlMs,
      );
    });
    let readyState;
    try {
      readyState = await Promise.race([
        ready.then(() => "ready"),
        timedOut,
      ]);
    } catch {
      readyState = "fatal";
    }
    disarmTimer(timer);
    if (identity.signal?.aborted) {
      disposeEntry(entry, "abort");
      return { aborted: true };
    }
    if (entry.disposed || readyState !== "ready" || !session.isReady()) {
      const reason = readyState === "timeout" ? "timeout" : "protocol";
      if (!entry.disposed) disposeEntry(entry, reason);
      return { timedOut: readyState === "timeout" };
    }
    entry.spawnMs = initStarted - spawnedAt;
    entry.initMs = clock() - initStarted;
    entry.initializedAt = clock();
    entry.lastUsedAt = clock();
    return entry;
  }

  function reusable(entry, identity, configFingerprint) {
    if (!entry || entry.disposed || entry.dead) return "dead";
    if (entry.runtimeVersion !== identity.runtimeVersion) return "version";
    if (entry.configFingerprint !== configFingerprint) return "config";
    if (entry.runtimeProfileRef !== identity.runtimeProfileRef) return "config";
    if (!entry.session || entry.session.isFatal() || !entry.session.isReady()) {
      return "protocol";
    }
    if (!processAlive(entry.child)) return "crash";
    if (!entry.busy && clock() - entry.lastUsedAt > ttlMs) return "ttl";
    return null;
  }

  async function acquire(identity) {
    if (!identity || identity.status !== "CONNECTED" || identity.archived) {
      if (identity?.connectionId) retireConnection(identity.connectionId, "status");
      return { kind: "unavailable", reason: "status", meta: emptyRuntimeMeta() };
    }
    if (identity.signal?.aborted) {
      return { kind: "aborted", meta: emptyRuntimeMeta() };
    }
    const invocation = buildInvocation({
      executablePath: identity.executablePath,
      profileDir: identity.profileDir,
      baseEnv: identity.baseEnv,
      workingDirectory: stableCwd,
      model: identity.resolvedModel,
    });
    const configFingerprint = fingerprintInvocation(invocation, identity);
    retireVersionSkew({
      userId: identity.userId,
      connectionId: identity.connectionId,
      runtimeVersion: identity.runtimeVersion,
    });
    for (const candidate of activeEntries()) {
      if (
        candidate.userId === identity.userId &&
        candidate.connectionId === identity.connectionId &&
        candidate.resolvedModel === identity.resolvedModel &&
        candidate.runtimeVersion === identity.runtimeVersion &&
        candidate.configFingerprint !== configFingerprint
      ) {
        disposeEntry(candidate, "config");
      }
    }
    const key = isolationKey(identity, configFingerprint);
    let entry = entries.get(key);
    if (entry) {
      const stale = reusable(entry, identity, configFingerprint);
      if (stale) {
        disposeEntry(entry, stale);
        entry = null;
      }
    }
    if (entry?.busy) {
      return {
        kind: "oneshot",
        reason: "busy",
        meta: emptyRuntimeMeta(),
      };
    }
    if (entry) {
      return { kind: "reuse", entry, meta: metaFor(entry, { reuse: true }) };
    }
    if (!evictIdleForCap(identity.userId)) {
      return { kind: "oneshot", reason: "cap", meta: emptyRuntimeMeta() };
    }
    const spawned = await spawnEntry(identity, configFingerprint, invocation);
    if (!spawned) {
      return {
        kind: "failed",
        meta: {
          ...emptyRuntimeMeta(),
          runtimeRestartReason:
            restartReasons.get(
              [identity.userId, identity.connectionId, identity.resolvedModel].join(
                "\0",
              ),
            ) || null,
        },
      };
    }
    if (spawned.aborted) {
      return { kind: "aborted", meta: emptyRuntimeMeta() };
    }
    if (spawned.timedOut || spawned.disposed || !spawned.session) {
      return {
        kind: "failed",
        timedOut: spawned.timedOut === true,
        meta: {
          ...emptyRuntimeMeta(),
          runtimeRestartReason:
            restartReasons.get(
              [identity.userId, identity.connectionId, identity.resolvedModel].join(
                "\0",
              ),
            ) || null,
        },
      };
    }
    return {
      kind: "fresh",
      entry: spawned,
      meta: metaFor(spawned, { reuse: false }),
    };
  }

  function runTurn(entry, {
    prompt,
    model,
    workingDirectory,
    timeoutMs,
    signal,
    onEvent,
  } = {}) {
    return new Promise((resolve) => {
      if (!entry || entry.disposed || !entry.session) {
        resolve({
          aborted: false,
          timedOut: false,
          exitCode: 1,
          error: "persistent-runtime-failed",
          threadId: null,
        });
        return;
      }
      let settled = false;
      let timer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer) disarmTimer(timer);
        if (signal) signal.removeEventListener("abort", onAbort);
        entry.onEvents = null;
        entry.onUnexpectedExit = null;
        const threadId = entry.session?.threadId?.() ?? null;
        try {
          entry.session?.clearTurnSecrets?.();
        } catch {
          // Clearing turn-local prompt state must not mask the result.
        }
        if (!entry.disposed) {
          entry.busy = false;
          entry.lastUsedAt = clock();
        }
        resolve({ threadId, ...result });
      };
      const onAbort = () => {
        entry.onUnexpectedExit = null;
        disposeEntry(entry, "abort");
        finish({
          aborted: true,
          timedOut: false,
          exitCode: null,
          error: null,
        });
      };
      entry.onUnexpectedExit = () => {
        finish({
          aborted: false,
          timedOut: false,
          exitCode: 1,
          error: "crashed",
        });
      };
      entry.onEvents = (events) => {
        if (settled) return;
        for (const event of events) {
          if (settled || signal?.aborted) break;
          if (typeof onEvent === "function") {
            try {
              onEvent(event);
            } catch {
              // Observer failures must not desync the process.
            }
          }
          if (signal?.aborted || settled) break;
          if (event.type === "completed" || event.type === "error") {
            const fatal = entry.session?.isFatal?.() === true;
            if (fatal) {
              entry.onUnexpectedExit = null;
              disposeEntry(entry, entry.session?.fatalReason?.() || "protocol");
            }
            finish({
              aborted: false,
              timedOut: false,
              exitCode: 0,
              error: null,
            });
          }
        }
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      timer = armTimer(() => {
        entry.onUnexpectedExit = null;
        disposeEntry(entry, "timeout");
        finish({
          aborted: false,
          timedOut: true,
          exitCode: null,
          error: null,
        });
      }, timeoutMs);
      entry.busy = true;
      try {
        entry.session.startTurn({ prompt, model, workingDirectory });
      } catch {
        entry.onUnexpectedExit = null;
        disposeEntry(entry, "protocol");
        finish({
          aborted: false,
          timedOut: false,
          exitCode: 1,
          error: "persistent-runtime-failed",
        });
      }
    });
  }

  function disposeAll() {
    for (const entry of [...entries.values()]) disposeEntry(entry, "shutdown");
  }

  function inspect() {
    return {
      size: entries.size,
      entries: activeEntries().map((entry) => ({
        userId: entry.userId,
        connectionId: entry.connectionId,
        resolvedModel: entry.resolvedModel,
        runtimeVersion: entry.runtimeVersion,
        runtimeProfileRef: entry.runtimeProfileRef,
        pid: entry.pid,
        busy: entry.busy,
        configFingerprint: entry.configFingerprint,
        createdAt: entry.createdAt,
        lastUsedAt: entry.lastUsedAt,
      })),
    };
  }

  return {
    acquire,
    runTurn,
    disposeEntry,
    disposeAll,
    retireConnection,
    retireVersionSkew,
    inspect,
    fingerprintInvocation,
  };
}

module.exports = {
  MAX_PERSISTENT_CODEX_PROCESSES_PER_USER,
  PERSISTENT_CODEX_IDLE_TTL_MS,
  createCodexPersistentRuntimeManager,
  emptyRuntimeMeta,
  fingerprintInvocation,
};

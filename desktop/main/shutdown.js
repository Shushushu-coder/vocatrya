// Quit coordination for the desktop shell.
//
// Hiding a window is not a quit. A real quit runs release hooks (the seam
// DateTime, Process, and Reminder can register later), then releases owned
// backend and migration processes — that is what drops the SQLite file lock —
// then flushes the persistent cookie jar so a later cold start sees the same
// session the auth middleware will accept or reject. A second quit while
// release is in progress is ignored. The final app.quit() is the only call
// allowed to proceed.
"use strict";

const DEFAULT_HOOK_TIMEOUT_MS = 2_000;

function createReleaseHookRegistry() {
  const hooks = [];
  return {
    register(fn) {
      if (typeof fn !== "function") {
        throw new Error("Desktop release hook must be a function");
      }
      hooks.push(fn);
      return () => {
        const index = hooks.indexOf(fn);
        if (index >= 0) hooks.splice(index, 1);
      };
    },
    clear() {
      hooks.splice(0, hooks.length);
    },
    get size() {
      return hooks.length;
    },
    run(timeoutMs = DEFAULT_HOOK_TIMEOUT_MS) {
      const snapshot = hooks.slice();
      return Promise.all(
        snapshot.map((fn, index) =>
          withTimeout(() => fn(), timeoutMs, `desktop release hook ${index}`),
        ),
      );
    },
  };
}

const defaultReleaseHooks = createReleaseHookRegistry();

function registerDesktopReleaseHook(fn) {
  return defaultReleaseHooks.register(fn);
}

function runRegisteredReleaseHooks(timeoutMs) {
  return defaultReleaseHooks.run(timeoutMs);
}

function resetDesktopReleaseHooksForTests() {
  defaultReleaseHooks.clear();
}

function withTimeout(task, timeoutMs, label) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, error: new Error(`${label} timed out`) });
    }, timeoutMs);
    Promise.resolve()
      .then(task)
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: true });
      })
      .catch((error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, error });
      });
  });
}

function createQuitCoordinator({
  beginQuit,
  markShuttingDown,
  runReleaseHooks = runRegisteredReleaseHooks,
  releaseResources,
  flushSession,
  requestQuit,
  logger = console,
} = {}) {
  if (typeof beginQuit !== "function") throw new Error("beginQuit is required");
  if (typeof releaseResources !== "function") throw new Error("releaseResources is required");
  if (typeof requestQuit !== "function") throw new Error("requestQuit is required");

  let phase = "idle";

  function onBeforeQuit(event) {
    beginQuit();
    if (phase === "released") return;
    if (event && typeof event.preventDefault === "function") event.preventDefault();
    if (phase === "releasing") return;
    phase = "releasing";
    if (typeof markShuttingDown === "function") markShuttingDown();
    Promise.resolve()
      .then(async () => {
        // Each stage is isolated: a hook failure must not skip backend
        // teardown, and a teardown failure must not skip the cookie flush.
        if (typeof runReleaseHooks === "function") {
          try {
            await runReleaseHooks();
          } catch (error) {
            logger.error("Desktop release hook failed", error);
          }
        }
        try {
          await releaseResources();
        } catch (error) {
          logger.error("Desktop resource release failed", error);
        }
        if (typeof flushSession === "function") {
          try {
            await flushSession();
          } catch (error) {
            logger.error("Desktop session flush failed", error);
          }
        }
      })
      .finally(() => {
        phase = "released";
        requestQuit();
      });
  }

  return {
    onBeforeQuit,
    get phase() {
      return phase;
    },
  };
}

function flushDefaultSession(session, timeoutMs = DEFAULT_HOOK_TIMEOUT_MS) {
  if (!session) return Promise.resolve();
  const tasks = [];
  if (typeof session.flushStorageData === "function") {
    try {
      session.flushStorageData();
    } catch {
      // A storage-flush failure must not block process exit.
    }
  }
  const flushStore = session.cookies && session.cookies.flushStore;
  if (typeof flushStore === "function") {
    tasks.push(Promise.resolve().then(() => flushStore.call(session.cookies)));
  }
  return withTimeout(() => Promise.all(tasks), timeoutMs, "session flush").then(() => undefined);
}

module.exports = {
  DEFAULT_HOOK_TIMEOUT_MS,
  createQuitCoordinator,
  createReleaseHookRegistry,
  flushDefaultSession,
  registerDesktopReleaseHook,
  resetDesktopReleaseHooksForTests,
  runRegisteredReleaseHooks,
  withTimeout,
};

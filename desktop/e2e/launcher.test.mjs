import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runDesktopE2E, startDiskMonitor, BUILD_DISK_CHECK_INTERVAL_MS } from "./launcher.mjs";
import { InsufficientDiskSpaceError, MIN_PREFLIGHT_FREE_BYTES, MIN_STAGE_FREE_BYTES } from "./guards.mjs";

const GiB = 1024 ** 3;
const RUN_ID = "0acc3444-93b7-4024-9405-2c02e8404ec6";
const ROOT = "E:\\synthetic\\repo";
const BELOW_STAGE = MIN_STAGE_FREE_BYTES - GiB;

function makeScheduler() {
  const intervals = new Map();
  const timeouts = new Map();
  return {
    setInterval: (fn) => { const timer = { unref() {} }; intervals.set(timer, fn); return timer; },
    clearInterval: (timer) => { intervals.delete(timer); },
    setTimeout: (fn) => { const timer = { unref() {} }; timeouts.set(timer, fn); return timer; },
    clearTimeout: (timer) => { timeouts.delete(timer); },
    tickIntervals: () => { for (const fn of [...intervals.values()]) fn(); },
    fireTimeouts: () => { const fns = [...timeouts.values()]; timeouts.clear(); for (const fn of fns) fn(); },
    intervalCount: () => intervals.size,
    timeoutCount: () => timeouts.size,
  };
}

// Synthetic child process: an EventEmitter with the pid/exit fields the
// launcher actually reads. terminate() models taskkill's asynchronous exit.
function fakeChild(pid) {
  const child = new EventEmitter();
  child.pid = pid;
  child.exitCode = null;
  child.signalCode = null;
  child.terminate = (code = 1, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", code, signal));
  };
  return child;
}

function insufficient(stage, freeBytes = GiB, requiredBytes = MIN_PREFLIGHT_FREE_BYTES) {
  return new InsufficientDiskSpaceError({ runId: RUN_ID, stage, target: "target", volume: "E:\\", freeBytes, requiredBytes });
}

function makeDeps(overrides = {}) {
  const calls = [];
  const stderr = [];
  const children = [];
  const captured = { interrupt: null };
  const sched = makeScheduler();
  const record = (name, detail) => calls.push({ name, detail });
  const deps = {
    fs: {
      mkdirSync: (target) => record("mkdir", target),
      copyFileSync: (source, target) => record("copy", target),
      symlinkSync: () => record("symlink"),
      existsSync: () => false,
      readFileSync: () => Buffer.from("x"),
    },
    execFileSync: () => "deadbeef\n",
    spawnImpl: () => { const child = fakeChild(9000 + children.length); children.push(child); record("spawn", child.pid); return child; },
    killProcessTree: (pid) => { record("killTree", pid); for (const child of children) if (child.pid === pid) child.terminate(1); },
    diskProbe: () => ({ bytes: 64 * GiB, volume: "E:\\", probe: "E:\\" }),
    enforceRunDirLimit: () => { record("runDirLimit"); return []; },
    requireFreeSpace: ({ stage }) => record("requireFreeSpace", stage),
    buildEnv: () => ({}),
    assemble: () => record("assemble"),
    runScenario: async ({ state }) => { record("scenario"); state.instance = { tag: "electron-instance" }; },
    stopDesktop: async (instance) => record("stopDesktop", instance?.tag ?? null),
    captureFailureArtifacts: async () => record("captureFailureArtifacts"),
    registerInterrupt: (handler) => { captured.interrupt = handler; return () => record("unregisterInterrupt"); },
    exitProcess: (code) => record("exitProcess", code),
    onLog: () => {},
    onError: (line) => stderr.push(line),
    setIntervalImpl: sched.setInterval,
    clearIntervalImpl: sched.clearInterval,
    setTimeoutImpl: sched.setTimeout,
    clearTimeoutImpl: sched.clearTimeout,
    monitorIntervalMs: 50,
    reclaimTimeoutMs: 25,
    ...overrides,
  };
  return { deps, calls, stderr, children, captured, sched, record };
}

const idx = (calls, name, detail) => calls.findIndex((c) => c.name === name && (detail === undefined || c.detail === detail));
const details = (calls, name) => calls.filter((c) => c.name === name).map((c) => c.detail);

function succeedingBuild(harness) {
  const original = harness.deps.spawnImpl;
  harness.deps.spawnImpl = (...args) => {
    const child = original(...args);
    queueMicrotask(() => child.terminate(0));
    return child;
  };
}

test("preflight guards run before the run directory exists and stage checks keep their order", async () => {
  const harness = makeDeps();
  succeedingBuild(harness);
  const result = await runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  assert.equal(result.ok, true);
  const { calls } = harness;
  const order = [
    idx(calls, "runDirLimit"),
    idx(calls, "requireFreeSpace", "pre-flight"),
    idx(calls, "mkdir"),
    idx(calls, "requireFreeSpace", "source-snapshot"),
    idx(calls, "spawn"),
    idx(calls, "requireFreeSpace", "next-build"),
    idx(calls, "assemble"),
    idx(calls, "requireFreeSpace", "backend-assembly"),
    idx(calls, "scenario"),
  ];
  assert.ok(order.every((i) => i >= 0), `missing stages in ${JSON.stringify(calls)}`);
  for (let i = 1; i < order.length; i++) assert.ok(order[i] > order[i - 1], `stage order broken at ${i}: ${JSON.stringify(calls)}`);
  assert.equal(harness.sched.intervalCount(), 0, "monitor must be disarmed after a successful build");
  assert.deepEqual(details(calls, "killTree"), [], "a clean run never terminates a process");
  assert.deepEqual(details(calls, "stopDesktop"), ["electron-instance"], "cleanup stops the owned instance");
  assert.deepEqual(details(calls, "unregisterInterrupt"), [undefined]);
});

test("the run-dir limit aborts before mkdir, spawn or assembly", async () => {
  const harness = makeDeps();
  const limitError = new Error("RUN_DIR_LIMIT synthetic"); limitError.code = "RUN_DIR_LIMIT";
  harness.deps.enforceRunDirLimit = () => { harness.record("runDirLimit"); throw limitError; };
  const result = await runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  assert.equal(result.ok, false);
  assert.equal(result.primaryError, limitError);
  assert.equal(idx(harness.calls, "mkdir"), -1);
  assert.equal(idx(harness.calls, "spawn"), -1);
  assert.equal(idx(harness.calls, "assemble"), -1);
  assert.equal(idx(harness.calls, "scenario"), -1);
  assert.ok(harness.stderr.some((line) => /aborted before creating a run directory/.test(line)));
});

test("a failed pre-flight space check never spawns the build", async () => {
  const harness = makeDeps({
    requireFreeSpace: ({ stage }) => { harness.record("requireFreeSpace", stage); if (stage === "pre-flight") throw insufficient(stage); },
  });
  const result = await runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  assert.equal(result.primaryError?.code, "INSUFFICIENT_DISK_SPACE");
  assert.equal(idx(harness.calls, "spawn"), -1);
  assert.equal(idx(harness.calls, "mkdir"), -1);
});

test("a failed stage-boundary check still stops the run before the build", async () => {
  const harness = makeDeps({
    requireFreeSpace: ({ stage }) => { harness.record("requireFreeSpace", stage); if (stage === "source-snapshot") throw insufficient(stage, GiB, MIN_STAGE_FREE_BYTES); },
  });
  const result = await runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  assert.equal(result.primaryError?.code, "INSUFFICIENT_DISK_SPACE");
  assert.equal(idx(harness.calls, "spawn"), -1);
  assert.equal(idx(harness.calls, "assemble"), -1);
});

test("a mid-build disk breach terminates only the owned build tree and stays the primary error", async () => {
  const harness = makeDeps({ diskProbe: () => ({ bytes: BELOW_STAGE, volume: "E:\\", probe: "E:\\" }) });
  const pending = runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  assert.equal(harness.children.length, 1, "build child must be spawned before the monitor arms");
  assert.equal(harness.sched.intervalCount(), 1, "monitor must be armed while the build awaits");
  harness.sched.tickIntervals();
  const result = await pending;
  assert.equal(result.primaryError?.code, "INSUFFICIENT_DISK_SPACE");
  assert.equal(result.primaryError?.stage, "build");
  assert.equal(result.diskGuarded, true);
  assert.deepEqual(details(harness.calls, "killTree"), [harness.children[0].pid], "only this run's build PID may be killed");
  assert.equal(idx(harness.calls, "assemble"), -1, "the run must not enter backend assembly");
  assert.equal(idx(harness.calls, "scenario"), -1, "the run must not launch Electron");
  assert.equal(harness.sched.intervalCount(), 0, "monitor must be disarmed after the breach");
  assert.equal(result.ok, false);
  assert.ok(harness.stderr.some((line) => /cleanup finished/.test(line)));
});

test("a failing build prevents assembly without calling the monitor's kill path", async () => {
  const harness = makeDeps();
  harness.deps.spawnImpl = () => {
    const child = fakeChild(9200);
    harness.children.push(child);
    harness.record("spawn", child.pid);
    queueMicrotask(() => child.terminate(1));
    return child;
  };
  const result = await runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  assert.match(result.primaryError?.message ?? "", /Next build failed \(exit 1\)/);
  assert.equal(idx(harness.calls, "assemble"), -1);
  assert.equal(idx(harness.calls, "scenario"), -1);
  assert.equal(harness.sched.intervalCount(), 0, "monitor must be disarmed on the failure path");
  assert.deepEqual(details(harness.calls, "killTree"), [], "an exited build must not be terminated again");
  assert.equal(details(harness.calls, "mkdir").length, 1, "no second run directory is created");
  assert.equal(details(harness.calls, "spawn").length, 1, "the failed build is never retried");
});

test("interrupt during the build kills only the owned tree and disarms the monitor", async () => {
  const harness = makeDeps();
  const pending = runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  assert.equal(harness.children.length, 1);
  assert.equal(harness.sched.intervalCount(), 1);
  harness.captured.interrupt();
  const result = await pending;
  assert.deepEqual(details(harness.calls, "killTree"), [harness.children[0].pid]);
  assert.deepEqual(details(harness.calls, "exitProcess"), [130]);
  assert.equal(harness.sched.intervalCount(), 0, "monitor must be disarmed on the interrupt path");
  assert.ok(result.primaryError, "the interrupted build still surfaces a primary error");
});

test("a cleanup failure never replaces the primary failure", async () => {
  const harness = makeDeps();
  succeedingBuild(harness);
  const diskError = insufficient("next-build", GiB, MIN_STAGE_FREE_BYTES);
  harness.deps.requireFreeSpace = ({ stage }) => { harness.record("requireFreeSpace", stage); if (stage === "next-build") throw diskError; };
  harness.deps.stopDesktop = async () => { harness.record("stopDesktop"); throw new Error("cleanup timed out"); };
  const result = await runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  assert.equal(result.primaryError, diskError, "the disk guard stays the reported failure");
  assert.equal(result.cleanupError?.message, "cleanup timed out");
  assert.equal(result.ok, false);
  assert.ok(harness.stderr.some((line) => /CLEANUP_FAILURE/.test(line)));
  assert.ok(harness.stderr.some((line) => /PRIMARY_FAILURE/.test(line)));
  assert.equal(typeof result.buildTerminatedOnCleanup, "boolean", "owned-build cleanup still ran before the failing stop");
});

test("a cleanup failure alone still fails the run", async () => {
  const harness = makeDeps();
  succeedingBuild(harness);
  harness.deps.stopDesktop = async () => { harness.record("stopDesktop"); throw new Error("cleanup timed out"); };
  const result = await runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  assert.equal(result.ok, false, "cleanup failure must not be reported as success");
  assert.equal(result.cleanupError?.message, "cleanup timed out");
  assert.equal(result.primaryError, result.cleanupError);
  assert.ok(harness.stderr.some((line) => /CLEANUP_FAILURE/.test(line)));
});

test("a surviving build child is reclaimed on a bounded wait, not forever", async () => {
  const harness = makeDeps({
    diskProbe: () => ({ bytes: BELOW_STAGE, volume: "E:\\", probe: "E:\\" }),
    killProcessTree: (pid) => harness.record("killTree", pid), // taskkill fails to kill: child survives
  });
  const pending = runDesktopE2E({ runId: RUN_ID, root: ROOT, deps: harness.deps });
  harness.sched.tickIntervals();
  assert.equal(harness.sched.timeoutCount(), 1, "breach must arm the bounded reclaim");
  harness.sched.fireTimeouts();
  const result = await pending;
  assert.equal(result.primaryError?.code, "INSUFFICIENT_DISK_SPACE", "guard error stays primary over any exit status");
  assert.deepEqual(details(harness.calls, "killTree"), [9000, 9000], "monitor kill plus final cleanup retry on the surviving child");
  assert.equal(result.buildTerminatedOnCleanup, true);
  assert.ok(harness.stderr.some((line) => /still running/.test(line)));
});

test("the disk monitor reports exactly once below the threshold and never at it", () => {
  const sched = makeScheduler();
  const hits = [];
  let bytes = MIN_STAGE_FREE_BYTES;
  const disarm = startDiskMonitor({
    runId: RUN_ID, stage: "build", target: "E:\\synthetic\\repo\\.tmp\\run",
    minimumBytes: MIN_STAGE_FREE_BYTES, intervalMs: 50,
    probe: () => ({ bytes, volume: "E:\\", probe: "E:\\" }),
    onExceeded: (error) => hits.push(error),
    setIntervalImpl: sched.setInterval, clearIntervalImpl: sched.clearInterval,
  });
  sched.tickIntervals();
  assert.equal(hits.length, 0, "free space equal to the threshold is not a breach");
  bytes = MIN_STAGE_FREE_BYTES - 1;
  sched.tickIntervals();
  assert.equal(hits.length, 1);
  assert.equal(hits[0].code, "INSUFFICIENT_DISK_SPACE");
  assert.equal(hits[0].stage, "build");
  assert.equal(hits[0].freeBytes, MIN_STAGE_FREE_BYTES - 1);
  sched.tickIntervals();
  assert.equal(hits.length, 1, "the monitor is single-shot after a breach");
  assert.equal(sched.intervalCount(), 0);
  disarm();
});

test("the disk monitor fails closed when measuring free space throws", () => {
  const sched = makeScheduler();
  const hits = [];
  const boom = new Error("statfs unavailable");
  startDiskMonitor({
    runId: RUN_ID, stage: "build", target: "target", minimumBytes: MIN_STAGE_FREE_BYTES, intervalMs: 50,
    probe: () => { throw boom; },
    onExceeded: (error) => hits.push(error),
    setIntervalImpl: sched.setInterval, clearIntervalImpl: sched.clearInterval,
  });
  sched.tickIntervals();
  assert.deepEqual(hits, [boom], "a probe failure trips the guard instead of reading as free space");
  assert.equal(sched.intervalCount(), 0);
});

test("disarming the monitor stops further checks and is idempotent", () => {
  const sched = makeScheduler();
  let probes = 0;
  const disarm = startDiskMonitor({
    runId: RUN_ID, stage: "build", target: "target", minimumBytes: MIN_STAGE_FREE_BYTES, intervalMs: 50,
    probe: () => { probes++; return { bytes: 64 * GiB, volume: "E:\\", probe: "E:\\" }; },
    onExceeded: () => assert.fail("healthy volume must not trip"),
    setIntervalImpl: sched.setInterval, clearIntervalImpl: sched.clearInterval,
  });
  sched.tickIntervals();
  assert.equal(probes, 1);
  disarm();
  disarm();
  sched.tickIntervals();
  assert.equal(probes, 1, "no probe runs after disarm");
  assert.equal(BUILD_DISK_CHECK_INTERVAL_MS, 2000, "the in-build poll stays low-frequency");
});

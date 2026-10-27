import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  InsufficientDiskSpaceError,
  MIN_PREFLIGHT_FREE_BYTES,
  MIN_STAGE_FREE_BYTES,
  enforceRunDirLimit,
  freeSpace,
  requireFreeSpace,
} from "./guards.mjs";

export const BUILD_DISK_CHECK_INTERVAL_MS = 2000;
export const BUILD_RECLAIM_TIMEOUT_MS = 20_000;

// Low-frequency disk monitor for a long-running async stage. The interval
// callback only runs while the launcher awaits the child, so it cannot observe
// the synchronous backend assembly at all — that residual window is documented
// in desktop/E2E.md. The monitor is single-shot: the first breach (or a probe
// failure, which must fail closed rather than read as free space) disarms it
// before reporting, so no timer or callback outlives the guarded stage.
export function startDiskMonitor({
  runId,
  stage,
  target,
  minimumBytes = MIN_STAGE_FREE_BYTES,
  onExceeded,
  probe = freeSpace,
  intervalMs = BUILD_DISK_CHECK_INTERVAL_MS,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
}) {
  let active = true;
  let timer;
  const disarm = () => {
    if (!active) return;
    active = false;
    clearIntervalImpl(timer);
  };
  timer = setIntervalImpl(() => {
    if (!active) return;
    let sample;
    try {
      sample = probe(target);
    } catch (error) {
      disarm();
      onExceeded(error);
      return;
    }
    if (sample.bytes < minimumBytes) {
      disarm();
      onExceeded(new InsufficientDiskSpaceError({ runId, stage, target, volume: sample.volume, freeBytes: sample.bytes, requiredBytes: minimumBytes }));
    }
  }, intervalMs);
  timer?.unref?.();
  return disarm;
}

const defaultRegisterInterrupt = (onInterrupt) => {
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, onInterrupt);
  return () => { for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, onInterrupt); };
};

// Whole-run orchestration with every side effect behind `deps` so the stage
// sequencing, process ownership and error precedence are testable without a
// real build, Electron, taskkill or disk pressure. Returns a result object;
// the caller (run.mjs) turns result.ok into the process exit code.
export async function runDesktopE2E({ runId, root, direct = false, runBase = path.join(root, ".tmp", "desktop-e2e"), deps = {} }) {
  const d = {
    fs,
    execFileSync,
    spawnImpl: spawn,
    killProcessTree: (pid) => execFileSync("taskkill.exe", ["/pid", String(pid), "/t", "/f"], { windowsHide: true, stdio: "ignore", timeout: 10_000 }),
    diskProbe: freeSpace,
    enforceRunDirLimit,
    requireFreeSpace,
    registerInterrupt: defaultRegisterInterrupt,
    exitProcess: (code) => process.exit(code),
    captureFailureArtifacts: async () => {},
    onLog: (line) => console.log(line),
    onError: (line) => console.error(line),
    setIntervalImpl: setInterval,
    clearIntervalImpl: clearInterval,
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
    monitorIntervalMs: BUILD_DISK_CHECK_INTERVAL_MS,
    reclaimTimeoutMs: BUILD_RECLAIM_TIMEOUT_MS,
    execPath: process.execPath,
    nextBin: path.join(root, "node_modules", "next", "dist", "bin", "next"),
    ...deps,
  };
  for (const key of ["buildEnv", "assemble", "runScenario", "stopDesktop"]) {
    if (typeof d[key] !== "function") throw new TypeError(`runDesktopE2E requires a deps.${key} function`);
  }

  const runRoot = path.join(runBase, runId);
  const appRoot = path.join(runRoot, "app");
  const dataRoot = path.join(runRoot, "data-root");
  const state = { buildChild: null, instance: null, interrupted: false };
  const result = { runId, runRoot, ok: false, primaryError: null, cleanupError: null, diskGuarded: false, buildTerminatedOnCleanup: false };

  function sourceFiles() {
    return d.execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "src", "public", "prisma/schema.prisma", "prisma/migrations", "desktop/main", "desktop/assets", "scripts/build-fresh-native-bootstrap.mjs", "next.config.mjs", "next-env.d.ts", "eslint.config.mjs", "package.json", "package-lock.json", "tsconfig.json", "postcss.config.mjs"], { cwd: root }).toString().split("\0").filter(Boolean);
  }

  function sourceDigest() {
    const files = sourceFiles();
    const hash = createHash("sha256");
    for (const file of [...new Set(files)].sort()) {
      hash.update(file);
      hash.update(d.fs.existsSync(path.join(root, file)) ? d.fs.readFileSync(path.join(root, file)) : "<deleted>");
    }
    return hash.digest("hex");
  }

  // Only this run's spawned PID tree is ever terminated; killProcessTree by
  // PID never scans or touches processes from other runs or the developer's
  // session.
  function terminateOwnedBuild() {
    const child = state.buildChild;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        d.killProcessTree(child.pid);
        return true;
      } catch { d.onError("Could not terminate the owned build process; check this run's process tree"); }
    }
    return false;
  }

  async function build() {
    const env = d.buildEnv({ dataRoot, runRoot });
    const child = d.spawnImpl(d.execPath, [d.nextBin, "build"], { cwd: appRoot, env, windowsHide: true, stdio: "inherit" });
    state.buildChild = child;
    // While the async build runs, a low-frequency monitor watches the volume
    // actually hosting the run directory. A breach (or a probe failure, which
    // fails closed) records the guard error and terminates only this run's
    // build tree; the exit wait then resolves and the recorded error — not the
    // resulting child exit status — becomes the primary failure.
    let guardError = null;
    const RECLAIMED = Symbol("build-reclaim-timeout");
    let reclaimTimer = null;
    let armReclaim = () => {};
    const reclaim = new Promise((resolve) => {
      armReclaim = () => {
        if (reclaimTimer === null) reclaimTimer = d.setTimeoutImpl(() => resolve(RECLAIMED), d.reclaimTimeoutMs);
      };
    });
    const stopMonitor = startDiskMonitor({
      runId,
      stage: "build",
      target: runRoot,
      minimumBytes: MIN_STAGE_FREE_BYTES,
      intervalMs: d.monitorIntervalMs,
      probe: d.diskProbe,
      setIntervalImpl: d.setIntervalImpl,
      clearIntervalImpl: d.clearIntervalImpl,
      onExceeded: (error) => {
        if (guardError) return;
        guardError = error;
        terminateOwnedBuild();
        armReclaim();
      },
    });
    let code;
    try {
      const raced = await Promise.race([once(child, "exit").then(([exitCode]) => exitCode), reclaim]);
      code = raced === RECLAIMED ? null : raced;
      if (raced === RECLAIMED) d.onError(`Run ${runId}: owned build process still running ${d.reclaimTimeoutMs}ms after the disk guard fired; cleanup continues without waiting for it`);
    } finally {
      stopMonitor();
      if (reclaimTimer !== null) d.clearTimeoutImpl(reclaimTimer);
      // Ownership is released only once the child has actually exited, so a
      // child that survived a reclaim timeout is still terminated by the
      // final cleanup below.
      if (child.exitCode !== null || child.signalCode !== null) state.buildChild = null;
    }
    if (guardError) throw guardError;
    if (code !== 0) throw new Error(`Current-source Next build failed (exit ${code})`);
  }

  const onInterrupt = () => {
    state.interrupted = true;
    terminateOwnedBuild();
    void d.stopDesktop(state.instance).finally(() => d.exitProcess(130));
  };
  const unregister = d.registerInterrupt(onInterrupt);

  let completed = false;
  try {
    // Cheap guards before any large write: refuse when the run-directory
    // quota or the target volume's free space is already exhausted. Both
    // abort before a run directory exists, so no cleanup or retry applies.
    try {
      d.enforceRunDirLimit({ runId, base: runBase });
      d.requireFreeSpace({ runId, stage: "pre-flight", target: runBase, minimumBytes: MIN_PREFLIGHT_FREE_BYTES });
    } catch (error) {
      if (error.code === "RUN_DIR_LIMIT" || error.code === "INSUFFICIENT_DISK_SPACE") {
        result.primaryError = error;
        d.onError(`FAIL Windows Electron fresh-native E2E: ${error.message}`);
        d.onError(`Run ${runId} aborted before creating a run directory; no processes were started`);
        return result;
      }
      throw error;
    }
    d.fs.mkdirSync(appRoot, { recursive: true });
    try {
      const commit = d.execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
      const digest = sourceDigest();
      d.onLog(`Desktop E2E: commit=${commit} source=${digest} host=Electron mode=fresh-native proxy=${direct ? "DIRECT DIAGNOSTIC" : "SYSTEM (unchanged)"}`);
      d.onLog(`Isolated run: ${runRoot}`);
      // Build from explicit source inputs only. Next otherwise loads the
      // user's checkout .env files even when the child environment is
      // allowlisted. The snapshot also prevents contention with a developer's
      // .next server.
      for (const file of [...new Set(sourceFiles())]) {
        const source = path.join(root, file);
        if (!d.fs.existsSync(source)) continue;
        const destination = path.join(appRoot, file);
        d.fs.mkdirSync(path.dirname(destination), { recursive: true });
        d.fs.copyFileSync(source, destination);
      }
      d.fs.symlinkSync(path.join(root, "node_modules"), path.join(appRoot, "node_modules"), "junction");
      if (sourceDigest() !== digest) throw new Error("Source changed while snapshotting; rerun against a stable checkout");
      // Stage-boundary disk checks: each verification sits after one heavy
      // stage and before the next, so a drained volume aborts instead of
      // failing midway. The async build is additionally watched by the
      // in-stage monitor; the synchronous assembly between the next-build and
      // backend-assembly checks remains a documented residual window.
      d.requireFreeSpace({ runId, stage: "source-snapshot", target: runRoot, minimumBytes: MIN_STAGE_FREE_BYTES });
      await build();
      d.requireFreeSpace({ runId, stage: "next-build", target: runRoot, minimumBytes: MIN_STAGE_FREE_BYTES });
      // The unmodified desktop main resolves its backend relative to this copy.
      d.assemble({ repoRoot: appRoot, outputRoot: path.join(appRoot, ".codex-tmp", "desktop-poc") });
      if (sourceDigest() !== digest) throw new Error("Source changed during assembly; rerun against a stable checkout");
      d.requireFreeSpace({ runId, stage: "backend-assembly", target: runRoot, minimumBytes: MIN_STAGE_FREE_BYTES });
      d.onLog("PASS current-source build/assembly identity");
      await d.runScenario({ runId, appRoot, dataRoot, runRoot, direct, state });
      if (!state.interrupted) d.onLog(`PASS Windows Electron fresh-native E2E${direct ? " (DIRECT DIAGNOSTIC ONLY)" : " (system proxy unchanged)"}`);
      completed = true;
    } catch (error) {
      result.primaryError = error;
      d.onError(`FAIL Windows Electron fresh-native E2E: ${error.message}`);
      d.onError(`Evidence retained in ${runRoot}`);
      if (error.code === "INSUFFICIENT_DISK_SPACE") {
        result.diskGuarded = true;
        d.onError(`Run ${runId} stopped before the next stage; retained run directories were not touched`);
      }
      await d.captureFailureArtifacts(state.instance, runRoot);
    } finally {
      result.buildTerminatedOnCleanup = terminateOwnedBuild();
      // A cleanup failure is reported as CLEANUP_FAILURE and never replaces
      // an existing primary failure; when the main flow succeeded it still
      // fails the run rather than reporting success.
      try {
        await d.stopDesktop(state.instance);
      } catch (cleanupError) {
        result.cleanupError = cleanupError;
        d.onError(`CLEANUP_FAILURE run=${runId} stage=final-cleanup: ${cleanupError.message}`);
        if (result.primaryError) d.onError(`PRIMARY_FAILURE run=${runId} remains the reported failure: ${result.primaryError.message}`);
        else result.primaryError = cleanupError;
      }
      if (result.diskGuarded) d.onError(`Run ${runId} cleanup finished: owned build tree terminated=${result.buildTerminatedOnCleanup}, owned Electron instance stopped`);
    }
  } finally {
    unregister();
  }
  result.ok = completed && !result.primaryError && !result.cleanupError;
  return result;
}

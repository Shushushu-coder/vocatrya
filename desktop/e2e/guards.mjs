import fs from "node:fs";
import path from "node:path";

const GiB = 1024 ** 3;

// Every desktop E2E run writes a full production build, a duplicated assembled
// backend and a Chromium profile under .tmp/desktop-e2e/<run>. Repeated runs
// previously exhausted the target volume, so the launcher refuses to start (or
// to enter the next heavy stage) instead of draining the disk.
export const MIN_PREFLIGHT_FREE_BYTES = 15 * GiB;
export const MIN_STAGE_FREE_BYTES = 8 * GiB;
export const MAX_RETAINED_RUN_DIRS = 3;

// Run directories are named by randomUUID(); anything else in the base
// directory (stray node_modules, other task data) is not launcher-owned and
// must not be counted or touched.
const RUN_DIR_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatFree(bytes) {
  return `${(bytes / GiB).toFixed(2)}GiB`;
}

export class InsufficientDiskSpaceError extends Error {
  constructor({ runId, stage, target, volume, freeBytes, requiredBytes }) {
    super(`INSUFFICIENT_DISK_SPACE run=${runId} stage=${stage} free=${formatFree(freeBytes)} required>=${formatFree(requiredBytes)} volume=${volume} runDir=${target}`);
    this.name = "InsufficientDiskSpaceError";
    this.code = "INSUFFICIENT_DISK_SPACE";
    this.stage = stage;
    this.freeBytes = freeBytes;
    this.requiredBytes = requiredBytes;
  }
}

export class RunDirLimitError extends Error {
  constructor({ runId, base, maximum, runs }) {
    super(
      `RUN_DIR_LIMIT run=${runId} stage=pre-flight retained=${runs.length} max=${maximum} base=${base}\n` +
      `Retained launcher run directories:\n${runs.map((name) => `  ${name}`).join("\n")}\n` +
      `Delete old run directories under .tmp/desktop-e2e manually to continue; the launcher never removes retained runs or their evidence.`
    );
    this.name = "RunDirLimitError";
    this.code = "RUN_DIR_LIMIT";
    this.runs = runs;
  }
}

// statfs requires an existing path; walk up to the nearest existing ancestor
// so the measurement always lands on the volume that will host the run
// directory, never on the current working directory's volume.
function nearestExistingAncestor(target, existsSync) {
  let current = path.resolve(target);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

export function freeSpace(target, { statfsSync = fs.statfsSync, existsSync = fs.existsSync } = {}) {
  const anchor = nearestExistingAncestor(target, existsSync);
  const stats = statfsSync(anchor);
  return { bytes: stats.bavail * stats.bsize, volume: path.parse(anchor).root, probe: anchor };
}

export function requireFreeSpace({ runId, stage, target, minimumBytes, ...deps }) {
  const { bytes, volume } = freeSpace(target, deps);
  if (bytes < minimumBytes) throw new InsufficientDiskSpaceError({ runId, stage, target, volume, freeBytes: bytes, requiredBytes: minimumBytes });
  return bytes;
}

export function listRunDirs(base, { readdirSync = fs.readdirSync, existsSync = fs.existsSync } = {}) {
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && RUN_DIR_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export function enforceRunDirLimit({ runId, base, maximum = MAX_RETAINED_RUN_DIRS, ...deps }) {
  const runs = listRunDirs(base, deps);
  if (runs.length >= maximum) throw new RunDirLimitError({ runId, base, maximum, runs });
  return runs;
}

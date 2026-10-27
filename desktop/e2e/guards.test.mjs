import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MIN_PREFLIGHT_FREE_BYTES,
  MIN_STAGE_FREE_BYTES,
  MAX_RETAINED_RUN_DIRS,
  enforceRunDirLimit,
  freeSpace,
  listRunDirs,
  requireFreeSpace,
} from "./guards.mjs";

const GiB = 1024 ** 3;
const statfsOf = (bytes) => () => ({ bavail: Math.floor(bytes / 4096), bsize: 4096 });

test("pre-flight refuses to start when the target volume is below the threshold", () => {
  const target = path.join(os.tmpdir(), "vocatrya-guard-preflight", "app");
  assert.throws(
    () => requireFreeSpace({ runId: "r-1", stage: "pre-flight", target, minimumBytes: MIN_PREFLIGHT_FREE_BYTES, statfsSync: statfsOf(2 * GiB) }),
    (error) => {
      assert.equal(error.code, "INSUFFICIENT_DISK_SPACE");
      assert.match(error.message, /INSUFFICIENT_DISK_SPACE/);
      assert.match(error.message, /run=r-1/);
      assert.match(error.message, /stage=pre-flight/);
      assert.match(error.message, /free=2\.00GiB/);
      assert.match(error.message, /required>=15\.00GiB/);
      assert.match(error.message, /volume=[A-Z]:[\\/]/i);
      return true;
    },
  );
});

test("pre-flight passes when the target volume has enough space", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-guard-"));
  try {
    const bytes = requireFreeSpace({ runId: "r-2", stage: "pre-flight", target: path.join(base, "missing", "app"), minimumBytes: MIN_PREFLIGHT_FREE_BYTES, statfsSync: statfsOf(40 * GiB) });
    assert.equal(bytes, 40 * GiB);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("a mid-stage check stops the run before the next heavy stage", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-guard-"));
  try {
    assert.throws(
      () => requireFreeSpace({ runId: "r-3", stage: "next-build", target: base, minimumBytes: MIN_STAGE_FREE_BYTES, statfsSync: statfsOf(MIN_STAGE_FREE_BYTES - 1) }),
      (error) => {
        assert.equal(error.code, "INSUFFICIENT_DISK_SPACE");
        assert.equal(error.stage, "next-build");
        assert.match(error.message, /required>=8\.00GiB/);
        return true;
      },
    );
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("free space is measured on the target volume, not the process cwd", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-guard-"));
  const missing = path.join(base, "run-uuid", "app");
  let probed = null;
  try {
    freeSpace(missing, { statfsSync: (anchor) => { probed = anchor; return { bavail: 1, bsize: 1 }; } });
    assert.equal(probed, path.resolve(base));
    assert.notEqual(probed, process.cwd());
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

const RUNS = [
  "0acc3444-93b7-4024-9405-2c02e8404ec6",
  "5bc5685e-a42b-4a04-a860-c07ed153f97a",
  "a51d9685-34a5-4e0d-97c0-22ce62fcd897",
  "d22415fd-b361-4a7b-b9c9-d7b8b44f9c5e",
];

test("run-directory limit rejects a new run and never deletes retained dirs", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-guard-"));
  try {
    for (const name of RUNS.slice(0, MAX_RETAINED_RUN_DIRS)) fs.mkdirSync(path.join(base, name));
    fs.mkdirSync(path.join(base, "node_modules"));
    fs.mkdirSync(path.join(base, "not-a-run"));
    fs.writeFileSync(path.join(base, "notes.txt"), "keep");
    assert.throws(
      () => enforceRunDirLimit({ runId: "r-4", base }),
      (error) => {
        assert.equal(error.code, "RUN_DIR_LIMIT");
        assert.match(error.message, /retained=3 max=3/);
        for (const name of RUNS.slice(0, MAX_RETAINED_RUN_DIRS)) assert.match(error.message, new RegExp(name));
        assert.doesNotMatch(error.message, /node_modules/);
        assert.match(error.message, /manually/);
        return true;
      },
    );
    // The guard only reports; every retained directory survives untouched.
    for (const name of [...RUNS.slice(0, MAX_RETAINED_RUN_DIRS), "node_modules", "not-a-run"]) {
      assert.ok(fs.existsSync(path.join(base, name)), `${name} must remain`);
    }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("under the limit a new run directory may be created", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-guard-"));
  try {
    for (const name of RUNS.slice(0, MAX_RETAINED_RUN_DIRS - 1)) fs.mkdirSync(path.join(base, name));
    assert.deepEqual(enforceRunDirLimit({ runId: "r-5", base }), [...RUNS.slice(0, MAX_RETAINED_RUN_DIRS - 1)].sort());
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("the run-dir quota ignores everything not named like a launcher run", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-guard-"));
  try {
    for (const name of ["node_modules", "manual-desktop-abc", "desktop-e2e.log", "123e4567-e89b-12d3-a456"]) {
      const p = path.join(base, name);
      if (name.endsWith(".log")) fs.writeFileSync(p, "x"); else fs.mkdirSync(p);
    }
    assert.deepEqual(listRunDirs(base), []);
    assert.deepEqual(enforceRunDirLimit({ runId: "r-6", base }), []);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("a missing base directory means zero retained runs", () => {
  const missing = path.join(os.tmpdir(), "vocatrya-guard-never-exists-9f8e7d", "desktop-e2e");
  assert.deepEqual(listRunDirs(missing), []);
  assert.deepEqual(enforceRunDirLimit({ runId: "r-7", base: missing }), []);
});

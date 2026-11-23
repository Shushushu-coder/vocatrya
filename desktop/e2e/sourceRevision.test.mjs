import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  hasOwnGitMetadata,
  readGitCommit,
  resolveSourceCommit,
  revisionPath,
  sourceRevisionDocument,
} from "./sourceRevision.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const taskTemp = path.join(repoRoot, ".tmp", "rc-c4-backup-native");

function gitHead(cwd) {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function writeSnapshot(dir, commit) {
  const files = ["package.json"];
  fs.writeFileSync(path.join(dir, "package.json"), "{\"private\":true}\n");
  fs.writeFileSync(revisionPath(dir), sourceRevisionDocument({
    commit,
    sourceDigest: "c".repeat(64),
    files,
  }));
}

test("a normal git checkout resolves its own HEAD", () => {
  assert.equal(hasOwnGitMetadata(repoRoot, fs), true);
  const expected = gitHead(repoRoot);
  assert.equal(readGitCommit(repoRoot, execFileSync), expected);
  assert.equal(resolveSourceCommit(repoRoot, { fs, execFileSync }).via, "git");
  assert.equal(resolveSourceCommit(repoRoot, { fs, execFileSync }).commit, expected);
});

test("a snapshot inside a parent checkout keeps the commit verified at creation", () => {
  const parent = gitHead(repoRoot);
  const verified = "b".repeat(40);
  assert.notEqual(verified, parent);
  fs.mkdirSync(taskTemp, { recursive: true });
  const dir = fs.mkdtempSync(path.join(taskTemp, "snapshot-"));
  try {
    writeSnapshot(dir, verified);
    assert.equal(hasOwnGitMetadata(dir, fs), false);
    assert.equal(gitHead(dir), parent);
    const resolved = resolveSourceCommit(dir, { fs, execFileSync });
    assert.equal(resolved.via, "snapshot");
    assert.equal(resolved.commit, verified);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (fs.existsSync(taskTemp) && fs.readdirSync(taskTemp).length === 0) fs.rmdirSync(taskTemp);
  }
});

test("a snapshot whose git rev-parse fails still returns the verified commit", () => {
  const verified = "d".repeat(40);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-e2e-snapshot-"));
  try {
    writeSnapshot(dir, verified);
    assert.throws(() => execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      windowsHide: true,
      env: { ...process.env, GIT_CEILING_DIRECTORIES: dir },
    }));
    assert.equal(resolveSourceCommit(dir, { fs, execFileSync }).commit, verified);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

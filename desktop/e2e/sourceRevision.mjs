import path from "node:path";

// Written into an isolated source snapshot after its commit and digest are
// verified. The snapshot is an explicit file copy and has no .git of its own.
export const SOURCE_REVISION_FILE = ".vocatrya-e2e-source.json";

const COMMIT = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export function revisionPath(root) {
  return path.join(root, SOURCE_REVISION_FILE);
}

// Only metadata inside this directory counts. `git rev-parse` walks to a
// parent checkout, so a snapshot placed under a worktree would otherwise
// report that checkout's current HEAD, or fail when no parent repository exists.
export function hasOwnGitMetadata(root, fs) {
  return fs.existsSync(path.join(root, ".git"));
}

function assertFileList(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("Verified source file list is empty");
  for (const file of files) {
    if (typeof file !== "string" || file.length === 0 || path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) {
      throw new Error("Verified source file list contains an invalid path");
    }
  }
}

export function sourceRevisionDocument({ commit, sourceDigest, files }) {
  if (typeof commit !== "string" || !COMMIT.test(commit)) throw new Error("Refusing to record an invalid source commit");
  if (typeof sourceDigest !== "string" || !DIGEST.test(sourceDigest)) throw new Error("Refusing to record an invalid source digest");
  assertFileList(files);
  return JSON.stringify({ commit, sourceDigest, files });
}

export function readVerifiedSourceRevision(root, fs) {
  const file = revisionPath(root);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`Isolated source snapshot has no Git metadata and no verified source revision (${file})`);
  }
  if (!parsed || typeof parsed.commit !== "string" || !COMMIT.test(parsed.commit)) {
    throw new Error(`Verified source revision is missing or invalid (${file})`);
  }
  if (typeof parsed.sourceDigest !== "string" || !DIGEST.test(parsed.sourceDigest)) {
    throw new Error(`Verified source digest is missing or invalid (${file})`);
  }
  assertFileList(parsed.files);
  return { commit: parsed.commit, sourceDigest: parsed.sourceDigest, files: parsed.files };
}

export function readGitCommit(root, execFileSync) {
  try {
    const commit = String(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true })).trim();
    if (!COMMIT.test(commit)) throw new Error(`git rev-parse HEAD returned '${commit}'`);
    return commit;
  } catch (error) {
    if (String(error.message).startsWith("git rev-parse HEAD returned")) throw error;
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    throw new Error(`Could not read the source commit with git rev-parse HEAD (cwd=${root})${stderr ? `: ${stderr}` : `: ${error.message}`}`);
  }
}

export function resolveSourceCommit(root, { fs, execFileSync }) {
  if (hasOwnGitMetadata(root, fs)) return { commit: readGitCommit(root, execFileSync), via: "git" };
  const recorded = readVerifiedSourceRevision(root, fs);
  return { commit: recorded.commit, via: "snapshot", recorded };
}

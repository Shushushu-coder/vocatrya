import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// Shared E2E database isolation contract. Every harness entry point that can
// reach a database write -- Playwright config load (webServer env, R3 fresh
// provisioning), global setup (setupTestUser), direct spec PrismaClients,
// and reuse-server consistency -- resolves the target through this module
// before the write. The checks compare canonical real paths and file
// identities, never URL substrings.
//
// A database file is writable only inside an explicitly designated
// disposable root:
//   - R3_EVIDENCE_DIR, when set: an operator-provided directory trusted
//     only after it proves narrow. It is rejected when it is, contains,
//     or sits inside the primary checkout or any linked worktree root of
//     this repository, when it is or contains the user profile or the OS
//     temp/system roots, and when it fails to resolve to a real
//     directory at all; or
//   - this checkout's own prisma/ directory, but only when Git registers
//     the checkout as a linked worktree in both directions (see
//     isLinkedWorktreeCheckout). The primary checkout's prisma/ holds
//     real development data and stays rejected.
// Path checks alone cannot see aliases, so an existing target must also be
// a regular file with exactly one directory entry (nlink === 1) and must
// not share volume + file-index identity with any file under a protected
// checkout's prisma/ -- a hard link smuggling a protected database into an
// allowed directory fails both. A not-yet-created target (legitimate R3
// fresh provisioning) is canonicalized through its nearest existing
// ancestor and rejected when it is a symlink, when its resolved location
// escapes the allowed roots, or when it would land inside a protected
// root. Anything else -- the root repository, another worktree's
// database, user-data directories, packaged installs, "../" escapes,
// junction redirects -- resolves outside every allowed root and fails
// closed.

export function normalizeCase(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function canonicalPath(p: string): string {
  const resolved = path.resolve(p);
  return existsSync(resolved) ? realpathSync(resolved) : resolved;
}

export function realDirectory(dir: string): string | null {
  const resolved = path.resolve(dir);
  return existsSync(resolved) ? realpathSync(resolved) : null;
}

export function isInsideDir(child: string, root: string): boolean {
  const relative = path.relative(normalizeCase(root), normalizeCase(child));
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

export function isInsideOrEqual(child: string, root: string): boolean {
  return normalizeCase(child) === normalizeCase(root) || isInsideDir(child, root);
}

export function isSameFile(a: string, b: string): boolean {
  try {
    return normalizeCase(realpathSync(a)) === normalizeCase(realpathSync(b));
  } catch {
    return false;
  }
}

function statOrNull(file: string) {
  try {
    return statSync(file);
  } catch {
    return null;
  }
}

function lstatOrNull(file: string) {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

// Every checkout sharing this repository is a protected location: the
// primary worktree's prisma/ holds real development data and any other
// worktree's database is equally off-limits. `git worktree list
// --porcelain` is authoritative; when no git binary is reachable the
// same topology is rebuilt from .git metadata (worktree .git file ->
// gitdir -> commondir -> worktrees/<name>/gitdir). Returning null means
// ownership cannot be proven, which callers must fail closed on.
// `fromGit` records whether git itself produced the list: the metadata
// fallback is good enough to enumerate protected roots, but it is not a
// registration record and can never grant the linked-worktree exemption.
export function gitWorktreeRoots(
  repoRoot: string,
): { primary: string; all: string[]; fromGit: boolean } | null {
  try {
    const out = execFileSync("git", ["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const roots = out
      .split("\n")
      .filter((line) => line.startsWith("worktree "))
      .map((line) =>
        canonicalPath(
          line
            .slice("worktree ".length)
            .trim()
            .replace(/^"|"$/g, ""),
        ),
      );
    if (roots.length > 0) return { primary: roots[0], all: roots, fromGit: true };
  } catch {
    // No git binary or not a repository: fall back to .git metadata.
  }
  try {
    const marker = path.join(repoRoot, ".git");
    let gitDir = marker;
    if (statSync(marker).isFile()) {
      const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(marker, "utf8"));
      if (!target) return null;
      gitDir = path.resolve(repoRoot, target[1].trim());
    }
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(
        gitDir,
        readFileSync(path.join(gitDir, "commondir"), "utf8").trim(),
      );
    } catch {
      // A primary checkout's .git is itself the common dir.
    }
    const primary = canonicalPath(
      path.basename(commonDir) === ".git" ? path.dirname(commonDir) : commonDir,
    );
    const all = new Set<string>([primary, canonicalPath(repoRoot)]);
    try {
      for (const entry of readdirSync(path.join(commonDir, "worktrees"))) {
        try {
          const target = readFileSync(
            path.join(commonDir, "worktrees", entry, "gitdir"),
            "utf8",
          ).trim();
          if (target) all.add(canonicalPath(path.dirname(target)));
        } catch {
          // A half-removed worktree can leave partial metadata; skip it.
        }
      }
    } catch {
      // No linked worktrees recorded in the common dir.
    }
    return { primary, all: [...all], fromGit: false };
  } catch {
    return null;
  }
}

export type E2EDatabaseIsolationContext = {
  repoRoot: string;
  // Canonical real directories that may hold disposable E2E databases.
  allowedRoots: string[];
  // Canonical real directories whose databases are never writable: every
  // other checkout sharing this repository, plus this checkout itself
  // whenever it is not a linked worktree.
  protectedRoots: string[];
  linkedWorktree: boolean;
};

// This checkout's own databases are disposable only when Git itself
// registers it as a linked worktree, proven in both directions and
// compared as canonical real paths:
//   - <checkout>/.git is a regular file naming an admin gitdir;
//   - <gitdir>/commondir exists and resolves to a real common git dir;
//   - the gitdir is exactly <common>/worktrees/<id>, one of the
//     worktrees that common dir records;
//   - the <gitdir>/gitdir backlink resolves to this checkout's .git file;
//   - `git worktree list --porcelain` lists this checkout, and not as
//     the primary entry.
// Path shape is never evidence: a --separate-git-dir primary whose gitdir
// happens to sit in a folder named "worktrees" has no commondir, and a
// hand-written .git file has no matching backlink or registration. Any
// read failure or mismatch fails closed and the checkout stays protected.
function isLinkedWorktreeCheckout(
  repoRoot: string,
  thisRoot: string,
  topology: { primary: string; all: string[]; fromGit: boolean },
): boolean {
  const same = (a: string, b: string) => normalizeCase(a) === normalizeCase(b);
  try {
    const gitMarker = path.join(repoRoot, ".git");
    if (!lstatSync(gitMarker).isFile()) return false;
    const target = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitMarker, "utf8"));
    if (!target) return false;
    const gitDir = realpathSync(path.resolve(repoRoot, target[1].trim()));
    if (!statSync(gitDir).isDirectory()) return false;
    const commonDir = realpathSync(
      path.resolve(
        gitDir,
        readFileSync(path.join(gitDir, "commondir"), "utf8").trim(),
      ),
    );
    if (!statSync(commonDir).isDirectory()) return false;
    const recorded = realpathSync(
      path.join(commonDir, "worktrees", path.basename(gitDir)),
    );
    if (!same(recorded, gitDir)) return false;
    const backlink = readFileSync(path.join(gitDir, "gitdir"), "utf8").trim();
    if (!backlink) return false;
    if (!same(realpathSync(path.resolve(gitDir, backlink)), realpathSync(gitMarker))) {
      return false;
    }
    if (!topology.fromGit) return false;
    const listed = topology.all.findIndex((root) => same(root, thisRoot));
    return listed > 0 && !same(topology.primary, thisRoot);
  } catch {
    return false;
  }
}

// Builds the shared isolation context for the checkout that owns the E2E
// harness. Throws (fails closed) whenever a required property cannot be
// proven: unresolvable git topology, a non-directory R3_EVIDENCE_DIR, an
// evidence dir that is or contains a checkout or a broad user/OS
// container, or an evidence dir inside a protected checkout.
export function resolveE2EIsolationContext(
  repoRoot: string,
  env: Record<string, string | undefined> = process.env,
): E2EDatabaseIsolationContext {
  const thisRoot = canonicalPath(repoRoot);
  const topology = gitWorktreeRoots(repoRoot);
  if (!topology) {
    throw new Error(
      "Refusing E2E database access: git worktree topology is unavailable, so protected checkout roots cannot be enumerated.",
    );
  }
  const linkedWorktree = isLinkedWorktreeCheckout(repoRoot, thisRoot, topology);
  // Topology can name a --separate-git-dir primary by its gitdir, so this
  // root cannot be assumed to appear in the list. A linked worktree alone
  // may exempt itself; the primary checkout always stays in the protected
  // set.
  const protectedRoots = linkedWorktree
    ? topology.all.filter(
        (root) => normalizeCase(root) !== normalizeCase(thisRoot),
      )
    : [...new Set([...topology.all, thisRoot])];

  const allowedRoots: string[] = [];
  if (env.R3_EVIDENCE_DIR) {
    const evidenceDir = realDirectory(env.R3_EVIDENCE_DIR);
    if (!evidenceDir) {
      throw new Error(
        `Refusing R3_EVIDENCE_DIR "${env.R3_EVIDENCE_DIR}": it does not resolve to a real directory, so its contents cannot be proven disposable.`,
      );
    }
    // An env-provided root is admitted only after proving narrowness: as
    // an allowed root it exposes everything beneath it, so it may not be,
    // contain, or sit inside any checkout of this repository, and it may
    // not be or contain a broad user/OS container.
    for (const root of topology.all) {
      if (isInsideOrEqual(root, evidenceDir)) {
        throw new Error(
          `Refusing R3_EVIDENCE_DIR "${evidenceDir}": it contains git worktree ${root}, which would re-admit that checkout's databases.`,
        );
      }
    }
    for (const root of protectedRoots) {
      if (isInsideOrEqual(evidenceDir, root)) {
        throw new Error(
          `Refusing R3_EVIDENCE_DIR "${evidenceDir}": it lives inside protected checkout ${root}.`,
        );
      }
    }
    for (const container of [
      os.homedir(),
      os.tmpdir(),
      env.USERPROFILE,
      env.APPDATA,
      env.LOCALAPPDATA,
      env.SystemRoot,
      env.windir,
    ]) {
      if (!container) continue;
      const containerRoot = canonicalPath(container);
      if (isInsideOrEqual(containerRoot, evidenceDir)) {
        throw new Error(
          `Refusing R3_EVIDENCE_DIR "${evidenceDir}": it contains user/OS directory ${containerRoot}; point it at a dedicated disposable directory.`,
        );
      }
    }
    allowedRoots.push(evidenceDir);
  }
  if (linkedWorktree) {
    const prismaDir = realDirectory(path.join(repoRoot, "prisma"));
    if (prismaDir) allowedRoots.push(prismaDir);
  }
  return { repoRoot: thisRoot, allowedRoots, protectedRoots, linkedWorktree };
}

// Canonicalizes a database path that may not exist yet: the nearest
// existing ancestor is resolved through realpath (collapsing junction and
// symlinked directories), then the missing tail is re-appended. A
// nonexistent target whose parent chain redirects outside the allowed
// roots is therefore still caught. Returns null when no ancestor exists,
// which callers treat as unprovable and reject.
function canonicalDatabasePath(target: string): string | null {
  let resolved = path.resolve(target);
  const missing: string[] = [];
  while (!existsSync(resolved)) {
    missing.unshift(path.basename(resolved));
    const parent = path.dirname(resolved);
    if (parent === resolved) return null;
    resolved = parent;
  }
  return path.join(realpathSync(resolved), ...missing);
}

// Asserts the shared isolation contract for a resolved database file.
// `allowMissing` permits a not-yet-created target after its canonical
// parentage proves safe (fresh R3 provisioning); existing targets must
// additionally be regular files with a single directory entry that share
// no dev+ino identity with files under a protected checkout's prisma/.
// Throws fail-closed on every unprovable property.
export function assertIsolatedE2EDatabase(
  targetPath: string,
  context: E2EDatabaseIsolationContext,
  options: { allowMissing?: boolean } = {},
): void {
  const canonical = canonicalDatabasePath(targetPath);
  if (!canonical) {
    throw new Error(
      `Refusing E2E database access to ${targetPath}: no existing ancestor directory, so its ownership cannot be proven.`,
    );
  }
  const lstat = lstatOrNull(canonical);
  if (lstat?.isSymbolicLink()) {
    throw new Error(
      `Refusing E2E database access to ${canonical}: the target is a symbolic link, which could alias a protected database.`,
    );
  }
  if (!lstat && !options.allowMissing) {
    throw new Error(
      `Refusing E2E database access to ${canonical}: the file does not exist; apply the existing migrations first.`,
    );
  }
  if (!context.allowedRoots.some((root) => isInsideDir(canonical, root))) {
    throw new Error(
      `Refusing E2E database access to ${canonical}: the database file must live inside this linked worktree's prisma/ directory or a narrow R3_EVIDENCE_DIR.`,
    );
  }
  for (const root of context.protectedRoots) {
    if (isInsideOrEqual(canonical, root)) {
      throw new Error(
        `Refusing E2E database access to ${canonical}: it lives inside protected checkout ${root}.`,
      );
    }
  }
  if (!lstat) return;

  const databaseStat = statOrNull(canonical);
  if (!databaseStat?.isFile() || databaseStat.nlink !== 1) {
    throw new Error(
      `Refusing E2E database access to ${canonical}: expected a regular file with exactly one directory entry (nlink=${databaseStat?.nlink ?? "unreadable"}); a second name could alias a protected database.`,
    );
  }
  if (databaseStat.ino !== 0) {
    for (const root of context.protectedRoots) {
      const protectedPrisma = path.join(root, "prisma");
      if (!existsSync(protectedPrisma)) continue;
      for (const entry of readdirSync(protectedPrisma)) {
        const stat = statOrNull(path.join(protectedPrisma, entry));
        if (
          stat?.isFile() &&
          stat.ino !== 0 &&
          stat.dev === databaseStat.dev &&
          stat.ino === databaseStat.ino
        ) {
          throw new Error(
            `Refusing E2E database access to ${canonical}: it is another name for protected file ${path.join(protectedPrisma, entry)}.`,
          );
        }
      }
    }
  }
}

// Reuse-server consistency: both the test database and the server's
// declared database must independently pass isolation before they are
// compared, and the comparison is by real file identity, never URL
// strings -- two environment variables naming the same unsafe database
// must still fail. The check proves the declared endpoints only; it
// cannot prove which database a running server actually opened.
export function assertConsistentReuseServerDatabase(
  databasePath: string,
  serverPath: string | null,
  context: E2EDatabaseIsolationContext,
): void {
  if (!serverPath) {
    throw new Error(
      "Reused server has no declared database: set E2E_SERVER_DATABASE_URL to the running server's DATABASE_URL.",
    );
  }
  assertIsolatedE2EDatabase(serverPath, context);
  if (!isSameFile(serverPath, databasePath)) {
    throw new Error(
      "Reused server is bound to a different database: set E2E_SERVER_DATABASE_URL to the running server's DATABASE_URL.",
    );
  }
}

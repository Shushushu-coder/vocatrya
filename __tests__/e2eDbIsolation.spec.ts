// @vitest-environment node
// Dedicated matrix for the shared E2E database isolation contract
// (e2e/support/isolation.ts) and the write gates built on it in
// e2e/support/database.ts, e2e/global-setup.ts and
// e2e/support/r3Harness.ts. Every offensive case runs against a
// disposable mock repository with real git worktree topology; no test may
// touch this checkout's real prisma/dev.db.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  assertConsistentReuseServerDatabase,
  assertIsolatedE2EDatabase,
  isSameFile,
  resolveE2EIsolationContext,
  type E2EDatabaseIsolationContext,
} from "../e2e/support/isolation";
import {
  resolveE2EDatabase,
  resolveIsolatedE2EDatabase,
} from "../e2e/support/database";

const WORKTREE = path.resolve(__dirname, "..");
const TS_NODE_BIN = path.join(WORKTREE, "node_modules", "ts-node", "dist", "bin.js");
const PLAYWRIGHT_CLI = path.join(
  WORKTREE, "node_modules", "@playwright", "test", "cli.js",
);
const ISOLATION_SRC = path.join(WORKTREE, "e2e", "support", "isolation.ts");
const DATABASE_SRC = path.join(WORKTREE, "e2e", "support", "database.ts");
const SETUP_TS = path.join(WORKTREE, "e2e", "setup.ts");
const SETUP_TSCONFIG = path.join(WORKTREE, "e2e", "tsconfig.setup.json");

let root: string;
// Directory junctions created for mock checkouts: they must be unlinked
// before rmSync, which would otherwise traverse or EPERM on them.
const junctions = new Set<string>();

function removeJunctions() {
  for (const link of junctions) {
    try {
      execFileSync("cmd", ["/c", "rmdir", link], { stdio: "pipe" });
    } catch {
      try {
        rmSync(link, { force: true });
      } catch {
        // Reclaimed by OS temp cleanup if still locked.
      }
    }
  }
  junctions.clear();
}

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function sha256(file: string) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

type Witness = {
  exists: boolean;
  sha256?: string;
  size?: number;
  mtimeMs?: number;
  ino?: number;
  nlink?: number;
  users?: number;
  migrations?: number;
  dirListing?: string[];
};

// Content + identity + container snapshot. A refused write gate must leave
// every element identical: no content change, no relink, no WAL/journal/
// shm siblings, no new sibling files, no extra rows.
function snapshotDatabase(file: string): Witness {
  const dir = path.dirname(file);
  const witness: Witness = {
    exists: existsSync(file),
    dirListing: existsSync(dir) ? readdirSync(dir).sort() : [],
  };
  if (!witness.exists) return witness;
  const stat = statSync(file);
  witness.sha256 = sha256(file);
  witness.size = stat.size;
  witness.mtimeMs = stat.mtimeMs;
  witness.ino = stat.ino;
  witness.nlink = stat.nlink;
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      witness.users = Number(
        db.prepare("SELECT COUNT(*) AS c FROM User").get()?.c,
      );
      witness.migrations = Number(
        db.prepare("SELECT COUNT(*) AS c FROM _prisma_migrations").get()?.c,
      );
    } finally {
      db.close();
    }
  } catch {
    // A non-SQLite witness still gets content/identity coverage.
  }
  witness.dirListing = readdirSync(dir).sort();
  return witness;
}

function expectUnchanged(before: Witness, file: string) {
  const after = snapshotDatabase(file);
  expect(after, `protected database ${file} must be byte-identical after refusal`)
    .toEqual(before);
}

// A witness SQLite carrying marker rows: one user row and three fake
// migration rows. If migrations ran on this file the row set would change;
// if setupTestUser ran, the user count would grow.
function makeWitnessDb(file: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode=DELETE");
    db.exec("CREATE TABLE User (id TEXT PRIMARY KEY, email TEXT UNIQUE)");
    db.exec("CREATE TABLE _prisma_migrations (id TEXT PRIMARY KEY)");
    db.exec("INSERT INTO _prisma_migrations VALUES ('m1'), ('m2'), ('m3')");
    db.exec("INSERT INTO User VALUES ('u1', 'witness@example.test')");
  } finally {
    db.close();
  }
}

function makeMockPrimary(root: string): string {
  const dir = path.join(root, "primary");
  mkdirSync(dir, { recursive: true });
  git(["init"], dir);
  git(
    ["-c", "user.email=mock@test", "-c", "user.name=mock", "commit", "--allow-empty", "-m", "init"],
    dir,
  );
  mkdirSync(path.join(dir, "prisma"), { recursive: true });
  makeWitnessDb(path.join(dir, "prisma", "dev.db"));
  writeFileSync(path.join(dir, ".env"), "DATABASE_URL=file:dev.db\n");
  return dir;
}

// Copies the real harness sources into the mock checkout and junctions the
// worktree's node_modules, so the driver runs the production gate code
// with the mock checkout as E2E_REPO_ROOT.
function installHarness(checkout: string) {
  const support = path.join(checkout, "e2e", "support");
  mkdirSync(support, { recursive: true });
  copyFileSync(ISOLATION_SRC, path.join(support, "isolation.ts"));
  copyFileSync(DATABASE_SRC, path.join(support, "database.ts"));
  writeFileSync(
    path.join(checkout, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { module: "CommonJS", esModuleInterop: true, skipLibCheck: true },
    }),
  );
  const link = path.join(checkout, "node_modules");
  if (!existsSync(link)) {
    execFileSync("cmd", ["/c", "mklink", "/J", link, path.join(WORKTREE, "node_modules")], {
      stdio: "pipe",
    });
    junctions.add(link);
  }
}

const DRIVER = `
import { configureE2EDatabase } from "./e2e/support/database";
import {
  assertIsolatedE2EDatabase,
  isSameFile,
  resolveE2EIsolationContext,
} from "./e2e/support/isolation";

async function main() {
  try {
    // Mirrors global-setup.ts: config-level gate, then the pre-write
    // re-assertion, then the first real write through PrismaClient.
    const database = configureE2EDatabase();
    assertIsolatedE2EDatabase(
      database.path,
      resolveE2EIsolationContext(__dirname),
    );
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient({ datasourceUrl: database.url });
    try {
      const attached = await prisma.$queryRawUnsafe<{ name: string; file: string }[]>(
        "PRAGMA database_list",
      );
      const main = attached.find((row) => row.name === "main");
      if (!main || !isSameFile(main.file, database.path)) {
        throw new Error("engine opened a different database than resolved");
      }
      if (process.argv.includes("--write")) {
        await prisma.$executeRawUnsafe(
          "CREATE TABLE IF NOT EXISTS WbgProbe (id INTEGER PRIMARY KEY)",
        );
      }
    } finally {
      await prisma.$disconnect();
    }
    console.log("HARNESS_OK");
  } catch (error) {
    console.error(
      "HARNESS_REFUSED: " + (error instanceof Error ? error.message : String(error)),
    );
    process.exit(3);
  }
}
void main();
`;

function installDriver(checkout: string) {
  writeFileSync(path.join(checkout, "driver.ts"), DRIVER);
}

type RunResult = { status: number | null; stdout: string; stderr: string };

// Child processes get a hermetic env: ambient DATABASE_URL/R3/reuse flags
// are stripped unless the case sets them explicitly; each mock checkout's
// own .env supplies DATABASE_URL like a developer checkout would.
function childEnv(env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const merged = { ...process.env, ...env } as NodeJS.ProcessEnv;
  for (const key of [
    "DATABASE_URL",
    "R3_EVIDENCE_DIR",
    "E2E_REUSE_EXISTING_SERVER",
    "E2E_SERVER_DATABASE_URL",
  ]) {
    if (!(key in env)) delete merged[key];
  }
  return merged;
}

function runDriver(checkout: string, env: Record<string, string | undefined> = {}, args: string[] = []): RunResult {
  const result = spawnSync(
    process.execPath,
    [
      TS_NODE_BIN,
      "--transpile-only",
      "--project",
      path.join(checkout, "tsconfig.json"),
      path.join(checkout, "driver.ts"),
      ...args,
    ],
    { cwd: checkout, env: childEnv(env), encoding: "utf8", timeout: 120_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function runRealSetupTs(checkout: string, env: Record<string, string | undefined> = {}): RunResult {
  const result = spawnSync(
    process.execPath,
    [TS_NODE_BIN, "--transpile-only", "--project", SETUP_TSCONFIG, SETUP_TS],
    { cwd: checkout, env: childEnv(env), encoding: "utf8", timeout: 120_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const MOCK_PLAYWRIGHT_CONFIG = `
import { defineConfig } from "@playwright/test";
import { configureE2EDatabase } from "./e2e/support/database";

const database = configureE2EDatabase();

export default defineConfig({
  testDir: "./e2e",
  reporter: [["list"]],
  projects: [{ name: "probe" }],
  webServer: {
    command: "node server-writer.mjs",
    url: "http://localhost:39171",
    reuseExistingServer: false,
    timeout: 15000,
    env: { DATABASE_URL: database.url },
  },
});
`;

const MOCK_PROBE_SPEC = `
import path from "node:path";
import { test, expect } from "@playwright/test";
import { configureE2EDatabase } from "./support/database";
import {
  assertIsolatedE2EDatabase,
  isSameFile,
  resolveE2EIsolationContext,
} from "./support/isolation";

test("spec-level gated write reaches the isolated database", async () => {
  const database = configureE2EDatabase();
  assertIsolatedE2EDatabase(
    database.path,
    resolveE2EIsolationContext(path.resolve(__dirname, "..")),
  );
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: database.url });
  try {
    const attached = await prisma.$queryRawUnsafe<{ name: string; file: string }[]>(
      "PRAGMA database_list",
    );
    const main = attached.find((row) => row.name === "main");
    expect(main && isSameFile(main.file, database.path)).toBe(true);
    await prisma.$executeRawUnsafe(
      "CREATE TABLE IF NOT EXISTS WbgProbe (id INTEGER PRIMARY KEY)",
    );
  } finally {
    await prisma.$disconnect();
  }
});
`;

// A webServer that writes a marker row to DATABASE_URL before serving: if a
// gate misfires, the row proves the server reached a writable state.
const MOCK_SERVER_WRITER = `
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";

const url = process.env.DATABASE_URL ?? "";
const file = url.startsWith("file:") ? url.slice(5) : url;
const db = new DatabaseSync(file);
db.exec("CREATE TABLE IF NOT EXISTS ServerWrote (id INTEGER PRIMARY KEY)");
db.exec("INSERT INTO ServerWrote (id) VALUES (1)");
db.close();
createServer((req, res) => res.end("ok")).listen(39171, "localhost");
`;

function installPlaywrightProject(checkout: string) {
  writeFileSync(path.join(checkout, "playwright.config.ts"), MOCK_PLAYWRIGHT_CONFIG);
  writeFileSync(path.join(checkout, "e2e", "probe.spec.ts"), MOCK_PROBE_SPEC);
  writeFileSync(path.join(checkout, "server-writer.mjs"), MOCK_SERVER_WRITER);
}

function runPlaywright(checkout: string, env: Record<string, string | undefined> = {}): RunResult {
  const result = spawnSync(
    process.execPath,
    [PLAYWRIGHT_CLI, "test", "--reporter=list"],
    { cwd: checkout, env: childEnv(env), encoding: "utf8", timeout: 120_000 },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function tableExists(file: string, table: string): boolean {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?")
      .get(table);
    return Number(row?.c) === 1;
  } finally {
    db.close();
  }
}

describe("shared E2E database isolation contract", () => {
  let primary: string;
  let linked: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(path.join(os.tmpdir(), "vocatrya-iso-"));
    primary = makeMockPrimary(root);
    git(["worktree", "add", path.join(root, "linked"), "-b", "linked-mock"], primary);
    linked = path.join(root, "linked");
    mkdirSync(path.join(linked, "prisma"), { recursive: true });
    makeWitnessDb(path.join(linked, "prisma", "dev.db"));
    writeFileSync(path.join(linked, ".env"), "DATABASE_URL=file:dev.db\n");
    outside = path.join(root, "outside");
    mkdirSync(outside, { recursive: true });
  });

  afterAll(() => {
    // Junctions come out before git cleanup, which walks the tree itself.
    removeJunctions();
    try {
      git(["worktree", "remove", "--force", linked], primary);
    } catch {
      // Best-effort; rmSync below still reclaims the files.
    }
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
    } catch {
      // Leftover temp residue (e.g. a released-after-exit junction target
      // lock) is reclaimed by OS temp cleanup; it is never evidence.
    }
  });

  const ctx = (repo: string, env: Record<string, string | undefined> = {}) =>
    resolveE2EIsolationContext(repo, env);

  describe("context resolution", () => {
    it("admits a linked worktree's own prisma as the disposable root", () => {
      const context = ctx(linked);
      expect(context.linkedWorktree).toBe(true);
      const prismaDir = path.join(linked, "prisma");
      expect(
        context.allowedRoots.map((p) => p.toLowerCase()),
      ).toContain(realpathSync(prismaDir).toLowerCase());
      expect(
        context.protectedRoots.map((p) => p.toLowerCase()),
      ).toContain(realpathSync(primary).toLowerCase());
    });

    it("never exempts the primary checkout: its own prisma stays protected", () => {
      const context = ctx(primary);
      expect(context.linkedWorktree).toBe(false);
      expect(context.allowedRoots).toHaveLength(0);
      const primaryReal = realpathSync(primary).toLowerCase();
      expect(context.protectedRoots.map((p) => p.toLowerCase())).toContain(primaryReal);
    });

    it("treats a --separate-git-dir checkout as a protected primary", () => {
      const gitdir = path.join(root, "separated.git");
      const checkout = path.join(root, "separated");
      git(["init", "--separate-git-dir", gitdir, checkout], root);
      mkdirSync(path.join(checkout, "prisma"), { recursive: true });
      makeWitnessDb(path.join(checkout, "prisma", "dev.db"));
      const context = ctx(checkout);
      expect(context.linkedWorktree).toBe(false);
      expect(() =>
        assertIsolatedE2EDatabase(path.join(checkout, "prisma", "dev.db"), context),
      ).toThrow(/Refusing E2E database access/);
    });

    it("fails closed when git metadata cannot be resolved", () => {
      // A directory with no .git: on machines where an ancestor directory
      // is itself a git checkout, `git worktree list` still resolves --
      // to a foreign topology in which this root is protected. Either way
      // the contract stays closed: no allowed root, every target refused.
      const bare = path.join(root, "no-git-at-all");
      mkdirSync(bare, { recursive: true });
      const bareDb = path.join(bare, "prisma", "dev.db");
      makeWitnessDb(bareDb);
      const bareBefore = snapshotDatabase(bareDb);
      try {
        const context = ctx(bare);
        expect(context.allowedRoots).toHaveLength(0);
        expect(() => assertIsolatedE2EDatabase(bareDb, context)).toThrow(
          /Refusing E2E database access/);
      } catch (error) {
        expect(String(error)).toMatch(/topology is unavailable/);
      }
      expectUnchanged(bareBefore, bareDb);

      // A .git marker that yields no gitdir line at all is the true
      // unresolvable case: topology cannot be enumerated, so the context
      // itself fails closed.
      const corrupt = path.join(root, "corrupt-git");
      mkdirSync(corrupt, { recursive: true });
      writeFileSync(path.join(corrupt, ".git"), "this is not a gitdir line\n");
      expect(() => ctx(corrupt)).toThrow(/topology is unavailable/);
    });
  });

  describe("R3_EVIDENCE_DIR narrowness", () => {
    it("admits a dedicated narrow evidence directory", () => {
      const evidence = path.join(root, "evidence-ok");
      mkdirSync(evidence, { recursive: true });
      const context = ctx(linked, { R3_EVIDENCE_DIR: evidence });
      expect(context.allowedRoots.map((p) => p.toLowerCase())).toContain(
        realpathSync(evidence).toLowerCase(),
      );
      const db = path.join(evidence, "r3.db");
      makeWitnessDb(db);
      expect(() => assertIsolatedE2EDatabase(db, context)).not.toThrow();
    });

    it("rejects R3_EVIDENCE_DIR pointing at the primary checkout's own prisma", () => {
      expect(() =>
        ctx(primary, { R3_EVIDENCE_DIR: path.join(primary, "prisma") }),
      ).toThrow(/Refusing R3_EVIDENCE_DIR/);
    });

    it("rejects R3_EVIDENCE_DIR set to a parent of the primary checkout", () => {
      expect(() =>
        ctx(primary, { R3_EVIDENCE_DIR: path.dirname(primary) }),
      ).toThrow(/Refusing R3_EVIDENCE_DIR/);
      expect(() => ctx(linked, { R3_EVIDENCE_DIR: root })).toThrow(
        /Refusing R3_EVIDENCE_DIR/,
      );
    });

    it("rejects R3_EVIDENCE_DIR inside a protected checkout", () => {
      expect(() =>
        ctx(linked, { R3_EVIDENCE_DIR: path.join(primary, "evidence") }),
      ).toThrow(/Refusing R3_EVIDENCE_DIR/);
    });

    it("rejects R3_EVIDENCE_DIR naming broad user/OS containers", () => {
      expect(() => ctx(linked, { R3_EVIDENCE_DIR: os.tmpdir() })).toThrow(
        /Refusing R3_EVIDENCE_DIR/,
      );
      expect(() => ctx(linked, { R3_EVIDENCE_DIR: os.homedir() })).toThrow(
        /Refusing R3_EVIDENCE_DIR/,
      );
    });

    it("rejects a nonexistent R3_EVIDENCE_DIR", () => {
      expect(() =>
        ctx(linked, { R3_EVIDENCE_DIR: path.join(root, "missing-evidence") }),
      ).toThrow(/does not resolve to a real directory/);
    });
  });

  describe("assertIsolatedE2EDatabase", () => {
    it("admits the linked worktree's own migrated database", () => {
      const context = ctx(linked);
      expect(() =>
        assertIsolatedE2EDatabase(path.join(linked, "prisma", "dev.db"), context),
      ).not.toThrow();
    });

    it("rejects the primary checkout's dev.db and leaves it byte-identical", () => {
      const target = path.join(primary, "prisma", "dev.db");
      const before = snapshotDatabase(target);
      const context = ctx(primary);
      expect(() => assertIsolatedE2EDatabase(target, context)).toThrow(
        /Refusing E2E database access/);
      expectUnchanged(before, target);
      // The same file is also rejected from the linked worktree's context:
      // another checkout's database never becomes writable.
      expect(() => assertIsolatedE2EDatabase(target, ctx(linked))).toThrow(
        /Refusing E2E database access/);
      expectUnchanged(before, target);
    });

    it("rejects a database in another linked worktree", () => {
      const otherLinked = path.join(root, "linked-two");
      git(["worktree", "add", otherLinked, "-b", "linked-mock-two"], primary);
      try {
        mkdirSync(path.join(otherLinked, "prisma"), { recursive: true });
        const target = path.join(otherLinked, "prisma", "dev.db");
        makeWitnessDb(target);
        const before = snapshotDatabase(target);
        expect(() => assertIsolatedE2EDatabase(target, ctx(linked))).toThrow(
          /Refusing E2E database access/);
        expectUnchanged(before, target);
      } finally {
        git(["worktree", "remove", "--force", otherLinked], primary);
      }
    });

    it("rejects relative-path escapes resolved outside every allowed root", () => {
      const escaped = path.join(outside, "escaped.db");
      makeWitnessDb(escaped);
      const before = snapshotDatabase(escaped);
      // <linked>/prisma/../../outside/escaped.db -> <root>/outside/escaped.db
      const resolved = resolveE2EDatabase(
        "file:../../outside/escaped.db",
        linked,
      );
      expect(isSameFile(resolved.path, escaped)).toBe(true);
      expect(() =>
        assertIsolatedE2EDatabase(resolved.path, ctx(linked)),
      ).toThrow(/Refusing E2E database access/);
      expectUnchanged(before, escaped);
    });

    it("rejects a junctioned directory chain escaping into a protected checkout", () => {
      const junction = path.join(linked, "prisma", "junc-escape");
      execFileSync("cmd", ["/c", "mklink", "/J", junction, primary], { stdio: "pipe" });
      junctions.add(junction);
      const target = path.join(junction, "prisma", "dev.db");
      const before = snapshotDatabase(path.join(primary, "prisma", "dev.db"));
      expect(() => assertIsolatedE2EDatabase(target, ctx(linked))).toThrow(
        /Refusing E2E database access/);
      expectUnchanged(before, path.join(primary, "prisma", "dev.db"));
    });

    it("rejects a file symlinked to a protected database", (t) => {
      const evidence = path.join(root, "evidence-symlink");
      mkdirSync(evidence, { recursive: true });
      const context = ctx(linked, { R3_EVIDENCE_DIR: evidence });
      const link = path.join(evidence, "linked.db");
      try {
        symlinkSync(path.join(primary, "prisma", "dev.db"), link, "file");
      } catch (error) {
        // No SeCreateSymbolicLinkPrivilege: skip rather than fake coverage.
        t.skip(`file symlink unavailable on this host: ${error}`);
      }
      const before = snapshotDatabase(path.join(primary, "prisma", "dev.db"));
      expect(() => assertIsolatedE2EDatabase(link, context)).toThrow(
        /Refusing E2E database access/);
      expectUnchanged(before, path.join(primary, "prisma", "dev.db"));
    });

    it("rejects a hard link aliasing a protected database inside an allowed root", () => {
      const alias = path.join(linked, "prisma", "alias.db");
      linkSync(path.join(primary, "prisma", "dev.db"), alias);
      const before = snapshotDatabase(path.join(primary, "prisma", "dev.db"));
      expect(() => assertIsolatedE2EDatabase(alias, ctx(linked))).toThrow(
        /Refusing E2E database access/);
      expectUnchanged(before, path.join(primary, "prisma", "dev.db"));
      expect(statSync(alias).nlink).toBe(2);
    });

    it("rejects a missing target unless allowMissing is set", () => {
      const missing = path.join(linked, "prisma", "not-created.db");
      const context = ctx(linked);
      expect(() => assertIsolatedE2EDatabase(missing, context)).toThrow(
        /does not exist/);
      expect(() =>
        assertIsolatedE2EDatabase(missing, context, { allowMissing: true }),
      ).not.toThrow();
      // A symlink whose target does not exist is refused by identity:
      // the canonical path keeps the link name, so lstat still sees the
      // link itself.
      const dangling = path.join(linked, "prisma", "dangling.db");
      try {
        symlinkSync(
          path.join(primary, "prisma", "not-created-protected.db"),
          dangling,
          "file",
        );
      } catch {
        return; // Symlink privilege unavailable; junction coverage stands.
      }
      expect(() =>
        assertIsolatedE2EDatabase(dangling, context, { allowMissing: true }),
      ).toThrow(/symbolic link/);
    });

    it("rejects a nonexistent fresh target inside a protected parent chain", () => {
      const context = ctx(linked);
      expect(() =>
        assertIsolatedE2EDatabase(
          path.join(primary, "prisma", "fresh-not-created.db"),
          context,
          { allowMissing: true },
        ),
      ).toThrow(/Refusing E2E database access/);
    });
  });

  describe("reuse-server consistency", () => {
    let context: E2EDatabaseIsolationContext;
    let linkedDb: string;

    beforeAll(() => {
      context = ctx(linked);
      linkedDb = path.join(linked, "prisma", "dev.db");
    });

    it("admits a consistent reuse-server pair on the same isolated file", () => {
      expect(() =>
        assertConsistentReuseServerDatabase(linkedDb, linkedDb, context),
      ).not.toThrow();
    });

    it("rejects when both URLs name the same unsafe database", () => {
      const unsafe = path.join(primary, "prisma", "dev.db");
      const before = snapshotDatabase(unsafe);
      expect(() =>
        assertConsistentReuseServerDatabase(unsafe, unsafe, context),
      ).toThrow(/Refusing E2E database access/);
      expectUnchanged(before, unsafe);
    });

    it("rejects a mismatched server database even when it is isolated", () => {
      const evidence = path.join(root, "evidence-reuse");
      mkdirSync(evidence, { recursive: true });
      const serverDb = path.join(evidence, "server.db");
      makeWitnessDb(serverDb);
      const reuseCtx = ctx(linked, { R3_EVIDENCE_DIR: evidence });
      expect(() =>
        assertConsistentReuseServerDatabase(linkedDb, serverDb, reuseCtx),
      ).toThrow(/bound to a different database/);
    });

    it("rejects a missing server database declaration", () => {
      expect(() =>
        assertConsistentReuseServerDatabase(linkedDb, null, context),
      ).toThrow(/no declared database/);
    });
  });

  describe("resolveIsolatedE2EDatabase (harness-level, this checkout)", () => {
    it("admits this worktree's own migrated dev.db", () => {
      const url = `file:${path.join(WORKTREE, "prisma", "dev.db").replace(/\\/g, "/")}`;
      const resolved = resolveIsolatedE2EDatabase(url);
      expect(isSameFile(resolved.path, path.join(WORKTREE, "prisma", "dev.db"))).toBe(
        true,
      );
    });

    it("rejects non-file URLs before any filesystem trust decision", () => {
      expect(() => resolveIsolatedE2EDatabase("postgresql://u:p@h/db")).toThrow(
        /local, migrated SQLite/,
      );
      expect(() => resolveIsolatedE2EDatabase("file::memory:")).toThrow(
        /local, migrated SQLite/,
      );
      expect(() => resolveIsolatedE2EDatabase("file:")).toThrow(/must name/);
    });

    it("rejects URLs resolving outside the disposable roots", () => {
      const escaped = path.join(outside, "url-escape.db");
      makeWitnessDb(escaped);
      const before = snapshotDatabase(escaped);
      const url = `file:${escaped.replace(/\\/g, "/")}`;
      expect(() => resolveIsolatedE2EDatabase(url)).toThrow(
        /Refusing E2E database access/);
      expectUnchanged(before, escaped);
    });
  });

  describe("harness entry points inside a mock repository", () => {
    let mockPrimary: string;
    let mockLinked: string;

    beforeAll(() => {
      const sandbox = path.join(root, "harness-mock");
      mockPrimary = makeMockPrimary(sandbox);
      git(
        ["worktree", "add", path.join(sandbox, "linked"), "-b", "harness-linked"],
        mockPrimary,
      );
      mockLinked = path.join(sandbox, "linked");
      mkdirSync(path.join(mockLinked, "prisma"), { recursive: true });
      makeWitnessDb(path.join(mockLinked, "prisma", "dev.db"));
      writeFileSync(path.join(mockLinked, ".env"), "DATABASE_URL=file:dev.db\n");
      for (const checkout of [mockPrimary, mockLinked]) {
        installHarness(checkout);
        installDriver(checkout);
      }
    });

    afterAll(() => {
      try {
        git(["worktree", "remove", "--force", mockLinked], mockPrimary);
      } catch {
        // rmSync in the outer afterAll still reclaims the sandbox.
      }
    });

    it("configure+write path succeeds inside a linked worktree", () => {
      const target = path.join(mockLinked, "prisma", "dev.db");
      const run = runDriver(mockLinked, {}, ["--write"]);
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout).toContain("HARNESS_OK");
      expect(tableExists(target, "WbgProbe")).toBe(true);
      expect(
        Number(
          new DatabaseSync(target, { readOnly: true })
            .prepare("SELECT COUNT(*) AS c FROM User")
            .get()?.c,
        ),
      ).toBe(1);
    });

    it("refuses in a primary checkout before any database write (npm run test path)", () => {
      const target = path.join(mockPrimary, "prisma", "dev.db");
      const before = snapshotDatabase(target);
      const run = runDriver(mockPrimary, {}, ["--write"]);
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toMatch(/Refusing E2E database access/);
      expect(run.stdout).not.toContain("HARNESS_OK");
      expectUnchanged(before, target);
      expect(tableExists(target, "WbgProbe")).toBe(false);
    });

    it("refuses the real test:e2e:setup entry under a primary checkout", () => {
      const target = path.join(mockPrimary, "prisma", "dev.db");
      const before = snapshotDatabase(target);
      const run = runRealSetupTs(mockPrimary);
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toMatch(
        /Refusing E2E database access|E2E setup failed/,
      );
      expectUnchanged(before, target);
      // No seed, no migration, no journal residue on the protected file.
      const after = snapshotDatabase(target);
      expect(after.users).toBe(before.users);
      expect(after.migrations).toBe(before.migrations);
      expect(after.dirListing).toEqual(before.dirListing);
    });

    it("refuses a linked-worktree run whose DATABASE_URL points at the primary", () => {
      const target = path.join(mockPrimary, "prisma", "dev.db");
      const before = snapshotDatabase(target);
      const run = runDriver(mockLinked, {
        DATABASE_URL: `file:${target.replace(/\\/g, "/")}`,
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toMatch(/Refusing E2E database access/);
      expectUnchanged(before, target);
    });

    it("refuses reuse-server when both endpoints name the protected database", () => {
      const target = path.join(mockPrimary, "prisma", "dev.db");
      const before = snapshotDatabase(target);
      const run = runDriver(mockLinked, {
        DATABASE_URL: `file:${target.replace(/\\/g, "/")}`,
        E2E_REUSE_EXISTING_SERVER: "1",
        E2E_SERVER_DATABASE_URL: `file:${target.replace(/\\/g, "/")}`,
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toMatch(/Refusing E2E database access/);
      expectUnchanged(before, target);
    });

    it("refuses reuse-server when the declared server database differs", () => {
      const target = path.join(mockLinked, "prisma", "dev.db");
      const other = path.join(outside, "other-server.db");
      makeWitnessDb(other);
      const before = snapshotDatabase(target);
      const run = runDriver(mockLinked, {
        DATABASE_URL: `file:${target.replace(/\\/g, "/")}`,
        E2E_REUSE_EXISTING_SERVER: "1",
        E2E_SERVER_DATABASE_URL: `file:${other.replace(/\\/g, "/")}`,
      });
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toMatch(
        /Refusing E2E database access|different database/,
      );
      expectUnchanged(before, target);
    });

    it("refuses when DATABASE_URL is missing entirely", () => {
      const noEnvDir = path.join(root, "no-env-linked");
      git(["worktree", "add", noEnvDir, "-b", "no-env-mock"], mockPrimary);
      try {
        mkdirSync(path.join(noEnvDir, "prisma"), { recursive: true });
        installHarness(noEnvDir);
        installDriver(noEnvDir);
        const childEnv = { ...process.env };
        delete childEnv.DATABASE_URL;
        const result = spawnSync(
          process.execPath,
          [
            TS_NODE_BIN,
            "--transpile-only",
            "--project",
            path.join(noEnvDir, "tsconfig.json"),
            path.join(noEnvDir, "driver.ts"),
          ],
          { cwd: noEnvDir, env: childEnv, encoding: "utf8", timeout: 120_000 },
        );
        expect(result.status).not.toBe(0);
        expect((result.stderr ?? "") + (result.stdout ?? "")).toMatch(
          /Set DATABASE_URL|Refusing/,
        );
      } finally {
        git(["worktree", "remove", "--force", noEnvDir], mockPrimary);
      }
    });
  });

  describe("playwright entry inside the mock repository", () => {
    let pwPrimary: string;
    let pwLinked: string;

    beforeAll(() => {
      const sandbox = path.join(root, "pw-mock");
      pwPrimary = makeMockPrimary(sandbox);
      git(
        ["worktree", "add", path.join(sandbox, "linked"), "-b", "pw-linked"],
        pwPrimary,
      );
      pwLinked = path.join(sandbox, "linked");
      mkdirSync(path.join(pwLinked, "prisma"), { recursive: true });
      makeWitnessDb(path.join(pwLinked, "prisma", "dev.db"));
      writeFileSync(path.join(pwLinked, ".env"), "DATABASE_URL=file:dev.db\n");
      for (const checkout of [pwPrimary, pwLinked]) {
        installHarness(checkout);
        installPlaywrightProject(checkout);
      }
    });

    afterAll(() => {
      try {
        git(["worktree", "remove", "--force", pwLinked], pwPrimary);
      } catch {
        // Outer rmSync still reclaims the sandbox.
      }
    });

    it("aborts the whole run at config load in a primary checkout, before any write", () => {
      const target = path.join(pwPrimary, "prisma", "dev.db");
      const before = snapshotDatabase(target);
      const run = runPlaywright(pwPrimary);
      expect(run.status).not.toBe(0);
      expect(run.stderr + run.stdout).toMatch(/Refusing E2E database access/);
      // The marker server never booted, so its write never happened.
      expect(tableExists(target, "ServerWrote")).toBe(false);
      expectUnchanged(before, target);
      expect(existsSync(path.join(pwPrimary, "test-results"))).toBe(false);
    });

    it("runs the spec-level write path inside a linked worktree", () => {
      const target = path.join(pwLinked, "prisma", "dev.db");
      const run = runPlaywright(pwLinked);
      expect(run.status, run.stderr + run.stdout).toBe(0);
      // The spec-level gate opened the right engine file and wrote.
      expect(tableExists(target, "WbgProbe")).toBe(true);
      // The marker webServer also reached the same isolated database.
      expect(tableExists(target, "ServerWrote")).toBe(true);
      // The witness rows are still intact -- only additive probe tables.
      expect(
        Number(
          new DatabaseSync(target, { readOnly: true })
            .prepare("SELECT COUNT(*) AS c FROM User")
            .get()?.c,
        ),
      ).toBe(1);
    }, 120_000);
  });

  describe("fresh R3 provisioning gate (allowMissing)", () => {
    it("permits creating a fresh database inside a narrow evidence dir, then locks identity", () => {
      const evidence = path.join(root, "evidence-fresh");
      mkdirSync(evidence, { recursive: true });
      const context = ctx(linked, { R3_EVIDENCE_DIR: evidence });
      const fresh = path.join(evidence, "fresh-native.db");
      expect(() =>
        assertIsolatedE2EDatabase(fresh, context, { allowMissing: true }),
      ).not.toThrow();
      makeWitnessDb(fresh);
      expect(() => assertIsolatedE2EDatabase(fresh, context)).not.toThrow();
    });

    it("refuses a pre-seeded junction redirect under the evidence dir", () => {
      const evidence = path.join(root, "evidence-junc");
      mkdirSync(evidence, { recursive: true });
      const junction = path.join(evidence, "redirect");
      execFileSync("cmd", ["/c", "mklink", "/J", junction, path.join(primary, "prisma")], {
        stdio: "pipe",
      });
      junctions.add(junction);
      const context = ctx(linked, { R3_EVIDENCE_DIR: evidence });
      const target = path.join(junction, "dev.db");
      const before = snapshotDatabase(path.join(primary, "prisma", "dev.db"));
      expect(() =>
        assertIsolatedE2EDatabase(target, context, { allowMissing: true }),
      ).toThrow(/Refusing E2E database access/);
      expectUnchanged(before, path.join(primary, "prisma", "dev.db"));
    });
  });
});

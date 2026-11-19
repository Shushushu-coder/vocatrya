import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AB_ROLLOUT_SCOPE,
  resolveAbRolloutScope,
} from "@/lib/career/capabilities";
import { AB_ROLLOUT_SCOPE_ENV } from "@/lib/career/identities";

const REPO = path.resolve(__dirname, "..");
const SCOPE_ENV = "VOCATRYA_AB_ROLLOUT_SCOPE";

const SCAN_NAME = /\.(ts|tsx|js|mjs|yml|yaml|example|md)$/;

// The assertion is about tracked repository source, never about whatever
// local files happen to sit in the checkout. git ls-files enumerates exactly
// the committed tree, which excludes .gitignored docs, nested .worktrees,
// node_modules, screenshots, and other untracked debris without maintaining
// a hand-curated exclusion list.
function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map((relative) => path.join(root, relative));
}

function scanCandidates(root: string): string[] {
  return trackedFiles(root).filter(
    (file) =>
      fs.existsSync(file) &&
      (SCAN_NAME.test(file) || path.basename(file) === ".env.example"),
  );
}

const ALLOWED_READERS = new Set([
  path.join("src", "lib", "career", "capabilities.ts"),
  path.join("src", "lib", "career", "rolloutScope.ts"),
  path.join("src", "lib", "career", "identities.ts"),
  "docker-compose.yml",
  "docker-entrypoint.sh",
  ".env.example",
  // Windows Desktop Shell POC forces the disposable backend scope to
  // fail-closed "none" for isolation. It never reads the scope to enable
  // product capabilities; see WINDOWS_DESKTOP_SHELL_POC audit.
  path.join("desktop", "main", "runtime.js"),
  // R3 Playwright config pins the disposable fresh-native server's scope to
  // "full" via r3ServerLauncher.mjs. It sets a synthetic child environment
  // and does not read the operator's rollout scope.
  path.join("e2e", "r3-foundation.config.ts"),
  // Desktop E2E / closure harnesses likewise pin a synthetic scope on the
  // disposable child they launch; none reads the operator's scope.
  path.join("desktop", "e2e", "harness.mjs"),
  path.join("scripts", "managed-closure-ready", "managed-desktop.mjs"),
  path.join("scripts", "p2-closure-ready", "desktop-closure.mjs"),
  path.join("scripts", "p2-closure-ready", "package.mjs"),
]);

function violatingReaders(root: string): string[] {
  const violations: string[] = [];
  for (const file of scanCandidates(root)) {
    const relative = path.relative(root, file);
    // Tracked tests and specs stay outside the assertion, as before.
    if (relative.split(path.sep).includes("__tests__")) continue;
    if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(relative)) continue;
    if (ALLOWED_READERS.has(relative)) continue;
    if (fs.readFileSync(file, "utf8").includes(SCOPE_ENV)) {
      violations.push(relative);
    }
  }
  return violations.sort();
}

describe("VOCATRYA_AB_ROLLOUT_SCOPE parser", () => {
  it.each([
    [undefined, AB_ROLLOUT_SCOPE.none],
    ["", AB_ROLLOUT_SCOPE.none],
    [" ", AB_ROLLOUT_SCOPE.none],
    ["  ", AB_ROLLOUT_SCOPE.none],
    ["resume", AB_ROLLOUT_SCOPE.none],
    ["FULL", AB_ROLLOUT_SCOPE.none],
    ["banana", AB_ROLLOUT_SCOPE.none],
    ["true", AB_ROLLOUT_SCOPE.none],
    ["none", AB_ROLLOUT_SCOPE.none],
    ["resume_v1", AB_ROLLOUT_SCOPE.resume_v1],
    ["full", AB_ROLLOUT_SCOPE.full],
    ["  resume_v1  ", AB_ROLLOUT_SCOPE.resume_v1],
    ["  full  ", AB_ROLLOUT_SCOPE.full],
  ])("maps %j to %s", (raw, expected) => {
    const env = { ...process.env };
    if (raw === undefined) delete env[AB_ROLLOUT_SCOPE_ENV];
    else env[AB_ROLLOUT_SCOPE_ENV] = raw;
    expect(resolveAbRolloutScope(env)).toBe(expected);
  });
});

describe("direct env read sites", () => {
  it("flags no unapproved reader in the committed tree", () => {
    // Gitignored docs, untracked artifacts, and nested worktrees can never
    // affect this assertion.
    expect(violatingReaders(REPO)).toEqual([]);
  });

  it("scans only git-tracked files and still detects violations", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-scan-"));
    try {
      const git = (...args: string[]) =>
        execFileSync("git", args, { cwd: root, stdio: "ignore" });
      git("init", "-q");
      fs.writeFileSync(
        path.join(root, ".gitignore"),
        "ignored/\n.worktrees/\n",
      );
      fs.writeFileSync(path.join(root, "kept.ts"), "export const ok = true;\n");
      fs.writeFileSync(
        path.join(root, "violating.ts"),
        `const env = "${SCOPE_ENV}";\n`,
      );
      fs.mkdirSync(path.join(root, "ignored"), { recursive: true });
      fs.mkdirSync(path.join(root, ".worktrees", "other"), {
        recursive: true,
      });
      fs.writeFileSync(path.join(root, "ignored", "leak.md"), SCOPE_ENV);
      fs.writeFileSync(
        path.join(root, ".worktrees", "other", "leak.ts"),
        SCOPE_ENV,
      );
      fs.writeFileSync(path.join(root, "untracked.ts"), SCOPE_ENV);
      git("add", ".gitignore", "kept.ts", "violating.ts");

      expect(
        scanCandidates(root).map((file) => path.relative(root, file)),
      ).toEqual(["kept.ts", "violating.ts"]);
      expect(violatingReaders(root)).toEqual(["violating.ts"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

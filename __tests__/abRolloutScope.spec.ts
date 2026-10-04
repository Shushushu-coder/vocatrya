import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AB_ROLLOUT_SCOPE,
  resolveAbRolloutScope,
} from "@/lib/career/capabilities";
import { AB_ROLLOUT_SCOPE_ENV } from "@/lib/career/identities";

const REPO = path.resolve(__dirname, "..");

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  ".codex-tmp",
  ".worktrees",
  "dist",
  "build",
  "out",
  "coverage",
  // Transpiled copy of the allowed career modules. It is not a new reader.
  "fresh-native-runtime",
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx|js|mjs|yml|yaml|example|md)$/.test(entry.name) || entry.name === ".env.example") {
      acc.push(full);
    }
  }
  return acc;
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
  it("only central config, compose, env example, and tests read the scope env", () => {
    const allowed = new Set([
      path.join(REPO, "src/lib/career/capabilities.ts"),
      path.join(REPO, "src/lib/career/rolloutScope.ts"),
      path.join(REPO, "src/lib/career/identities.ts"),
      path.join(REPO, "docker-compose.yml"),
      path.join(REPO, "docker-entrypoint.sh"),
      path.join(REPO, ".env.example"),
      // Windows Desktop Shell POC forces the disposable backend scope to
      // fail-closed "none" for isolation. It never reads the scope to enable
      // product capabilities; see WINDOWS_DESKTOP_SHELL_POC audit.
      path.join(REPO, "desktop", "main", "runtime.js"),
    ]);
    const violations: string[] = [];
    for (const file of walk(REPO)) {
      if (file.includes(`${path.sep}__tests__${path.sep}`)) continue;
      if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(file)) continue;
      if (allowed.has(file)) continue;
      const content = fs.readFileSync(file, "utf8");
      if (content.includes("VOCATRYA_AB_ROLLOUT_SCOPE")) {
        violations.push(path.relative(REPO, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("scans the current source tree and skips independent worktrees", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "scope-scan-"));
    fs.mkdirSync(path.join(root, ".worktrees", "other"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".worktrees", "other", "leak.ts"),
      "VOCATRYA_AB_ROLLOUT_SCOPE",
    );
    fs.writeFileSync(path.join(root, "kept.ts"), "export const ok = true;\n");
    try {
      const files = walk(root);
      expect(files.some((file) => file.includes(`${path.sep}.worktrees${path.sep}`))).toBe(false);
      expect(files.some((file) => file.endsWith("kept.ts"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

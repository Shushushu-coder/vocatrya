// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { getBinaryTargetForCurrentPlatform } from "@prisma/get-platform";
import { makeTestDbUrl } from "./helpers/backupTestDb";

const REPO_ROOT = path.resolve(__dirname, "..");

describe("disposable migration database", () => {
  it("creates distinct empty files before a migration child starts", () => {
    const first = makeTestDbUrl();
    const second = makeTestDbUrl();
    try {
      expect(first.dir).not.toBe(second.dir);
      for (const ctx of [first, second]) {
        const file = ctx.url.slice("file:".length);
        expect(path.isAbsolute(file)).toBe(true);
        expect(fs.statSync(file).isFile()).toBe(true);
        expect(fs.statSync(file).size).toBe(0);
      }
    } finally {
      for (const ctx of [first, second]) {
        fs.rmSync(ctx.dir, { recursive: true, force: true });
      }
    }
  });

  it("lets the schema engine connect with warning-level logging before migrations", async () => {
    const ctx = makeTestDbUrl();
    try {
      const target = await getBinaryTargetForCurrentPlatform();
      const engine = `schema-engine-${target}${process.platform === "win32" ? ".exe" : ""}`;
      const result = spawnSync(
        path.join(REPO_ROOT, "node_modules/@prisma/engines", engine),
        ["cli", "--datasource", ctx.url, "can-connect-to-database"],
        {
          cwd: REPO_ROOT,
          env: { ...process.env, DATABASE_URL: ctx.url, RUST_LOG: "warn" },
          encoding: "utf8",
        },
      );
      if (result.error || result.status !== 0) {
        throw new Error(
          `Schema engine probe exit ${result.status}: ${result.error?.message ?? ""}\n${result.stdout}\n${result.stderr}`,
        );
      }
      expect(result.status).toBe(0);
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
});

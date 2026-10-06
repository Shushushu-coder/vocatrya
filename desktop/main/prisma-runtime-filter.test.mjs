import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isExcludedPrismaRuntimeArtifact, scanExcludedPrismaRuntimeArtifacts } from "../scripts/prisma-runtime-filter.cjs";
import { assemblePrismaRuntime } from "../scripts/assemble.mjs";

describe("Prisma packaging filter (node_modules-relative paths)", () => {
  it.each([
    "@prisma/engines/node_modules/.cache",
    "@prisma/engines/node_modules/.cache/master/future-hash/windows/engine.gz",
    "effect/dist/cjs/Effect.js.map",
    "other/nested/source.js.map",
    "effect/src", "effect/src/Effect.ts",
    "effect/dist/dts", "effect/dist/dts/Effect.d.ts",
    "effect\\dist\\dts\\Effect.d.ts.map",
  ])("excludes %s", (entry) => expect(isExcludedPrismaRuntimeArtifact(entry)).toBe(true));

  it.each([
    "@prisma/engines/schema-engine-windows.exe",
    "@prisma/engines/query_engine-windows.dll.node",
    "prisma/query_engine-windows.dll.node",
    "prisma/build/index.js", "prisma/package.json", "prisma/LICENSE",
    "effect/package.json", "effect/LICENSE", "effect/dist/cjs/Effect.js",
    "effect/dist/esm/Effect.js", "effect/src-extra/index.js",
    "effect/dist/dts-extra/index.js", "other/src/index.ts",
    "other/node_modules/.cache/keep.js",
    "prisma/prisma-client/index.js", "prisma/build/query_engine_bg.sqlite.wasm",
  ])("retains %s", (entry) => expect(isExcludedPrismaRuntimeArtifact(entry)).toBe(false));

  it("guards only migration dependencies, including directory reintroductions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voc-filter-"));
    try {
      for (const entry of ["backend/server.js.map", "prisma-runtime/schema.prisma.map", "prisma-runtime/node_modules/effect/dist/cjs/Effect.js.map", "prisma-runtime/node_modules/@prisma/engines/node_modules/.cache", "prisma-runtime/node_modules/effect/src", "prisma-runtime/node_modules/effect/dist/dts"]) {
        fs.mkdirSync(path.join(root, path.dirname(entry)), { recursive: true });
        if (entry.endsWith(".map")) fs.writeFileSync(path.join(root, entry), "map");
        else fs.mkdirSync(path.join(root, entry));
      }
      expect(scanExcludedPrismaRuntimeArtifacts(path.join(root, "prisma-runtime"))).toHaveLength(4);
      expect(scanExcludedPrismaRuntimeArtifacts(path.join(root, "backend"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("applies the policy at recursive package copy boundaries and preserves required payload", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voc-filter-assemble-"));
    const retained = [
      "prisma/build/index.js", "prisma/query_engine-windows.dll.node",
      "@prisma/engines/schema-engine-windows.exe", "@prisma/engines/query_engine-windows.dll.node",
      "effect/dist/cjs/index.js", "effect/dist/esm/index.js", "effect/LICENSE",
    ];
    const excluded = ["@prisma/engines/node_modules/.cache/new-hash/engine", "effect/src/index.ts", "effect/dist/dts/index.d.ts", "effect/dist/cjs/index.js.map"];
    function write(relative, text = "fixture") {
      const absolute = path.join(root, relative);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, text);
    }
    try {
      for (const name of ["prisma", "@prisma/config", "@prisma/debug", "@prisma/engines", "@prisma/engines-version", "@prisma/fetch-engine", "@prisma/get-platform", "effect"]) {
        write(`node_modules/${name}/package.json`, JSON.stringify({ version: "6.19.0", dependencies: name === "prisma" ? { effect: "3" } : {} }));
      }
      for (const entry of [...retained, ...excluded]) write(`node_modules/${entry}`);
      write("prisma/schema.prisma");
      write("prisma/migrations/20260101000000_fixture/migration.sql");
      write("desktop/main/db-tool.cjs");
      const backend = path.join(root, "output", "backend");
      const inventory = assemblePrismaRuntime({ repoRoot: root, backendRoot: backend });
      const modules = path.join(backend, "prisma-runtime", "node_modules");
      for (const entry of retained) expect(fs.existsSync(path.join(modules, entry)), entry).toBe(true);
      for (const entry of excluded) expect(fs.existsSync(path.join(modules, entry)), entry).toBe(false);
      expect(fs.existsSync(path.join(modules, "effect", "package.json"))).toBe(true);
      expect(inventory.migrationCount).toBe(1);
      expect(scanExcludedPrismaRuntimeArtifacts(path.join(backend, "prisma-runtime"))).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

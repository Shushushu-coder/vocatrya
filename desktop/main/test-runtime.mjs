import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanExcludedPrismaRuntimeArtifacts } from "../scripts/prisma-runtime-filter.cjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

export function repoRoot() {
  return REPO_ROOT;
}

export function assembledBackendRoot() {
  if (process.env.VOCATRYA_PACKAGED_TEST_APP_DIR) {
    return path.resolve(process.env.VOCATRYA_PACKAGED_TEST_APP_DIR, "resources", "backend");
  }
  return path.join(REPO_ROOT, ".codex-tmp", "desktop-poc", "backend");
}

export function repoMigrationNames() {
  return fs
    .readdirSync(path.join(REPO_ROOT, "prisma", "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function repoPrismaVersion() {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "node_modules", "prisma", "package.json"), "utf8")).version;
}

// Ensures the POC backend carries a complete offline migration runtime and
// returns its paths. Reuses the assembled tree when its inventory fingerprint
// (Prisma version + migration history) still matches the repo.
export async function ensureAssembledRuntime() {
  const backendRoot = assembledBackendRoot();
  const inventoryPath = path.join(backendRoot, "prisma-runtime", "inventory.json");
  const expectedNames = repoMigrationNames();
  const expectedVersion = repoPrismaVersion();
  let fresh = false;
  try {
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
    fresh =
      inventory.prismaVersion === expectedVersion &&
      JSON.stringify(inventory.migrationNames) === JSON.stringify(expectedNames) &&
      scanExcludedPrismaRuntimeArtifacts(path.join(backendRoot, "prisma-runtime")).length === 0 &&
      fs.existsSync(path.join(backendRoot, "db-tool.cjs"));
  } catch {
    fresh = false;
  }
  if (!fresh) {
    if (process.env.VOCATRYA_PACKAGED_TEST_APP_DIR) {
      throw new Error("Packaged test runtime is stale or contains excluded Prisma artifacts; rebuild it first");
    }
    const { assemblePrismaRuntime } = await import("../scripts/assemble.mjs");
    assemblePrismaRuntime({ repoRoot: REPO_ROOT, backendRoot });
  }
  const { resolveMigrationRuntime } = await import("./database-migration.js");
  const runtime = resolveMigrationRuntime({ backendRoot });
  return { backendRoot, runtime };
}

export function nodeExecutable() {
  if (process.env.VOCATRYA_PACKAGED_TEST_APP_DIR) {
    return path.resolve(process.env.VOCATRYA_PACKAGED_TEST_APP_DIR, "resources", "runtime", "win32-x64", "node.exe");
  }
  return process.execPath;
}

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { buildFreshNativeBootstrap } from "../../scripts/build-fresh-native-bootstrap.mjs";
import { scanManagedSecrets } from "./scan-managed-secrets.mjs";

const require = createRequire(import.meta.url);
const { findMissingPrismaRuntimeArtifacts, isForbiddenArtifact, scanForbiddenArtifacts } = require("../main/artifacts.js");
const { isExcludedPrismaRuntimeArtifact, scanExcludedPrismaRuntimeArtifacts } = require("./prisma-runtime-filter.cjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const DEFAULT_OUTPUT_ROOT = path.join(repoRoot, ".codex-tmp", "desktop-poc");
const backendRoot = path.join(DEFAULT_OUTPUT_ROOT, "backend");

export function copyFiltered(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required build path is missing: ${source}`);
  fs.cpSync(source, destination, {
    recursive: true,
    // Standalone dependencies may be directory links. Traverse them now so
    // filtering covers descendants before electron-builder dereferences them.
    dereference: true,
    filter: (entry) => !isForbiddenArtifact(entry),
  });
}

// Offline migration runtime: everything `prisma migrate deploy` needs,
// mirrored under <backend>/prisma-runtime with a node_modules layout so the
// bundled CLI resolves @prisma/* exactly like the installed tree. No npx,
// npm, downloads, or Docker are involved at desktop startup.
const PRISMA_PACKAGES = ["prisma", "@prisma/config", "@prisma/debug", "@prisma/engines", "@prisma/engines-version", "@prisma/fetch-engine", "@prisma/get-platform"];

function copyPrismaPackage(repoRootDir, targetModulesDir, packageName) {
  const source = path.join(repoRootDir, "node_modules", ...packageName.split("/"));
  if (!fs.existsSync(source)) throw new Error(`Required Prisma runtime package is missing: ${source}`);
  const destination = path.join(targetModulesDir, ...packageName.split("/"));
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) =>
      !isForbiddenArtifact(entry) &&
      !path.basename(entry).includes(".tmp") &&
      !isExcludedPrismaRuntimeArtifact(path.join(packageName, path.relative(source, entry))),
  });
}

function readPackageDependencies(repoRootDir, packageName) {
  const packageJsonPath = path.join(repoRootDir, "node_modules", ...packageName.split("/"), "package.json");
  if (!fs.existsSync(packageJsonPath)) return [];
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    return Object.keys(pkg.dependencies || {});
  } catch {
    return [];
  }
}

function copyPrismaPackageTree(repoRootDir, targetModulesDir, packageName, seen = new Set()) {
  if (seen.has(packageName)) return;
  const source = path.join(repoRootDir, "node_modules", ...packageName.split("/"));
  if (!fs.existsSync(source)) return;
  seen.add(packageName);
  copyPrismaPackage(repoRootDir, targetModulesDir, packageName);
  for (const dep of readPackageDependencies(repoRootDir, packageName)) {
    copyPrismaPackageTree(repoRootDir, targetModulesDir, dep, seen);
  }
}

export function assemblePrismaRuntime({ repoRoot: root = repoRoot, backendRoot: backend = backendRoot } = {}) {
  const runtimeDir = path.join(backend, "prisma-runtime");
  const targetModulesDir = path.join(runtimeDir, "node_modules");
  fs.rmSync(runtimeDir, { recursive: true, force: true });
  fs.mkdirSync(targetModulesDir, { recursive: true });

  const schemaSource = path.join(root, "prisma", "schema.prisma");
  if (!fs.existsSync(schemaSource)) throw new Error(`Required Prisma schema is missing: ${schemaSource}`);
  fs.copyFileSync(schemaSource, path.join(runtimeDir, "schema.prisma"));

  const migrationsSource = path.join(root, "prisma", "migrations");
  if (!fs.existsSync(migrationsSource)) throw new Error(`Required Prisma migrations are missing: ${migrationsSource}`);
  fs.cpSync(migrationsSource, path.join(runtimeDir, "migrations"), {
    recursive: true,
    filter: (entry) => !isForbiddenArtifact(entry),
  });

  const copied = new Set();
  for (const packageName of PRISMA_PACKAGES) {
    copyPrismaPackageTree(root, targetModulesDir, packageName, copied);
  }

  const dbToolSource = path.join(root, "desktop", "main", "db-tool.cjs");
  if (!fs.existsSync(dbToolSource)) throw new Error(`Required SQLite helper is missing: ${dbToolSource}`);
  fs.copyFileSync(dbToolSource, path.join(backend, "db-tool.cjs"));

  const missing = findMissingPrismaRuntimeArtifacts(backend, { platform: "win32" });
  if (missing.length > 0) {
    throw new Error(`Assembled migration runtime is incomplete:\n${missing.join("\n")}`);
  }
  const forbidden = scanForbiddenArtifacts(runtimeDir);
  forbidden.push(...scanExcludedPrismaRuntimeArtifacts(runtimeDir));
  if (!fs.existsSync(path.join(backend, "db-tool.cjs"))) {
    throw new Error("Assembled SQLite helper is missing: db-tool.cjs");
  }
  if (forbidden.length > 0) {
    throw new Error(`Forbidden artifacts found in migration runtime:\n${forbidden.join("\n")}`);
  }

  const prismaVersion = require(path.join(root, "node_modules", "prisma", "package.json")).version;
  const migrationNames = fs
    .readdirSync(path.join(runtimeDir, "migrations"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const inventory = {
    generatedAt: new Date().toISOString(),
    prismaVersion,
    cliEntry: path.join("prisma-runtime", "node_modules", "prisma", "build", "index.js"),
    schemaEngine: path.join("prisma-runtime", "node_modules", "@prisma", "engines", "schema-engine-windows.exe"),
    schema: path.join("prisma-runtime", "schema.prisma"),
    migrations: path.join("prisma-runtime", "migrations"),
    migrationCount: migrationNames.length,
    migrationNames,
  };
  fs.writeFileSync(path.join(runtimeDir, "inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return inventory;
}

export function assembleDesktopBackend({
  repoRoot: root = repoRoot,
  outputRoot: output = DEFAULT_OUTPUT_ROOT,
  standaloneRoot: standalone = path.join(root, ".next", "standalone"),
} = {}) {
  const assembledBackendRoot = path.join(output, "backend");
  const assembledPackagedBackendRoot = path.join(output, "resources", "backend");
  fs.rmSync(assembledBackendRoot, { recursive: true, force: true });
  fs.rmSync(assembledPackagedBackendRoot, { recursive: true, force: true });
  fs.mkdirSync(output, { recursive: true });
  const excludedSourceArtifacts = scanForbiddenArtifacts(standalone).map((entry) => path.relative(standalone, entry));
  copyFiltered(standalone, assembledBackendRoot);
  copyFiltered(path.join(root, "public"), path.join(assembledBackendRoot, "public"));
  copyFiltered(path.join(root, ".next", "static"), path.join(assembledBackendRoot, ".next", "static"));
  const prismaRuntime = assemblePrismaRuntime({ repoRoot: root, backendRoot: assembledBackendRoot });
  const freshNativeBootstrap = buildFreshNativeBootstrap({
    repoRoot: root,
    outDir: path.join(assembledBackendRoot, "fresh-native-runtime"),
  });
  fs.cpSync(assembledBackendRoot, assembledPackagedBackendRoot, { recursive: true });
  for (const artifactRoot of [assembledBackendRoot, assembledPackagedBackendRoot]) {
    const failures = scanManagedSecrets(artifactRoot);
    if (failures.length) throw new Error(`Hosted secret isolation failed: ${failures.join(", ")}`);
  }

  function requireAssembled(relativePath) {
    const absolute = path.join(assembledBackendRoot, relativePath);
    if (!fs.existsSync(absolute)) throw new Error(`POC assembly missing ${relativePath}`);
    return absolute;
  }

  const serverPath = requireAssembled("server.js");
  requireAssembled(path.join("fresh-native-runtime", "ensure-fresh-native.cjs"));
  const prismaEngine = requireAssembled("node_modules/.prisma/client/query_engine-windows.dll.node");
  const sharpRuntime = requireAssembled("node_modules/@img/sharp-win32-x64/index.cjs");
  const forbidden = scanForbiddenArtifacts(assembledBackendRoot);
  forbidden.push(...scanForbiddenArtifacts(assembledPackagedBackendRoot));
  if (forbidden.length > 0) {
    throw new Error(`Forbidden artifacts found in desktop bundle:\n${forbidden.join("\n")}`);
  }

  const inventory = {
    generatedAt: new Date().toISOString(),
    serverPath,
    publicAssets: fs.existsSync(path.join(assembledBackendRoot, "public")),
    nextStaticAssets: fs.existsSync(path.join(assembledBackendRoot, ".next", "static")),
    prismaQueryEngine: prismaEngine,
    sharpWindowsRuntime: sharpRuntime,
    prismaRuntime,
    freshNativeBootstrap: freshNativeBootstrap.entryPath,
    packagedBackendRoot: assembledPackagedBackendRoot,
    excludedSourceArtifacts,
    forbiddenArtifacts: [],
  };
  fs.writeFileSync(path.join(output, "bundle-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return inventory;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  console.log(JSON.stringify(assembleDesktopBackend(), null, 2));
}

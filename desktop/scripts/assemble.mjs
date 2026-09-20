import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { findMissingPrismaRuntimeArtifacts, isForbiddenArtifact, scanForbiddenArtifacts } = require("../main/artifacts.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const standaloneRoot = path.join(repoRoot, ".next", "standalone");
const outputRoot = path.join(repoRoot, ".codex-tmp", "desktop-poc");
const backendRoot = path.join(outputRoot, "backend");
const packagedBackendRoot = path.join(outputRoot, "resources", "backend");

function copyFiltered(source, destination) {
  if (!fs.existsSync(source)) throw new Error(`Required build path is missing: ${source}`);
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => !isForbiddenArtifact(entry),
  });
}

function required(relativePath) {
  const absolute = path.join(backendRoot, relativePath);
  if (!fs.existsSync(absolute)) throw new Error(`POC assembly missing ${relativePath}`);
  return absolute;
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
    filter: (entry) => !isForbiddenArtifact(entry) && !path.basename(entry).includes(".tmp"),
  });
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

  for (const packageName of PRISMA_PACKAGES) {
    copyPrismaPackage(root, targetModulesDir, packageName);
  }

  const dbToolSource = path.join(root, "desktop", "main", "db-tool.cjs");
  if (!fs.existsSync(dbToolSource)) throw new Error(`Required SQLite helper is missing: ${dbToolSource}`);
  fs.copyFileSync(dbToolSource, path.join(backend, "db-tool.cjs"));

  const missing = findMissingPrismaRuntimeArtifacts(backend, { platform: "win32" });
  if (missing.length > 0) {
    throw new Error(`Assembled migration runtime is incomplete:\n${missing.join("\n")}`);
  }
  const forbidden = scanForbiddenArtifacts(runtimeDir);
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

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  fs.rmSync(backendRoot, { recursive: true, force: true });
  fs.rmSync(packagedBackendRoot, { recursive: true, force: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  const excludedSourceArtifacts = scanForbiddenArtifacts(standaloneRoot).map((entry) => path.relative(standaloneRoot, entry));
  copyFiltered(standaloneRoot, backendRoot);
  copyFiltered(path.join(repoRoot, "public"), path.join(backendRoot, "public"));
  copyFiltered(path.join(repoRoot, ".next", "static"), path.join(backendRoot, ".next", "static"));
  const prismaRuntime = assemblePrismaRuntime({ repoRoot, backendRoot });
  fs.cpSync(backendRoot, packagedBackendRoot, { recursive: true });

  const serverPath = required("server.js");
  const prismaEngine = required("node_modules/.prisma/client/query_engine-windows.dll.node");
  const sharpRuntime = required("node_modules/@img/sharp-win32-x64/index.cjs");
  const forbidden = scanForbiddenArtifacts(backendRoot);
  forbidden.push(...scanForbiddenArtifacts(packagedBackendRoot));
  if (forbidden.length > 0) {
    throw new Error(`Forbidden artifacts found in desktop bundle:\n${forbidden.join("\n")}`);
  }

  const inventory = {
    generatedAt: new Date().toISOString(),
    serverPath,
    publicAssets: fs.existsSync(path.join(backendRoot, "public")),
    nextStaticAssets: fs.existsSync(path.join(backendRoot, ".next", "static")),
    prismaQueryEngine: prismaEngine,
    sharpWindowsRuntime: sharpRuntime,
    prismaRuntime,
    packagedBackendRoot,
    excludedSourceArtifacts,
    forbiddenArtifacts: [],
  };
  fs.writeFileSync(path.join(outputRoot, "bundle-inventory.json"), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(inventory, null, 2));
}

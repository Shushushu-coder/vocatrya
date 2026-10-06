import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { sha256FileSync } from "./node-runtime.mjs";

const require = createRequire(import.meta.url);
const {
  findMissingPackagedResources,
  findMissingPrismaRuntimeArtifacts,
  scanInstallerForbiddenArtifacts,
} = require("../main/artifacts.js");
const identity = require("../main/installer-identity.js");
const { scanExcludedPrismaRuntimeArtifacts } = require("./prisma-runtime-filter.cjs");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const FOREIGN_BINARY = /(schema-engine-(darwin|linux|debian|rhel|freebsd)|query_engine-(darwin|linux|debian)|sharp-(linux|darwin|wasm|arm)|libvips.*(?:linux|darwin)|node\.exe)/i;

function walkFiles(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute));
    else files.push(absolute);
  }
  return files;
}

function scanForeignPlatformPayloads(appDir) {
  const hits = [];
  for (const filePath of walkFiles(appDir)) {
    const relative = path.relative(appDir, filePath);
    const name = path.basename(filePath);
    const lower = relative.replaceAll("\\", "/").toLowerCase();
    if (lower.endsWith("/runtime/win32-x64/node.exe")) continue;
    if (name === "node.exe" && !lower.includes("/win32-x64/")) {
      hits.push(relative);
      continue;
    }
    if (/\.(node|dll|exe|so|dylib)$/i.test(name) && FOREIGN_BINARY.test(name) && !/windows|win32-x64/i.test(name)) {
      hits.push(relative);
    }
    if (/\.(so|dylib)$/i.test(name)) hits.push(relative);
    if (/query_engine-(darwin|linux)/i.test(name)) hits.push(relative);
    if (/schema-engine-(darwin|linux|debian|rhel)/i.test(name)) hits.push(relative);
  }
  return [...new Set(hits)];
}

function asarContainsRootNodeModules(appDir) {
  const asarPath = path.join(appDir, "resources", "app.asar");
  if (!fs.existsSync(asarPath)) return false;
  try {
    const asar = require("@electron/asar");
    const entries = asar.listPackage(asarPath, { isPack: false });
    return entries.some((entry) => String(entry).replaceAll("\\", "/").includes("/node_modules/") || String(entry).replaceAll("\\", "/").endsWith("/node_modules") || String(entry).replaceAll("\\", "/") === "node_modules");
  } catch {
    return false;
  }
}

function countMigrations(appDir) {
  const dir = path.join(appDir, "resources", "backend", "prisma-runtime", "migrations");
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
}

function directorySizeBytes(root) {
  let total = 0;
  for (const filePath of walkFiles(root)) {
    try {
      total += fs.statSync(filePath).size;
    } catch {
      // Skip unreadable entries during size review.
    }
  }
  return total;
}

export function inspectInstalledLayout(appDir) {
  const missing = findMissingPackagedResources(appDir);
  const prismaMissing = findMissingPrismaRuntimeArtifacts(path.join(appDir, "resources", "backend"), {
    platform: "win32",
  });
  const forbidden = scanInstallerForbiddenArtifacts(appDir);
  forbidden.push(...scanExcludedPrismaRuntimeArtifacts(path.join(appDir, "resources", "backend", "prisma-runtime")));
  const foreign = scanForeignPlatformPayloads(appDir);
  const nodeExe = path.join(appDir, "resources", "runtime", "win32-x64", "node.exe");
  const nodeSha = fs.existsSync(nodeExe) ? sha256FileSync(nodeExe) : null;
  const exePath = path.join(appDir, "Vocatrya.exe");
  return {
    appDir,
    exePath: fs.existsSync(exePath) ? exePath : null,
    missingResources: missing,
    missingPrismaRuntime: prismaMissing,
    forbiddenArtifacts: forbidden,
    foreignPlatformBinaries: foreign,
    migrationCount: countMigrations(appDir),
    bundledNodeSha256: nodeSha,
    bundledNodeSha256Matches: nodeSha ? nodeSha.toLowerCase() === identity.NODE_EXE_SHA256.toLowerCase() : false,
    asarHasRootNodeModules: asarContainsRootNodeModules(appDir),
    installedSizeBytes: directorySizeBytes(appDir),
  };
}

export function verifyInstalledLayout(appDir) {
  const report = inspectInstalledLayout(appDir);
  const errors = [];
  if (report.missingResources.length) errors.push(`Missing resources:\n${report.missingResources.join("\n")}`);
  if (report.missingPrismaRuntime.length) {
    errors.push(`Missing Prisma runtime:\n${report.missingPrismaRuntime.join("\n")}`);
  }
  if (report.forbiddenArtifacts.length) {
    errors.push(`Forbidden artifacts:\n${report.forbiddenArtifacts.join("\n")}`);
  }
  if (report.foreignPlatformBinaries.length) {
    errors.push(`Foreign platform binaries:\n${report.foreignPlatformBinaries.join("\n")}`);
  }
  if (!report.bundledNodeSha256Matches) {
    errors.push(`Bundled node.exe SHA-256 mismatch: ${report.bundledNodeSha256}`);
  }
  if (report.asarHasRootNodeModules) {
    errors.push("app.asar unexpectedly contains repository node_modules");
  }
  if (report.migrationCount < 1) errors.push("No Prisma migrations packaged");
  if (errors.length) {
    const failure = new Error(errors.join("\n\n"));
    failure.report = report;
    throw failure;
  }
  return report;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const appDir = path.resolve(process.argv[2] || path.join(repoRoot, ".codex-tmp", "windows-installer", "dist", "win-unpacked"));
  const report = verifyInstalledLayout(appDir);
  console.log(JSON.stringify(report, null, 2));
}

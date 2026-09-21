// Canonical Windows release manifest for Vocatrya.
// Every value comes from an authoritative source: package.json, installer
// identity, git, the real installer artifact, installed packages, the actual
// prisma/migrations directories, and independent Authenticode verification.
// Manifest generation fails when the final artifact is absent; placeholder
// hashes and reused stale SHAs are never allowed.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { queryAuthenticodeSignature } from "./verify-signature.mjs";

const require = createRequire(import.meta.url);
const identity = require("../main/installer-identity.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const MANIFEST_FORMAT_VERSION = 1;

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

// Canonical migration fingerprint: sorted directory names joined with "\n"
// (UTF-8) and hashed with SHA-256. Count alone cannot accept a different set.
export function migrationNamesSha256(migrationNames) {
  const canonical = [...migrationNames].sort().join("\n");
  return crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function readMigrationFingerprint(root = repoRoot) {
  const migrationsDir = path.join(root, "prisma", "migrations");
  const names = fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return {
    migrationCount: names.length,
    migrationNames: names,
    migrationNamesSha256: migrationNamesSha256(names),
  };
}

export function readPackageVersion(root = repoRoot) {
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
}

function readInstalledPackageVersion(root, name) {
  try {
    return require(path.join(root, "node_modules", name, "package.json")).version;
  } catch {
    return "unknown";
  }
}

export function readElectronVersion(root = repoRoot) {
  return readInstalledPackageVersion(root, "electron");
}

export function readPrismaVersion(root = repoRoot) {
  return readInstalledPackageVersion(root, "prisma");
}

export function gitCommitSync(root = repoRoot) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) return "unknown";
  return String(result.stdout).trim();
}

export function installerArtifactName(version) {
  return identity.INSTALLER_ARTIFACT_PATTERN.replace("${version}", version);
}

export function defaultReleaseDir(root = repoRoot, version = readPackageVersion(root)) {
  return path.join(root, ".codex-tmp", "windows-release", version);
}

// Build a manifest object for a real installer artifact. Options:
// { repoRoot, artifactPath, gitCommit, builtAt, signature } where signature is
// a queryAuthenticodeSignature() report (queried automatically when omitted).
export function generateReleaseManifest(options = {}) {
  const root = options.repoRoot || repoRoot;
  const version = readPackageVersion(root);
  const artifactPath = path.resolve(options.artifactPath || "");
  if (!options.artifactPath || !fs.existsSync(artifactPath)) {
    const error = new Error("Release manifest requires the final installer artifact: " + artifactPath);
    error.code = "ARTIFACT_MISSING";
    throw error;
  }
  const fingerprint = readMigrationFingerprint(root);
  const signature = options.signature || queryAuthenticodeSignature(artifactPath);
  const stat = fs.statSync(artifactPath);
  return {
    formatVersion: MANIFEST_FORMAT_VERSION,
    product: {
      name: identity.PRODUCT_NAME,
      appId: identity.DESKTOP_APP_ID,
      version,
      architecture: identity.TARGET_ARCH,
      installerTarget: identity.INSTALLER_TARGET,
    },
    source: {
      gitCommit: options.gitCommit || gitCommitSync(root),
    },
    artifact: {
      filename: path.basename(artifactPath),
      sizeBytes: stat.size,
      sha256: sha256File(artifactPath),
    },
    runtime: {
      nodeVersion: identity.NODE_VERSION,
      nodeExeSha256: identity.NODE_EXE_SHA256,
      electronVersion: readElectronVersion(root),
      prismaVersion: readPrismaVersion(root),
      migrationCount: fingerprint.migrationCount,
      migrationNamesSha256: fingerprint.migrationNamesSha256,
    },
    signature: {
      status: signature.rawStatusName || signature.normalizedStatus || "Unknown",
      signed: Boolean(signature.signed),
      signerSubject: signature.signerSubject || null,
      thumbprint: signature.signerThumbprint || null,
      timestampStatus: signature.timestampSubject || null,
    },
    build: {
      builtAt: options.builtAt || new Date().toISOString(),
    },
  };
}

export function writeReleaseOutputs(manifest, options = {}) {
  const root = options.repoRoot || repoRoot;
  const outDir = path.resolve(options.outDir || defaultReleaseDir(root, manifest.product.version));
  fs.mkdirSync(outDir, { recursive: true });
  const manifestPath = path.join(outDir, "release-manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const sumsPath = path.join(outDir, "SHA256SUMS.txt");
  fs.writeFileSync(sumsPath, manifest.artifact.sha256 + "  " + manifest.artifact.filename + "\n", "utf8");
  return { outDir, manifestPath, sumsPath };
}

function parseCliArgs(argv) {
  const args = { artifact: null, outDir: null, commit: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--artifact") args.artifact = argv[i + 1];
    if (argv[i] === "--out") args.outDir = argv[i + 1];
    if (argv[i] === "--commit") args.commit = argv[i + 1];
  }
  return args;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const args = parseCliArgs(process.argv.slice(2));
  const version = readPackageVersion();
  const artifactPath =
    args.artifact || path.join(repoRoot, ".codex-tmp", "windows-installer", "dist", installerArtifactName(version));
  const signature = queryAuthenticodeSignature(artifactPath);
  const manifest = generateReleaseManifest({
    repoRoot,
    artifactPath,
    signature,
    gitCommit: args.commit || undefined,
  });
  const outputs = writeReleaseOutputs(manifest, { repoRoot, outDir: args.outDir || undefined });
  const signaturePath = path.join(outputs.outDir, "signature-report.json");
  fs.writeFileSync(signaturePath, JSON.stringify(signature, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ ...outputs, signaturePath, manifest }, null, 2));
}

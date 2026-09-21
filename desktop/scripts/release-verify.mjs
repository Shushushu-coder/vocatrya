// Independent release manifest verifier: reopens a generated manifest and
// recomputes artifact size/SHA, migration fingerprint, version, commit
// provenance, and runtime versions from authoritative sources. Any mismatch
// fails. The manifest JSON itself is never edited here.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  gitCommitSync,
  readElectronVersion,
  readMigrationFingerprint,
  readPackageVersion,
  readPrismaVersion,
  sha256File,
} from "./release-manifest.mjs";

const require = createRequire(import.meta.url);
const identity = require("../main/installer-identity.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function failure(code, message) {
  return { code, message };
}

// Recompute every manifest claim from source. Options:
// { repoRoot, manifest, manifestPath, expectedCommit, artifactPath }.
export function verifyReleaseManifest(options = {}) {
  const root = options.repoRoot || repoRoot;
  const manifest = options.manifest || JSON.parse(fs.readFileSync(options.manifestPath, "utf8"));
  const failures = [];
  const checked = [];
  const expectedVersion = readPackageVersion(root);
  const expectedCommit = options.expectedCommit || gitCommitSync(root);

  if (!manifest || typeof manifest !== "object") {
    return { pass: false, failures: [failure("MANIFEST_MALFORMED", "Manifest is not an object")], checked };
  }

  const artifactPath = path.resolve(
    options.artifactPath ||
      path.join(root, ".codex-tmp", "windows-installer", "dist", manifest.artifact?.filename || "missing.exe"),
  );
  if (!fs.existsSync(artifactPath)) {
    failures.push(failure("ARTIFACT_MISSING", "Installer artifact absent: " + artifactPath));
  } else {
    const stat = fs.statSync(artifactPath);
    checked.push("artifact-size");
    if (stat.size !== manifest.artifact?.sizeBytes) {
      failures.push(
        failure("ARTIFACT_SIZE_MISMATCH", "Manifest size " + manifest.artifact?.sizeBytes + " != actual " + stat.size),
      );
    }
    checked.push("artifact-sha256");
    if (sha256File(artifactPath).toLowerCase() !== String(manifest.artifact?.sha256 || "").toLowerCase()) {
      failures.push(failure("ARTIFACT_SHA_MISMATCH", "Manifest SHA-256 != recomputed artifact hash"));
    }
  }

  checked.push("version");
  if (manifest.product?.version !== expectedVersion) {
    failures.push(
      failure("VERSION_MISMATCH", "Manifest version " + manifest.product?.version + " != package.json " + expectedVersion),
    );
  }
  checked.push("commit");
  if (manifest.source?.gitCommit !== expectedCommit) {
    failures.push(
      failure("COMMIT_MISMATCH", "Manifest commit " + manifest.source?.gitCommit + " != expected " + expectedCommit),
    );
  }

  checked.push("migrations");
  const fingerprint = readMigrationFingerprint(root);
  if (
    manifest.runtime?.migrationCount !== fingerprint.migrationCount ||
    manifest.runtime?.migrationNamesSha256 !== fingerprint.migrationNamesSha256
  ) {
    failures.push(failure("MIGRATION_MISMATCH", "Manifest migration fingerprint != repo fingerprint"));
  }

  checked.push("runtime-versions");
  if (
    manifest.runtime?.nodeVersion !== identity.NODE_VERSION ||
    String(manifest.runtime?.nodeExeSha256).toLowerCase() !== identity.NODE_EXE_SHA256.toLowerCase() ||
    manifest.runtime?.electronVersion !== readElectronVersion(root) ||
    manifest.runtime?.prismaVersion !== readPrismaVersion(root)
  ) {
    failures.push(failure("RUNTIME_MISMATCH", "Manifest runtime versions != authoritative sources"));
  }

  return { pass: failures.length === 0, failures, checked, verifiedAt: new Date().toISOString() };
}

function parseCliArgs(argv) {
  const args = { manifest: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manifest") args.manifest = argv[i + 1];
  }
  return args;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const args = parseCliArgs(process.argv.slice(2));
  const version = readPackageVersion();
  const manifestPath =
    args.manifest || path.join(repoRoot, ".codex-tmp", "windows-release", version, "release-manifest.json");
  const result = verifyReleaseManifest({ repoRoot, manifestPath });
  console.log(JSON.stringify({ manifestPath, ...result }, null, 2));
  if (!result.pass) process.exitCode = 1;
}

// Release gate for the Windows installer: stale-artifact detection, runtime
// identity checks, Authenticode policy enforcement, and tag collision guard.
// Two policies: "internal-unsigned" (unsigned dev validation may PASS while
// recording NOT_SIGNED truthfully) and "public-signed" (requires VALID
// signature plus a resolved publisher identity, so it MUST FAIL today).
// Read-only: this module never creates tags, signs, or mutates artifacts.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  gitCommitSync,
  installerArtifactName,
  readElectronVersion,
  readMigrationFingerprint,
  readPackageVersion,
  readPrismaVersion,
} from "./release-manifest.mjs";
import { normalizeSignatureStatus } from "./verify-signature.mjs";

const require = createRequire(import.meta.url);
const identity = require("../main/installer-identity.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const GATE_POLICIES = ["internal-unsigned", "public-signed"];

// The real legal publisher name is UNRESOLVED until the code-signing
// certificate Subject is confirmed. Never hardcode a personal legal name.
export const PUBLISHER_IDENTITY_RESOLVED = false;

export function lookupVersionTag(root = repoRoot, version = readPackageVersion(root)) {
  // Peel annotated tags to the commit so lightweight and annotated tags compare equally.
  const result = spawnSync("git", ["rev-parse", "--verify", "refs/tags/v" + version + "^{commit}"], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return { exists: false, commit: null };
  return { exists: true, commit: String(result.stdout).trim() };
}

function failure(code, message) {
  return { code, message };
}

// Evaluate a manifest against the repo and a policy. Options:
// { repoRoot, manifest, expectedCommit, policy, artifactPath, tagCommit }.
// Pass tagCommit explicitly (or null) in tests to avoid depending on repo tags.
export function evaluateReleaseGate(options = {}) {
  const root = options.repoRoot || repoRoot;
  const manifest = options.manifest || {};
  const policy = options.policy || "internal-unsigned";
  if (!GATE_POLICIES.includes(policy)) {
    throw new Error("Unknown release policy: " + policy);
  }
  const failures = [];
  const findings = [];
  const expectedVersion = readPackageVersion(root);
  const expectedCommit = options.expectedCommit || gitCommitSync(root);
  const expectedFingerprint = readMigrationFingerprint(root);
  const expectedFilename = installerArtifactName(expectedVersion);
  const artifactPath = path.resolve(
    options.artifactPath ||
      path.join(root, ".codex-tmp", "windows-installer", "dist", manifest.artifact?.filename || expectedFilename),
  );

  if (!fs.existsSync(artifactPath)) {
    failures.push(failure("ARTIFACT_MISSING", "Installer artifact absent: " + artifactPath));
  } else {
    findings.push("artifact present: " + path.basename(artifactPath));
  }

  const manifestVersion = manifest.product?.version;
  if (manifestVersion !== expectedVersion) {
    failures.push(
      failure("VERSION_MISMATCH", "Manifest version " + manifestVersion + " != package.json " + expectedVersion),
    );
  }
  if (manifest.artifact?.filename !== installerArtifactName(manifestVersion || expectedVersion)) {
    failures.push(
      failure("ARTIFACT_FILENAME_MISMATCH", "Unexpected artifact filename: " + manifest.artifact?.filename),
    );
  }

  if (manifest.source?.gitCommit !== expectedCommit) {
    failures.push(
      failure(
        "STALE_ARTIFACT",
        "Manifest commit " + manifest.source?.gitCommit + " != expected " + expectedCommit,
      ),
    );
  }

  const releaseNotesPath = path.join(root, "release-notes", `${expectedVersion}.md`);
  if (!fs.existsSync(releaseNotesPath)) {
    failures.push(
      failure("RELEASE_NOTES_MISSING", "Curated release notes absent: release-notes/" + expectedVersion + ".md"),
    );
  } else {
    findings.push("release notes present: release-notes/" + expectedVersion + ".md");
  }

  if (
    manifest.runtime?.migrationCount !== expectedFingerprint.migrationCount ||
    manifest.runtime?.migrationNamesSha256 !== expectedFingerprint.migrationNamesSha256
  ) {
    failures.push(
      failure(
        "MIGRATION_MISMATCH",
        "Manifest migration fingerprint (" +
          manifest.runtime?.migrationCount +
          ") != repo (" +
          expectedFingerprint.migrationCount +
          ")",
      ),
    );
  }

  if (
    manifest.runtime?.nodeVersion !== identity.NODE_VERSION ||
    String(manifest.runtime?.nodeExeSha256).toLowerCase() !== identity.NODE_EXE_SHA256.toLowerCase()
  ) {
    failures.push(failure("NODE_RUNTIME_MISMATCH", "Manifest Node runtime identity != installer identity pin"));
  }
  if (
    manifest.runtime?.electronVersion !== readElectronVersion(root) ||
    manifest.runtime?.prismaVersion !== readPrismaVersion(root)
  ) {
    failures.push(failure("RUNTIME_VERSION_MISMATCH", "Manifest Electron/Prisma versions != installed packages"));
  }

  const normalized = normalizeSignatureStatus(manifest.signature?.status);
  findings.push("signature normalized status: " + normalized);
  if (policy === "internal-unsigned") {
    if (normalized === "NOT_SIGNED") {
      findings.push("unsigned artifact accepted under internal-unsigned policy");
    } else if (normalized !== "VALID") {
      failures.push(failure("SIGNATURE_INVALID", "Internal validation found unusable signature: " + normalized));
    }
  } else {
    if (normalized !== "VALID" || !manifest.signature?.signed || !manifest.signature?.signerSubject) {
      failures.push(
        failure("ARTIFACT_NOT_SIGNED", "Public release requires a VALID Authenticode signature; found " + normalized),
      );
    }
    if (!PUBLISHER_IDENTITY_RESOLVED) {
      failures.push(
        failure("PUBLISHER_IDENTITY_UNRESOLVED", "Expected publisher identity is unresolved; public release blocked"),
      );
    }
  }

  const tag = options.tagCommit !== undefined ? { exists: options.tagCommit !== null, commit: options.tagCommit } : lookupVersionTag(root, expectedVersion);
  if (tag.exists && tag.commit !== expectedCommit) {
    const message = "Tag v" + expectedVersion + " points at " + tag.commit + ", not " + expectedCommit;
    if (policy === "public-signed") {
      failures.push(failure("VERSION_TAG_CONFLICT", message));
    } else {
      findings.push("warning VERSION_TAG_CONFLICT: " + message);
    }
  } else if (!tag.exists) {
    findings.push("no v" + expectedVersion + " tag; future version tags remain allowed");
  } else {
    findings.push("version tag matches release commit");
  }

  return {
    policy,
    pass: failures.length === 0,
    failures,
    findings,
    expectedCommit,
    expectedVersion,
    evaluatedAt: new Date().toISOString(),
  };
}

function parseCliArgs(argv) {
  const args = { manifest: null, policy: "internal-unsigned", out: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--manifest") args.manifest = argv[i + 1];
    if (argv[i] === "--policy") args.policy = argv[i + 1];
    if (argv[i] === "--out") args.out = argv[i + 1];
  }
  return args;
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  const args = parseCliArgs(process.argv.slice(2));
  const version = readPackageVersion();
  const manifestPath =
    args.manifest || path.join(repoRoot, ".codex-tmp", "windows-release", version, "release-manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const report = evaluateReleaseGate({ repoRoot, manifest, policy: args.policy });
  const outPath =
    args.out || path.join(repoRoot, ".codex-tmp", "windows-release", version, "release-gate-" + args.policy + ".json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ outPath, ...report }, null, 2));
  if (!report.pass) process.exitCode = 1;
}

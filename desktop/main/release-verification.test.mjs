import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  generateReleaseManifest,
  gitCommitSync,
  installerArtifactName,
  migrationNamesSha256,
  readMigrationFingerprint,
  readPackageVersion,
} from "../scripts/release-manifest.mjs";
import { verifyReleaseManifest } from "../scripts/release-verify.mjs";
import {
  PUBLISHER_IDENTITY_RESOLVED,
  evaluateReleaseGate,
  lookupVersionTag,
} from "../scripts/release-gate.mjs";
import {
  SIGNATURE_STATUS,
  normalizeSignatureStatus,
  queryAuthenticodeSignature,
} from "../scripts/verify-signature.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const UNSIGNED_FIXTURE = {
  rawStatusValue: 2,
  rawStatusName: "NotSigned",
  normalizedStatus: "NOT_SIGNED",
  signed: false,
  signerSubject: null,
  signerThumbprint: null,
  timestampSubject: null,
};

function makeTempArtifact(bytes = "release-fixture-bytes") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-release-"));
  const artifactPath = path.join(dir, installerArtifactName(readPackageVersion(repoRoot)));
  fs.writeFileSync(artifactPath, bytes);
  return artifactPath;
}

function makeManifest(overrides = {}) {
  const artifactPath = overrides.artifactPath || makeTempArtifact();
  const manifest = generateReleaseManifest({
    repoRoot,
    artifactPath,
    signature: { ...UNSIGNED_FIXTURE },
    gitCommit: gitCommitSync(repoRoot),
    builtAt: "2026-09-21T00:00:00.000Z",
  });
  return { manifest, artifactPath };
}

describe("migration fingerprint", () => {
  it("is stable and sorted", () => {
    const first = readMigrationFingerprint(repoRoot);
    const second = readMigrationFingerprint(repoRoot);
    expect(first.migrationCount).toBeGreaterThan(0);
    expect(first.migrationNames).toEqual([...first.migrationNames].sort());
    expect(first.migrationNamesSha256).toHaveLength(64);
    expect(second).toEqual(first);
  });

  it("does not depend on input order and changes with the set", () => {
    expect(migrationNamesSha256(["b", "a"])).toBe(migrationNamesSha256(["a", "b"]));
    expect(migrationNamesSha256(["a"])).not.toBe(migrationNamesSha256(["a", "b"]));
  });
});

describe("release manifest", () => {
  it("exposes canonical fields from authoritative sources", () => {
    const { manifest, artifactPath } = makeManifest();
    expect(manifest.formatVersion).toBe(1);
    expect(manifest.product.appId).toBe("com.vocatrya.desktop");
    expect(manifest.product.version).toBe(readPackageVersion(repoRoot));
    expect(manifest.product.architecture).toBe("x64");
    expect(manifest.product.installerTarget).toBe("nsis");
    expect(manifest.source.gitCommit).toBe(gitCommitSync(repoRoot));
    expect(manifest.artifact.sha256).toHaveLength(64);
    expect(manifest.artifact.sizeBytes).toBe(fs.statSync(artifactPath).size);
    expect(manifest.runtime.migrationCount).toBe(readMigrationFingerprint(repoRoot).migrationCount);
    expect(manifest.signature.status).toBe("NotSigned");
    expect(manifest.signature.signed).toBe(false);
  });

  it("recomputes the artifact hash instead of reusing stale data", () => {
    const first = makeTempArtifact("bytes-one");
    const second = makeTempArtifact("bytes-two");
    const one = generateReleaseManifest({ repoRoot, artifactPath: first, signature: { ...UNSIGNED_FIXTURE } });
    const two = generateReleaseManifest({ repoRoot, artifactPath: second, signature: { ...UNSIGNED_FIXTURE } });
    expect(one.artifact.sha256).not.toBe(two.artifact.sha256);
    expect(one.artifact.sha256).toBe(crypto.createHash("sha256").update("bytes-one").digest("hex"));
  });

  it("fails when the final artifact is absent", () => {
    expect(() =>
      generateReleaseManifest({
        repoRoot,
        artifactPath: path.join(os.tmpdir(), "vocatrya-no-such-artifact.exe"),
        signature: { ...UNSIGNED_FIXTURE },
      }),
    ).toThrowError(/final installer artifact/);
  });
});

describe("signature normalization", () => {
  it("normalizes unsigned output without mapping it to success", () => {
    expect(normalizeSignatureStatus("NotSigned")).toBe(SIGNATURE_STATUS.NOT_SIGNED);
    expect(normalizeSignatureStatus({ statusName: "NotSigned", statusValue: 2 })).toBe(SIGNATURE_STATUS.NOT_SIGNED);
    expect(normalizeSignatureStatus({ statusValue: 2 })).toBe(SIGNATURE_STATUS.NOT_SIGNED);
    expect(normalizeSignatureStatus("NotSigned")).not.toBe(SIGNATURE_STATUS.VALID);
  });

  it("parses valid and invalid fixtures", () => {
    expect(normalizeSignatureStatus({ statusName: "Valid", statusValue: 0 })).toBe(SIGNATURE_STATUS.VALID);
    expect(normalizeSignatureStatus("Valid")).toBe(SIGNATURE_STATUS.VALID);
    expect(normalizeSignatureStatus("HashMismatch")).toBe(SIGNATURE_STATUS.INVALID);
    expect(normalizeSignatureStatus("NotTrusted")).toBe(SIGNATURE_STATUS.INVALID);
    expect(normalizeSignatureStatus("something-unexpected")).toBe(SIGNATURE_STATUS.UNKNOWN_ERROR);
  });
});

describe("release gate policies", () => {
  it("passes internal-unsigned for a fresh unsigned manifest", () => {
    const { manifest, artifactPath } = makeManifest();
    const report = evaluateReleaseGate({
      repoRoot,
      manifest,
      policy: "internal-unsigned",
      artifactPath,
      tagCommit: gitCommitSync(repoRoot),
    });
    expect(report.pass).toBe(true);
    expect(report.failures).toEqual([]);
  });

  it("fails public-signed for unsigned artifacts with publisher unresolved", () => {
    const { manifest, artifactPath } = makeManifest();
    const report = evaluateReleaseGate({
      repoRoot,
      manifest,
      policy: "public-signed",
      artifactPath,
      tagCommit: gitCommitSync(repoRoot),
    });
    expect(report.pass).toBe(false);
    const codes = report.failures.map((entry) => entry.code);
    expect(codes).toContain("ARTIFACT_NOT_SIGNED");
    expect(codes).toContain("PUBLISHER_IDENTITY_UNRESOLVED");
    expect(PUBLISHER_IDENTITY_RESOLVED).toBe(false);
  });

  it("rejects stale commits", () => {
    const { manifest, artifactPath } = makeManifest();
    const stale = { ...manifest, source: { gitCommit: "0".repeat(40) } };
    const report = evaluateReleaseGate({ repoRoot, manifest: stale, policy: "internal-unsigned", artifactPath });
    expect(report.pass).toBe(false);
    expect(report.failures.map((entry) => entry.code)).toContain("STALE_ARTIFACT");
  });

  it("rejects stale migration fingerprints", () => {
    const { manifest, artifactPath } = makeManifest();
    const stale = { ...manifest, runtime: { ...manifest.runtime, migrationNamesSha256: "f".repeat(64) } };
    const report = evaluateReleaseGate({ repoRoot, manifest: stale, policy: "internal-unsigned", artifactPath });
    expect(report.pass).toBe(false);
    expect(report.failures.map((entry) => entry.code)).toContain("MIGRATION_MISMATCH");
  });

  it("rejects wrong versions and filenames", () => {
    const { manifest, artifactPath } = makeManifest();
    const wrongVersion = { ...manifest, product: { ...manifest.product, version: "0.0.0" } };
    const versionReport = evaluateReleaseGate({
      repoRoot,
      manifest: wrongVersion,
      policy: "internal-unsigned",
      artifactPath,
    });
    expect(versionReport.pass).toBe(false);
    expect(versionReport.failures.map((entry) => entry.code)).toContain("VERSION_MISMATCH");

    const wrongFile = { ...manifest, artifact: { ...manifest.artifact, filename: "Something-Else.exe" } };
    const fileReport = evaluateReleaseGate({
      repoRoot,
      manifest: wrongFile,
      policy: "internal-unsigned",
      artifactPath,
    });
    expect(fileReport.pass).toBe(false);
    expect(fileReport.failures.map((entry) => entry.code)).toContain("ARTIFACT_FILENAME_MISMATCH");
  });

  it("flags existing tag conflicts for public release but allows unused future tags", () => {
    const { manifest, artifactPath } = makeManifest();
    const conflictPublic = evaluateReleaseGate({
      repoRoot,
      manifest,
      policy: "public-signed",
      artifactPath,
      tagCommit: "1".repeat(40),
    });
    expect(conflictPublic.failures.map((entry) => entry.code)).toContain("VERSION_TAG_CONFLICT");

    const conflictInternal = evaluateReleaseGate({
      repoRoot,
      manifest,
      policy: "internal-unsigned",
      artifactPath,
      tagCommit: "1".repeat(40),
    });
    expect(conflictInternal.pass).toBe(true);

    const futureTag = evaluateReleaseGate({
      repoRoot,
      manifest: {
        ...manifest,
        product: { ...manifest.product, version: "1.2.0" },
        artifact: { ...manifest.artifact, filename: installerArtifactName("1.2.0") },
      },
      policy: "public-signed",
      artifactPath,
      tagCommit: null,
    });
    expect(futureTag.failures.map((entry) => entry.code)).not.toContain("VERSION_TAG_CONFLICT");
  });
});

describe("version tag lookup", () => {
  it("peels annotated tags to the tagged commit", () => {
    const tag = lookupVersionTag(repoRoot, "1.1.20");
    expect(tag.exists).toBe(true);
    expect(tag.commit).toBe("527333e60d4913f3af217c2153a8ee7bc68cf857");
  });

  it("reports unused future versions as absent", () => {
    const tag = lookupVersionTag(repoRoot, "9.9.9-no-such-version");
    expect(tag).toEqual({ exists: false, commit: null });
  });
});

describe("release manifest verification", () => {
  it("passes for a freshly generated manifest and fails on tampering", () => {
    const { manifest, artifactPath } = makeManifest();
    const expectedCommit = gitCommitSync(repoRoot);
    expect(verifyReleaseManifest({ repoRoot, manifest, artifactPath, expectedCommit }).pass).toBe(true);

    const tampered = { ...manifest, artifact: { ...manifest.artifact, sha256: "e".repeat(64) } };
    const result = verifyReleaseManifest({ repoRoot, manifest: tampered, artifactPath, expectedCommit });
    expect(result.pass).toBe(false);
    expect(result.failures.map((entry) => entry.code)).toContain("ARTIFACT_SHA_MISMATCH");
  });
});

describe("windows signature tooling", () => {
  it("reports the packaged installer as NOT_SIGNED via Authenticode", () => {
    const version = readPackageVersion(repoRoot);
    const artifactPath = path.join(
      repoRoot,
      ".codex-tmp",
      "windows-installer",
      "dist",
      installerArtifactName(version),
    );
    if (!fs.existsSync(artifactPath)) {
      throw new Error("Expected installer artifact for signature proof: " + artifactPath);
    }
    const report = queryAuthenticodeSignature(artifactPath);
    expect(report.rawStatusName).toBe("NotSigned");
    expect(report.normalizedStatus).toBe("NOT_SIGNED");
    expect(report.signed).toBe(false);
  });
});

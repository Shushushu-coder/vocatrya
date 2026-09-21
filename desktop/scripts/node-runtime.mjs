import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const identity = require("../main/installer-identity.js");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function sha256FileSync(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

export function assertSha256Sync(filePath, expected) {
  const actual = sha256FileSync(filePath);
  if (actual.toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`SHA-256 mismatch for ${filePath}: expected ${expected}, got ${actual}`);
  }
  return actual;
}

function assertNodeVersionAndArch(nodeExe) {
  const version = spawnSync(nodeExe, ["--version"], { encoding: "utf8", windowsHide: true });
  if (version.status !== 0) throw new Error(`Unable to execute Node runtime: ${nodeExe}`);
  const nodeVersion = version.stdout.trim();
  if (nodeVersion !== identity.NODE_VERSION) {
    throw new Error(`Expected pinned Node ${identity.NODE_VERSION}, received ${nodeVersion}`);
  }
  const architecture = spawnSync(nodeExe, ["-p", "process.arch"], {
    encoding: "utf8",
    windowsHide: true,
  }).stdout.trim();
  if (architecture !== "x64") throw new Error(`Expected Node x64 runtime, received ${architecture || "unknown"}`);
  return nodeVersion;
}

export function resolveNodeArchivePath({ env = process.env, root = repoRoot } = {}) {
  if (env.DESKTOP_NODE_ARCHIVE) return path.resolve(env.DESKTOP_NODE_ARCHIVE);
  return path.join(root, ".codex-tmp", identity.NODE_ARCHIVE_NAME);
}

function extractArchiveEntry(archivePath, entry, destination) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-node-extract-"));
  try {
    const extracted = spawnSync("tar", ["-xf", archivePath, "-C", tempRoot, entry], {
      windowsHide: true,
      encoding: "utf8",
    });
    if (extracted.status !== 0) {
      throw new Error(`Unable to extract ${entry} from ${archivePath}: ${extracted.stderr || extracted.stdout || extracted.status}`);
    }
    const extractedPath = path.join(tempRoot, ...entry.split("/"));
    if (!fs.existsSync(extractedPath)) {
      throw new Error(`Archive entry missing after extract: ${entry}`);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(extractedPath, destination);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function copyVerifiedNode(source, destinations) {
  for (const destination of destinations) {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
    assertSha256Sync(destination, identity.NODE_EXE_SHA256);
  }
}

export function prepareBundledNode({
  root = repoRoot,
  destinations,
  env = process.env,
  extractLicenseTo,
} = {}) {
  const destList = Array.isArray(destinations) ? destinations : destinations ? [destinations] : [];
  if (destList.length === 0) throw new Error("prepareBundledNode requires at least one destination");

  const explicitExe = env.DESKTOP_NODE_RUNTIME;
  let sourceExe;
  let archivePath = null;
  let archiveSha = null;
  if (explicitExe) {
    sourceExe = path.resolve(explicitExe);
    if (!fs.existsSync(sourceExe)) throw new Error(`Node runtime does not exist: ${sourceExe}`);
    assertSha256Sync(sourceExe, identity.NODE_EXE_SHA256);
  } else {
    archivePath = resolveNodeArchivePath({ env, root });
    if (!fs.existsSync(archivePath)) {
      throw new Error(
        `Official Node archive is missing: ${archivePath}. Place ${identity.NODE_ARCHIVE_NAME} from ${identity.NODE_ARCHIVE_URL} (SHA-256 ${identity.NODE_ARCHIVE_SHA256}) or set DESKTOP_NODE_ARCHIVE / DESKTOP_NODE_RUNTIME. App startup never downloads a runtime.`,
      );
    }
    archiveSha = assertSha256Sync(archivePath, identity.NODE_ARCHIVE_SHA256);
    const extractedExe = path.join(os.tmpdir(), `vocatrya-node-${process.pid}.exe`);
    extractArchiveEntry(archivePath, identity.NODE_ARCHIVE_ENTRY, extractedExe);
    try {
      assertSha256Sync(extractedExe, identity.NODE_EXE_SHA256);
      sourceExe = extractedExe;
      if (extractLicenseTo) {
        extractArchiveEntry(archivePath, identity.NODE_LICENSE_ENTRY, extractLicenseTo);
      }
    } finally {
      // sourceExe is copied below; extracted temp file is removed after copy.
    }
    copyVerifiedNode(sourceExe, destList);
    const nodeVersion = assertNodeVersionAndArch(destList[0]);
    fs.rmSync(extractedExe, { force: true });
    return {
      nodeVersion,
      source: archivePath,
      archiveSha256: archiveSha,
      nodeExeSha256: identity.NODE_EXE_SHA256,
      destinations: destList,
    };
  }

  copyVerifiedNode(sourceExe, destList);
  const nodeVersion = assertNodeVersionAndArch(destList[0]);
  if (extractLicenseTo) {
    const siblingLicense = path.join(path.dirname(sourceExe), "LICENSE");
    const defaultExtracted = path.join(root, ".codex-tmp", "node20", "node-v20.20.2-win-x64", "LICENSE");
    if (fs.existsSync(siblingLicense)) {
      fs.mkdirSync(path.dirname(extractLicenseTo), { recursive: true });
      fs.copyFileSync(siblingLicense, extractLicenseTo);
    } else if (fs.existsSync(defaultExtracted)) {
      fs.mkdirSync(path.dirname(extractLicenseTo), { recursive: true });
      fs.copyFileSync(defaultExtracted, extractLicenseTo);
    } else {
      archivePath = resolveNodeArchivePath({ env, root });
      if (fs.existsSync(archivePath)) {
        assertSha256Sync(archivePath, identity.NODE_ARCHIVE_SHA256);
        extractArchiveEntry(archivePath, identity.NODE_LICENSE_ENTRY, extractLicenseTo);
      }
    }
  }
  return {
    nodeVersion,
    source: sourceExe,
    archiveSha256: archiveSha,
    nodeExeSha256: identity.NODE_EXE_SHA256,
    destinations: destList,
  };
}

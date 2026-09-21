import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { assembleDesktopBackend } from "./assemble.mjs";
import { generateNotices } from "./generate-notices.mjs";
import { prepareBundledNode } from "./node-runtime.mjs";
import { verifyInstalledLayout } from "./verify-installer.mjs";
import { migrationNamesSha256 } from "./release-manifest.mjs";

const require = createRequire(import.meta.url);
const identity = require("../main/installer-identity.js");
const { scanInstallerForbiddenArtifacts: scanForbidden } = require("../main/artifacts.js");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const installerRoot = path.join(repoRoot, ".codex-tmp", "windows-installer");
const stageRoot = path.join(installerRoot, "stage");
const distRoot = path.join(installerRoot, "dist");

function parseArgs(argv) {
  return {
    dirOnly: argv.includes("--dir"),
    skipNextBuild: argv.includes("--skip-next-build"),
  };
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    windowsHide: true,
    env: options.env || process.env,
    shell: options.shell || false,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
  return result;
}

function gitCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) return "unknown";
  return result.stdout.trim();
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function installedPackageVersion(name) {
  try {
    return require(path.join(repoRoot, "node_modules", name, "package.json")).version;
  } catch {
    return "unknown";
  }
}

function packageVersion() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).version;
}

const args = parseArgs(process.argv.slice(2));
fs.rmSync(stageRoot, { recursive: true, force: true });
fs.rmSync(distRoot, { recursive: true, force: true });
fs.mkdirSync(stageRoot, { recursive: true });

if (!args.skipNextBuild) {
  run("npm", ["run", "build"], { shell: true });
}

const assembly = assembleDesktopBackend({ repoRoot, outputRoot: stageRoot });
const nodeLicensePath = path.join(stageRoot, "resources", "licenses", "NODE-LICENSE.txt");
const nodeResult = prepareBundledNode({
  root: repoRoot,
  destinations: [path.join(stageRoot, "resources", "runtime", "win32-x64", "node.exe")],
  env: process.env,
  extractLicenseTo: nodeLicensePath,
});

generateNotices({
  root: repoRoot,
  outputDir: path.join(stageRoot, "resources", "licenses"),
  nodeLicensePath,
  backendNodeModules: path.join(stageRoot, "resources", "backend", "node_modules"),
});

const version = packageVersion();
const buildInfo = {
  appVersion: version,
  buildCommit: gitCommit(),
  builtAt: new Date().toISOString(),
  desktopAppId: identity.DESKTOP_APP_ID,
  productName: identity.PRODUCT_NAME,
  nodeVersion: identity.NODE_VERSION,
  nodeExeSha256: identity.NODE_EXE_SHA256,
  electronVersion: installedPackageVersion("electron"),
  prismaVersion: installedPackageVersion("prisma"),
  architecture: identity.TARGET_ARCH,
  migrationCount: assembly.prismaRuntime.migrationCount,
  migrationNamesSha256: migrationNamesSha256(assembly.prismaRuntime.migrationNames || []),
  codeSigning: "NOT_IMPLEMENTED",
  autoUpdate: "NOT_IMPLEMENTED",
};
fs.writeFileSync(
  path.join(stageRoot, "resources", "build-info.json"),
  `${JSON.stringify(buildInfo, null, 2)}\n`,
  "utf8",
);

const stagedForbidden = scanForbidden(stageRoot);
if (stagedForbidden.length > 0) {
  throw new Error(`Forbidden artifacts in installer stage:\n${stagedForbidden.join("\n")}`);
}

const builderArgs = [
  path.join(repoRoot, "node_modules", "electron-builder", "cli.js"),
  "--config",
  "desktop/electron-builder.yml",
  "--win",
  "--x64",
  "--publish",
  "never",
];
if (args.dirOnly) builderArgs.push("--dir");

run(process.execPath, builderArgs, {
  env: {
    ...process.env,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
  },
});

const unpackedDir = path.join(distRoot, "win-unpacked");
const unpackedReport = verifyInstalledLayout(unpackedDir);
const artifactName = `Vocatrya-Setup-${version}-x64.exe`;
const artifactPath = path.join(distRoot, artifactName);
let installerSha256 = null;
if (!args.dirOnly) {
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Installer artifact missing: ${artifactPath}`);
  }
  installerSha256 = sha256File(artifactPath);
  fs.writeFileSync(path.join(distRoot, "SHA256SUMS.txt"), `${installerSha256}  ${artifactName}\n`, "utf8");
  for (const leftover of fs.readdirSync(distRoot)) {
    if (leftover.endsWith(".blockmap") || leftover === "latest.yml" || leftover === "builder-debug.yml") {
      fs.rmSync(path.join(distRoot, leftover), { force: true });
    }
  }
}

const summary = {
  version,
  buildInfo,
  assembly: {
    prismaQueryEngine: assembly.prismaQueryEngine,
    sharpWindowsRuntime: assembly.sharpWindowsRuntime,
    migrationCount: assembly.prismaRuntime.migrationCount,
  },
  node: nodeResult,
  unpacked: unpackedReport,
  installerArtifact: args.dirOnly ? null : artifactPath,
  installerSha256,
};
fs.writeFileSync(path.join(installerRoot, "package-summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));

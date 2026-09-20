import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const source = process.env.DESKTOP_NODE_RUNTIME;
const destination = path.join(repoRoot, ".codex-tmp", "desktop-poc", "runtime", "win32-x64", "node.exe");
const packagedDestination = path.join(repoRoot, ".codex-tmp", "desktop-poc", "resources", "runtime", "win32-x64", "node.exe");

if (!source) {
  throw new Error("Set DESKTOP_NODE_RUNTIME to a prepared Node 20 x64 node.exe. Runtime preparation never downloads during app startup.");
}
const sourcePath = path.resolve(source);
if (!fs.existsSync(sourcePath)) throw new Error(`Node runtime does not exist: ${sourcePath}`);
const version = spawnSync(sourcePath, ["--version"], { encoding: "utf8", windowsHide: true });
if (version.status !== 0) throw new Error(`Unable to execute Node runtime: ${sourcePath}`);
const nodeVersion = version.stdout.trim();
if (!/^v20\./.test(nodeVersion) && process.env.DESKTOP_ALLOW_NODE_VERSION_MISMATCH !== "1") {
  throw new Error(`Expected Node 20.x runtime, received ${nodeVersion}. Set DESKTOP_ALLOW_NODE_VERSION_MISMATCH=1 only for local diagnostics.`);
}
const architecture = spawnSync(sourcePath, ["-p", "process.arch"], { encoding: "utf8", windowsHide: true }).stdout.trim();
if (architecture !== "x64") throw new Error(`Expected Node x64 runtime, received ${architecture || "unknown"}`);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(sourcePath, destination);
fs.mkdirSync(path.dirname(packagedDestination), { recursive: true });
fs.copyFileSync(sourcePath, packagedDestination);
console.log(`Prepared ${destination} (${nodeVersion})`);

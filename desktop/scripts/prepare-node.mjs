import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareBundledNode } from "./node-runtime.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const destination = path.join(repoRoot, ".codex-tmp", "desktop-poc", "runtime", "win32-x64", "node.exe");
const packagedDestination = path.join(repoRoot, ".codex-tmp", "desktop-poc", "resources", "runtime", "win32-x64", "node.exe");

const result = prepareBundledNode({
  root: repoRoot,
  destinations: [destination, packagedDestination],
  env: process.env,
});
console.log(`Prepared ${destination} (${result.nodeVersion}, sha256 ${result.nodeExeSha256})`);

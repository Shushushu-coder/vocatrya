import path from "node:path";
import { fileURLToPath } from "node:url";
import { inspectInstalledLayout } from "./verify-installer.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const appDir = path.resolve(process.argv[2] || path.join(repoRoot, ".codex-tmp", "windows-installer", "dist", "win-unpacked"));
console.log(JSON.stringify(inspectInstalledLayout(appDir), null, 2));

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dataRoot = path.join(repoRoot, ".codex-tmp", "desktop-poc", "data");
const databasePath = path.join(dataRoot, "desktop-poc.db");
const schemaPath = path.join(repoRoot, "prisma", "schema.prisma");
const prismaCli = path.join(repoRoot, "node_modules", "prisma", "build", "index.js");

if (!fs.existsSync(schemaPath) || !fs.existsSync(prismaCli)) {
  throw new Error("Prisma schema or local CLI is missing; install dependencies before preparing the POC database.");
}
fs.mkdirSync(dataRoot, { recursive: true });
const result = spawnSync(process.execPath, [prismaCli, "db", "push", "--schema", schemaPath, "--skip-generate"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    DATABASE_URL: `file:${databasePath.replaceAll("\\", "/")}`,
  },
  stdio: "inherit",
  windowsHide: true,
});
if (result.status !== 0) throw new Error(`Disposable POC database preparation failed with exit code ${result.status}`);
console.log(`Prepared disposable POC database: ${databasePath}`);

// Vocatrya A+B Phase 3 CLI.
// Default command is audit (zero writes).
// Writable migrate requires --confirm-writable --allow-disposable-copy and a
// disposable temp SQLite copy that passes Phase 2 preflight.

import path from "node:path";
import { executeLegacyMigrationCommand } from "../src/lib/legacy-migration/command.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);

const result = await executeLegacyMigrationCommand({
  argv,
  repoRoot: REPO_ROOT,
});

process.stdout.write(result.stdout);
process.exitCode = result.exitCode;

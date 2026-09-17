// Vocatrya A+B Phase 7 CLI.
// Default command is eligibility check (zero writes).
// Initialization requires an explicit --confirm. --force is rejected.

import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
register(
  pathToFileURL(path.join(import.meta.dirname, "ts-alias-loader.mjs")).href,
  import.meta.url,
);

const { executeFreshInitCommand } = await import(
  "../src/lib/career/freshCommand.ts"
);

const argv = process.argv.slice(2);
const result = await executeFreshInitCommand({
  argv,
  repoRoot: REPO_ROOT,
});

process.stdout.write(result.stdout);
process.exitCode = result.exitCode;

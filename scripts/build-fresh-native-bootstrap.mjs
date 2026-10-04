// Emit a Node 20-compatible CommonJS fresh-native bootstrap.
// Desktop's bundled runtime and the Docker image are Node 20.20.2, which
// cannot strip TypeScript. The emitted files call the same source modules.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_FILES = [
  "src/lib/legacy-migration/identities.ts",
  "src/lib/career/errors.ts",
  "src/lib/career/identities.ts",
  "src/lib/career/migrationState.ts",
  "src/lib/career/freshEligibility.ts",
  "src/lib/career/freshActivation.ts",
  "src/lib/career/freshBootstrap.ts",
  "src/lib/career/freshStartup.ts",
];

const ENTRY_SOURCE = `"use strict";

// Generated entry. No arguments: the database is process.env.DATABASE_URL,
// already chosen by Desktop main or the container entrypoint.

const { ensureFreshNativeStateForActiveDatabase } = require("./lib/career/freshStartup");

function redact(message) {
  return String(message)
    .replace(/file:[^\\s)'"]+/gi, "file:[redacted]")
    .replace(/[A-Za-z]:\\\\[^\\s)'"]+/g, "[path]")
    .slice(0, 400);
}

async function main() {
  if (process.argv.slice(2).length > 0) {
    process.stdout.write("fresh-native activation: failed\\n");
    process.stderr.write("fresh-native bootstrap does not accept arguments\\n");
    return 1;
  }
  if (!String(process.env.DATABASE_URL || "").trim()) {
    process.stdout.write("fresh-native activation: failed\\n");
    process.stderr.write("fresh-native bootstrap requires the application DATABASE_URL\\n");
    return 1;
  }
  try {
    await ensureFreshNativeStateForActiveDatabase();
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "fresh activation failed";
    process.stderr.write(redact(message) + "\\n");
    return 1;
  }
}

main().then(
  (code) => {
    process.exit(code);
  },
  () => {
    process.stdout.write("fresh-native activation: failed\\n");
    process.exit(1);
  },
);
`;

export function buildFreshNativeBootstrap({
  repoRoot: root = repoRoot,
  outDir = path.join(root, "fresh-native-runtime"),
} = {}) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  for (const relativePath of SOURCE_FILES) {
    const sourcePath = path.join(root, relativePath);
    const source = fs.readFileSync(sourcePath, "utf8");
    const emitted = ts.transpileModule(source, {
      fileName: sourcePath,
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true,
        strict: false,
        sourceMap: false,
        inlineSourceMap: false,
      },
    });
    const outputPath = path.join(
      outDir,
      relativePath.replace(/^src[/\\]/, "").replace(/\.ts$/, ".js"),
    );
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, emitted.outputText, "utf8");
  }

  const entryPath = path.join(outDir, "ensure-fresh-native.cjs");
  fs.writeFileSync(entryPath, ENTRY_SOURCE, "utf8");
  return { outDir, entryPath };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const built = buildFreshNativeBootstrap();
  process.stdout.write(`${built.entryPath}\n`);
}

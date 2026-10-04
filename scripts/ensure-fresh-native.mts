// Automatic fresh-native bootstrap for a process that already resolved
// DATABASE_URL. Node 22+ can run this file directly. Node 20 (desktop
// runtime and the Docker image) runs the plain JS build emitted by
// scripts/build-fresh-native-bootstrap.mjs instead.
//
// This entry accepts no arguments. A database path is intentionally rejected
// so it cannot be pointed at an arbitrary file. The dev-only ab:init-fresh
// command keeps its own path checks.

import path from "node:path";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

function redact(message: string): string {
  return message
    .replace(/file:[^\s)'"]+/gi, "file:[redacted]")
    .replace(/[A-Za-z]:\\[^\s)'"]+/g, "[path]")
    .slice(0, 400);
}

const argv = process.argv.slice(2);
if (argv.length > 0) {
  process.stdout.write("fresh-native activation: failed\n");
  process.stderr.write("fresh-native bootstrap does not accept arguments\n");
  process.exit(1);
}

if (!process.env.DATABASE_URL?.trim()) {
  process.stdout.write("fresh-native activation: failed\n");
  process.stderr.write(
    "fresh-native bootstrap requires the application DATABASE_URL\n",
  );
  process.exit(1);
}

register(
  pathToFileURL(path.join(import.meta.dirname, "ts-alias-loader.mjs")).href,
  import.meta.url,
);

const { ensureFreshNativeStateForActiveDatabase } = await import(
  "../src/lib/career/freshStartup.ts"
);

try {
  await ensureFreshNativeStateForActiveDatabase();
  process.exit(0);
} catch (error) {
  const message = error instanceof Error ? error.message : "fresh activation failed";
  process.stderr.write(`${redact(message)}\n`);
  process.exit(1);
}

// Child launcher for the R3 Playwright web servers. Playwright merges
// webServer.env over the operator's process.env, so config env alone cannot
// stop a developer's real AUTH_SECRET/NEXTAUTH_URL/VOCATRYA_* values from
// reaching the app server. This launcher respawns the standalone production
// server with exactly the synthetic R3 environment and nothing else.
// Playwright terminates web servers with `taskkill /T`, which takes this
// child process down with the launcher, so nothing can be orphaned.
//
// Usage: node e2e/support/r3ServerLauncher.mjs <port> <databaseUrl> [KEY=VALUE ...]
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const [port, databaseUrl, ...pairs] = process.argv.slice(2);
if (!port || !databaseUrl) {
  console.error(
    "usage: r3ServerLauncher.mjs <port> <databaseUrl> [KEY=VALUE ...]",
  );
  process.exit(2);
}

// The entire contract for the app server — a fixed synthetic Auth.js
// environment, identical for every R3 config. NEXTAUTH_URL stays unset: with
// the host trusted, Auth.js derives the request origin itself. OS-level vars
// pass through only where Node/Win32 needs them; nothing else from the
// operator's shell survives.
const env = {
  DATABASE_URL: databaseUrl,
  AUTH_SECRET: "r3-e2e-synthetic-auth-secret",
  AUTH_TRUST_HOST: "true",
  PORT: port,
  HOSTNAME: "localhost",
};
for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT"]) {
  if (process.env[key] !== undefined) env[key] = process.env[key];
}
for (const pair of pairs) {
  const separator = pair.indexOf("=");
  if (separator <= 0) continue;
  env[pair.slice(0, separator)] = pair.slice(separator + 1);
}

const child = spawn(
  process.execPath,
  [path.join(repoRoot, ".next", "standalone", "server.js")],
  { env, stdio: "inherit" },
);
child.on("exit", (code) => process.exit(code ?? 1));

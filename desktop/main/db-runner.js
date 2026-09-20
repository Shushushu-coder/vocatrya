// Shared child-process helpers for desktop database work (migration + backup).
//
// Both the Prisma migration child and the SQLite helper child run with a
// minimal controlled environment: an explicit DATABASE_URL, an explicit
// desktop TEMP/TMP, and only the OS variables required to spawn processes.
// Developer secrets, provider API keys, and known engine contaminants
// (RUST_LOG breaks the Prisma 6.19 schema engine with an empty
// "Schema engine error:") are never inherited.
"use strict";

const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");

const SECRET_ENV_KEYS = [
  "AUTH_SECRET",
  "ENCRYPTION_KEY",
  "OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
];

// Environment keys that are known to corrupt the Prisma schema engine or
// leak diagnostics into its JSON-RPC stream. RUST_LOG=warn deterministically
// turns `prisma migrate deploy` into `Error: Schema engine error:` with no
// detail (reproduced by bisection on Windows).
const SCRUBBED_ENGINE_KEYS = ["RUST_LOG", "RUST_BACKTRACE"];

// Minimal OS surface needed to spawn Node/Prisma on Windows.
const PRESERVED_OS_KEYS = ["PATH", "Path", "SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATHEXT", "OS"];

function buildControlledEnv({ databaseUrl, tmpDir, baseEnv = process.env, extra = {} }) {
  if (!databaseUrl) throw new Error("databaseUrl is required");
  if (!tmpDir) throw new Error("tmpDir is required");
  const env = {};
  for (const key of PRESERVED_OS_KEYS) {
    if (baseEnv[key]) env[key] = baseEnv[key];
  }
  env.DATABASE_URL = databaseUrl;
  env.TEMP = tmpDir;
  env.TMP = tmpDir;
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) continue;
    env[key] = value;
  }
  // Defensive: never allow secrets or engine contaminants back in, even if a
  // caller passes them via extra.
  for (const key of [...SECRET_ENV_KEYS, ...SCRUBBED_ENGINE_KEYS]) {
    if (key === "DATABASE_URL") continue;
    delete env[key];
  }
  return env;
}

function sanitizeChildOutput(text) {
  return String(text).replace(
    /(AUTH_SECRET|ENCRYPTION_KEY|OPENAI_API_KEY|DEEPSEEK_API_KEY|GEMINI_API_KEY|OPENROUTER_API_KEY)\s*=\s*("[^"]*"|'[^']*'|\S+)/gi,
    "$1=[redacted]",
  );
}

function runChild({ executable, args, env, cwd, timeoutMs = 120000, onChild }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, args, { cwd, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    if (onChild) {
      try {
        onChild(child);
      } catch {
        // Observer-only hook; never fail the run because of it.
      }
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // Already exited.
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 262144) stdout = stdout.slice(-262144);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 262144) stderr = stderr.slice(-262144);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        spawnError: error.message,
        stdout: sanitizeChildOutput(stdout),
        stderr: sanitizeChildOutput(stderr),
        durationMs: Date.now() - startedAt,
      });
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode: code,
        signal,
        spawnError: null,
        stdout: sanitizeChildOutput(stdout),
        stderr: sanitizeChildOutput(stderr),
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function parseDbToolJson(stdout) {
  const line = String(stdout).trim().split(/\r?\n/).pop();
  if (!line) throw new Error("db-tool produced no output");
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`db-tool produced invalid JSON: ${line.slice(0, 200)}`);
  }
  if (!parsed || parsed.ok !== true) {
    throw new Error(`db-tool reported failure: ${line.slice(0, 500)}`);
  }
  return parsed;
}

async function runDbTool({ nodeExecutable, dbToolPath, databaseUrl, tmpDir, baseEnv, command, arg, cwd, timeoutMs = 60000 }) {
  if (!nodeExecutable) throw new Error("nodeExecutable is required");
  if (!dbToolPath) throw new Error("dbToolPath is required");
  const args = [dbToolPath, command];
  if (arg !== undefined) args.push(arg);
  const result = await runChild({
    executable: nodeExecutable,
    args,
    env: buildControlledEnv({ databaseUrl, tmpDir, baseEnv }),
    cwd,
    timeoutMs,
  });
  if (result.spawnError) throw new Error(`db-tool could not start: ${result.spawnError}`);
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim().split(/\r?\n/).pop() || `exit code ${result.exitCode}`;
    throw new Error(`db-tool ${command} failed: ${detail.slice(0, 500)}`);
  }
  return parseDbToolJson(result.stdout);
}

function computeFileSha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function utcBackupTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

module.exports = {
  PRESERVED_OS_KEYS,
  SCRUBBED_ENGINE_KEYS,
  SECRET_ENV_KEYS,
  buildControlledEnv,
  computeFileSha256,
  parseDbToolJson,
  runChild,
  runDbTool,
  sanitizeChildOutput,
  utcBackupTimestamp,
};

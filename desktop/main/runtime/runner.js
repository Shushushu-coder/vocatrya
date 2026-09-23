// Phase C RuntimeCommandRunner — the only way runtime probes/invocations
// spawn child processes.
//
// Hard rules:
// - shell is ALWAYS false; args are always an array, never a command string
// - stdout/stderr are captured with a hard byte cap
// - timeout and AbortSignal both terminate the child tree
// - output sanitization redacts obvious credential material before the
//   result crosses any boundary (logs, IPC, telemetry)
const { spawn } = require("node:child_process");
const { terminateChildTree } = require("../runtime");

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CAPTURE_BYTES = 256 * 1024;

// Minimal DLP: cover the token shapes our providers actually emit. This is
// not a general secret scanner — profile credential FILES are never read at
// all, which is the real boundary.
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /gho_[A-Za-z0-9]{20,}/g,
  /ghu_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /xai-[A-Za-z0-9_-]{16,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
  /("?(?:access|refresh|id)_?token"?\s*[:=]\s*"?)[A-Za-z0-9._~+/=-]{8,}/gi,
];

function sanitizeRuntimeOutput(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix) =>
      prefix ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}

function createCappedAccumulator(limit) {
  let buf = "";
  let truncated = false;
  return {
    push(chunk) {
      if (truncated) return;
      buf += chunk;
      if (buf.length > limit) {
        buf = buf.slice(0, limit);
        truncated = true;
      }
    },
    value() {
      return buf;
    },
    truncated() {
      return truncated;
    },
  };
}

// runRuntimeCommand({ executable, args, cwd, env, timeoutMs, signal,
//   sanitize, onStdout, onStderr, maxCaptureBytes })
//   → { exitCode, signal, timedOut, aborted, stdout, stderr, error? }
// Never throws for process failure; throws only for invalid input.
// onStdout/onStderr (optional) observe raw chunks as they arrive — used by
// login flows to surface a vendor OAuth URL while the process still runs
// (some CLIs print it on stderr, e.g. `grok login`). Observers never affect
// the run; their errors are swallowed. maxCaptureBytes overrides the 256KB
// per-stream cap for commands whose contract legitimately emits larger
// payloads (e.g. `devin models list --format json` catalogs).
function runRuntimeCommand({
  executable,
  args,
  cwd,
  env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
  sanitize = true,
  onStdout,
  onStderr,
  maxCaptureBytes = MAX_CAPTURE_BYTES,
  spawnImpl = spawn,
} = {}) {
  if (typeof executable !== "string" || executable.length === 0) {
    return Promise.reject(new Error("executable is required"));
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
    return Promise.reject(new Error("args must be an array of strings"));
  }

  return new Promise((resolve) => {
    const stdout = createCappedAccumulator(maxCaptureBytes);
    const stderr = createCappedAccumulator(maxCaptureBytes);
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        exitCode: result.exitCode ?? null,
        signal: result.signal ?? null,
        timedOut,
        aborted,
        stdout: sanitize
          ? sanitizeRuntimeOutput(stdout.value())
          : stdout.value(),
        stderr: sanitize
          ? sanitizeRuntimeOutput(stderr.value())
          : stderr.value(),
        error: result.error,
      });
    };

    let child;
    try {
      child = spawnImpl(executable, args, {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      finish({ exitCode: null, error: error.message });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      void terminateChildTree(child);
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      void terminateChildTree(child);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (child.stdout)
      child.stdout.on("data", (chunk) => {
        stdout.push(chunk);
        if (typeof onStdout === "function") {
          try {
            onStdout(chunk.toString("utf8"));
          } catch {
            // An observer failure must never break the process run.
          }
        }
      });
    if (child.stderr)
      child.stderr.on("data", (chunk) => {
        stderr.push(chunk);
        if (typeof onStderr === "function") {
          try {
            onStderr(chunk.toString("utf8"));
          } catch {
            // An observer failure must never break the process run.
          }
        }
      });
    child.once("error", (error) => {
      finish({ exitCode: null, error: error.message });
    });
    child.once("close", (code, sig) => {
      finish({ exitCode: code, signal: sig });
    });
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  MAX_CAPTURE_BYTES,
  runRuntimeCommand,
  sanitizeRuntimeOutput,
};

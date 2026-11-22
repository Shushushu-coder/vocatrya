// Devin capability self-check (streaming + structured), run ONCE per
// installed build and cached by runtime-capability-cache.js.
//
// Route chosen: MINIMAL REAL CALL (not a synthetic loopback). Investigated
// 2026-11-21 on devin 3000.14.30821: `devin --help` / `devin -p --help`
// expose no API-URL / base-URL flag or env (only DEVIN_MODEL,
// DEVIN_PERMISSION_MODE, DEVIN_SANDBOX, DEVIN_VERBOSITY); `devin -p` talks
// to the Devin cloud with the account session, not an OpenAI-compatible
// Responses endpoint like Codex, so the verify-codex-native.mjs mock
// pattern cannot be applied. The registry even scrubs DEVIN_API_URL /
// DEVIN_WEBAPP_HOST as hostile ambient env. The fallback is therefore a
// single trivial `devin -p` call per new build (a one-line reply), never
// per session or request.
//
// What the one call proves:
// - streaming: the managed `devin -p` path delivered stdout through the
//   production plain-text stream parser (>=1 text-delta, a `completed`
//   event whose text reconciles with the deltas) and exited 0.
//   LIMIT: a one-line reply cannot prove incremental flushing over time;
//   that remains the dev-time scripts/runtime-streaming-probe.mts claim.
//   The runtime check guards against the failure modes an update actually
//   causes: changed flags, empty/banner-only output, non-zero exit.
// - structured: the reply is a JSON object {probe, ok:true} (PROMPT_AND_
//   VALIDATE contract: prompt carries the shape, local parse decides).
//
// Verdicts: PASS; FAIL when the CLI ran and violated the contract;
// UNVERIFIED when no conclusion is possible (timeout, spawn error, auth or
// network failure). An abort by the caller yields null (nothing cached).
const { createPlainTextStreamParser } = require("./streaming");
const { DEVIN_CAPABILITY_PROBE_TOKEN } = require("./devin");

const DEVIN_PROBE_TIMEOUT_MS = 45 * 1000;

function extractJsonObject(text) {
  const trimmed = String(text || "").trim();
  const candidates = [trimmed];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // try next candidate
    }
  }
  return null;
}

// Pure verdict function (unit-testable): chunks = stdout chunks as the
// runner delivered them.
function evaluateDevinProbe({ chunks, exitCode }) {
  const parser = createPlainTextStreamParser();
  const events = [];
  for (const chunk of chunks) events.push(...parser.push(chunk));
  events.push(...parser.finish());
  const deltas = events.filter((e) => e.type === "text-delta" && e.delta);
  const completed = events.find((e) => e.type === "completed");
  const joined = deltas.map((e) => e.delta).join("");
  const text = typeof completed?.text === "string" ? completed.text : null;
  const streamingOk =
    exitCode === 0 &&
    deltas.length > 0 &&
    text !== null &&
    text.trim() === joined.trim() &&
    joined.trim().length > 0;
  const json = extractJsonObject(joined);
  const structuredOk =
    exitCode === 0 &&
    json !== null &&
    json.probe === DEVIN_CAPABILITY_PROBE_TOKEN &&
    json.ok === true;
  return {
    streaming: streamingOk ? "PASS" : "FAIL",
    structured: structuredOk ? "PASS" : "FAIL",
  };
}

// Returns { streaming, structured } verdicts, or null when aborted.
async function runDevinCapabilityProbe({
  adapter,
  runner,
  executablePath,
  profileDir,
  baseEnv,
  workingDirectory,
  model,
  signal,
  timeoutMs = DEVIN_PROBE_TIMEOUT_MS,
}) {
  const invocation = adapter.buildCapabilityProbeInvocation({
    executablePath,
    profileDir,
    baseEnv,
    workingDirectory,
    model,
  });
  const chunks = [];
  let result;
  try {
    result = await runner({
      ...invocation,
      timeoutMs,
      signal,
      binaryStdout: true,
      onStdout: (chunk) => chunks.push(chunk),
    });
  } catch {
    return { streaming: "UNVERIFIED", structured: "UNVERIFIED" };
  }
  if (result?.aborted || signal?.aborted) return null;
  if (!result || result.timedOut || result.error) {
    return { streaming: "UNVERIFIED", structured: "UNVERIFIED" };
  }
  // A non-zero exit with no output at all is usually auth/network/model
  // trouble, not a contract change: inconclusive, never a hard FAIL.
  if (result.exitCode !== 0 && chunks.length === 0) {
    return { streaming: "UNVERIFIED", structured: "UNVERIFIED" };
  }
  return evaluateDevinProbe({ chunks, exitCode: result.exitCode });
}

module.exports = {
  DEVIN_PROBE_TIMEOUT_MS,
  evaluateDevinProbe,
  runDevinCapabilityProbe,
};

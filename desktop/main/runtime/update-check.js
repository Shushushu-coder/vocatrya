// Online latest-version checks for managed runtimes — read-only network
// probes against each registry-declared upstream source (update.check).
// Nothing here installs, updates, or writes; results are reports only and
// update execution stays disabled regardless of what upstream advertises.
//
// Source kinds (registry data, never renderer input):
//   npm-latest     → registry.npmjs.org/<pkg>/latest → {version}
//   channel-file   → a plain-text channel pointer naming the promoted
//                    build (grok: x.ai/cli/stable + documented GCS fallback)
//   json-manifest  → a JSON manifest whose version field names the
//                    promoted build (devin: static.devin.ai current manifest)
//   install-script → the official install script is generated per release
//                    and pins the published build (cursor.com/install)
//
// Every probe has a bounded per-request timeout and one bounded retry on
// transient (network/abort/5xx/429) failures; multi-URL sources fall
// through their mirror list in order. Results cache for CACHE_TTL so the
// automatic mount-time check never hammers upstream; failures get a short
// negative TTL so a manual recheck can recover quickly. A failed check is
// reported as CHECK_FAILED — never as "up to date".
//
// Compatibility is a separate axis from "a newer build exists": managed
// capabilities are certified against exact runtime versions, so the
// result reports which precise versions hold a certification and whether
// the current/available builds match one.
const { getRuntimeDefinition } = require("./registry");
const { getAccountRuntimeCapabilities } = require("./capabilities");
const { detectRuntime } = require("./detector");

const NPM_REGISTRY_BASE = "https://registry.npmjs.org";

const DEFAULT_FETCH_TIMEOUT_MS = 8_000;
const DEFAULT_RETRY_DELAY_MS = 700;
const DEFAULT_CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_FAILURE_TTL_MS = 60 * 1000;

const UPDATE_CHECK_STATES = Object.freeze([
  // Runtime not installed — no local version to compare, upstream is not
  // queried (the install flow owns this state).
  "NOT_RUN",
  // No upstream source is declared for this runtime.
  "UNSUPPORTED",
  // Every upstream attempt failed or returned nothing parseable.
  "CHECK_FAILED",
  // Installed but the local version could not be probed (BROKEN); the
  // upstream latest is still reported.
  "CURRENT_UNKNOWN",
  // One of the two versions could not be parsed.
  "UNCOMPARABLE",
  "UP_TO_DATE",
  "UPDATE_AVAILABLE",
  // The installed build is newer than the channel's promoted latest.
  "AHEAD_OF_CHANNEL",
]);

const UPDATE_CHECK_ERROR_CODES = Object.freeze([
  "NETWORK",
  "TIMEOUT",
  "INVALID_RESPONSE",
  // HTTP_<status> is produced dynamically (e.g. HTTP_503).
]);

// Parses the vendor version shapes actually in use:
//   0.165.0 | 2.1.203 | 1.19.5 | 1.0.70        — semver-ish numerics
//   3000.11.228                                — devin's dotted build
//   2026.10.22-27dcf5f                         — cursor's date + build sha
// Returns { nums: number[], suffix: string|null } or null when the shape
// is not a plausible version.
function parseRuntimeVersion(version) {
  if (typeof version !== "string") return null;
  const match = version
    .trim()
    .replace(/^[vV]/, "")
    .match(/^(\d+(?:\.\d+)*)(?:[-+]([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    nums: match[1].split(".").map((segment) => Number.parseInt(segment, 10)),
    suffix: match[2] || null,
  };
}

// compareRuntimeVersions(a, b) → -1 | 0 | 1, or null when a side cannot
// be parsed. Numeric cores compare segment-wise; an equal core with a
// suffix ranks below the bare release (semver prerelease semantics), and
// two different suffixes compare identifier-wise per semver. Different
// Cursor hashes on the same date carry no chronological ordering.
function compareRuntimeVersions(a, b) {
  const cursorBuild = /^\s*v?\d{4}\.\d{2}\.\d{2}-[0-9a-f]+\s*$/i;
  const pa = parseRuntimeVersion(a);
  const pb = parseRuntimeVersion(b);
  if (!pa || !pb) return null;
  const len = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (pa.suffix === pb.suffix) return 0;
  if (cursorBuild.test(a) && cursorBuild.test(b)) return null;
  if (pa.suffix === null) return 1;
  if (pb.suffix === null) return -1;
  const sa = pa.suffix.split(".");
  const sb = pb.suffix.split(".");
  const slen = Math.max(sa.length, sb.length);
  for (let i = 0; i < slen; i += 1) {
    if (sa[i] === undefined) return -1;
    if (sb[i] === undefined) return 1;
    const na = /^\d+$/.test(sa[i]) ? Number.parseInt(sa[i], 10) : null;
    const nb = /^\d+$/.test(sb[i]) ? Number.parseInt(sb[i], 10) : null;
    if (na !== null && nb !== null) {
      if (na !== nb) return na < nb ? -1 : 1;
    } else if (na !== null) {
      return -1; // numeric identifiers rank below alphanumeric (semver)
    } else if (nb !== null) {
      return 1;
    } else if (sa[i] !== sb[i]) {
      return sa[i] < sb[i] ? -1 : 1;
    }
  }
  return 0;
}

function sourceUrls(check) {
  if (!check || typeof check !== "object") return [];
  switch (check.kind) {
    case "npm-latest":
      return typeof check.package === "string" && check.package.length > 0
        ? [`${NPM_REGISTRY_BASE}/${encodeURIComponent(check.package)}/latest`]
        : [];
    case "channel-file":
      return Array.isArray(check.urls)
        ? check.urls.filter((u) => typeof u === "string" && u.length > 0)
        : [];
    case "json-manifest":
    case "install-script":
      return typeof check.url === "string" && check.url.length > 0
        ? [check.url]
        : [];
    default:
      return [];
  }
}

// Extract the advertised version from a fetched body. Returns null for an
// unparsable payload — a 200 with garbage is an INVALID_RESPONSE, not a
// version.
function parseLatestVersionBody(kind, body) {
  if (typeof body !== "string") return null;
  if (kind === "npm-latest" || kind === "json-manifest") {
    try {
      const data = JSON.parse(body);
      const version = data?.version;
      return typeof version === "string" && version.length > 0
        ? version
        : null;
    } catch {
      return null;
    }
  }
  if (kind === "install-script") {
    // The generated installer pins the build it would install.
    const pinned = body.match(/\$version\s*=\s*['"]([^'"]+)['"]/);
    return pinned ? pinned[1] : null;
  }
  if (kind === "channel-file") {
    // The whole document is the channel pointer (e.g. "1.0.70\n").
    const trimmed = body.trim();
    return /^[0-9A-Za-z][0-9A-Za-z.-]*$/.test(trimmed) ? trimmed : null;
  }
  return null;
}

// fetchText → response body, or throws Error with .code (TIMEOUT |
// NETWORK | HTTP_<status>) and .retryable. Never logs the body or URL.
async function fetchText(url, { fetchImpl, timeoutMs, signal }) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response || !response.ok) {
      const status = response?.status ?? 0;
      const error = new Error(`upstream HTTP ${status}`);
      error.code = `HTTP_${status}`;
      error.retryable = status >= 500 || status === 429 || status === 0;
      throw error;
    }
    return await response.text();
  } catch (error) {
    if (typeof error?.code === "string" && /^HTTP_\d+$/.test(error.code)) {
      throw error;
    }
    const wrapped = new Error("upstream request failed");
    wrapped.code = error?.name === "AbortError" ? "TIMEOUT" : "NETWORK";
    wrapped.retryable = true;
    throw wrapped;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
}

// fetchLatestVersion(check, deps) →
//   { status: "OK", latestVersion, sourceKind, attempts }
//   { status: "UNSUPPORTED", attempts: 0 }
//   { status: "CHECK_FAILED", error, attempts }
// Bounded: ≤ 2 attempts per URL × per-request timeout, then the next URL.
async function fetchLatestVersion(check, deps) {
  const urls = sourceUrls(check);
  if (urls.length === 0) {
    return { status: "UNSUPPORTED", attempts: 0 };
  }
  let attempts = 0;
  let lastError = "NETWORK";
  for (const url of urls) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      attempts += 1;
      try {
        const body = await fetchText(url, deps);
        const version = parseLatestVersionBody(check.kind, body);
        // A parsed body must also satisfy the strict version shape —
        // otherwise it cannot be compared honestly downstream.
        if (!version || !parseRuntimeVersion(version)) {
          lastError = "INVALID_RESPONSE";
          break; // a well-formed response with garbage won't heal on retry
        }
        return {
          status: "OK",
          latestVersion: version,
          sourceKind: check.kind,
          sourceUrl: url,
          attempts,
        };
      } catch (error) {
        lastError = error?.code || "NETWORK";
        if (!error?.retryable) break;
        if (attempt === 0) await deps.sleepImpl(deps.retryDelayMs);
      }
    }
  }
  return { status: "CHECK_FAILED", error: lastError, attempts };
}

// The exact-version capability certifications bound by the runtime's
// capability descriptor (streaming + structured-output verification).
function collectCertifiedVersions(capabilities) {
  const versions = new Set();
  const streaming = capabilities?.execution?.streamingVerifiedRuntimeVersion;
  const structured = capabilities?.structuredOutput?.verifiedRuntimeVersion;
  if (typeof streaming === "string" && streaming) versions.add(streaming);
  if (typeof structured === "string" && structured) versions.add(structured);
  return [...versions];
}

// VERIFIED      — the version holds a capability certification
// UNVERIFIED    — certifications exist but bound to other version(s)
// NO_CERTIFIED_BASELINE — nothing has ever been verified at any version
function versionCompatibility(version, certifiedVersions) {
  if (typeof version !== "string" || version.length === 0) return null;
  if (certifiedVersions.length === 0) return "NO_CERTIFIED_BASELINE";
  return certifiedVersions.includes(version) ? "VERIFIED" : "UNVERIFIED";
}

// The honest recovery surface for a certified version: only real,
// documented downgrade paths produce a command — shown as text only.
function buildRecovery(recovery, certifiedVersions) {
  if (!recovery || certifiedVersions.length === 0) return null;
  const version = certifiedVersions[0];
  if (recovery.kind === "npm-pin" && typeof recovery.package === "string") {
    return {
      kind: recovery.kind,
      version,
      command: `npm install -g ${recovery.package}@${version}`,
    };
  }
  if (
    (recovery.kind === "script-version-arg" ||
      recovery.kind === "pinned-setup") &&
    typeof recovery.command === "string"
  ) {
    return {
      kind: recovery.kind,
      version,
      command: recovery.command.replaceAll("{version}", version),
    };
  }
  return { kind: recovery.kind || "none", version, command: null };
}

// createRuntimeUpdateChecker(deps) — deps reuse the detector/service
// injection points plus network seams for tests:
//   fetchImpl, sleepImpl, now, fetchTimeoutMs, retryDelayMs,
//   cacheTtlMs, failureTtlMs, plus the detect deps
//   (platform, env, spawnSyncImpl, existsSyncImpl, readdirSyncImpl).
function createRuntimeUpdateChecker(deps = {}) {
  const fetchImpl = deps.fetchImpl || globalThis.fetch?.bind(globalThis);
  const sleepImpl =
    deps.sleepImpl || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = deps.now || (() => Date.now());
  const fetchTimeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const retryDelayMs = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const failureTtlMs = deps.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS;
  // Cache holds only the upstream verdict — the local version is
  // re-probed on every call so an out-of-band update is never masked by
  // a cached comparison.
  const upstreamCache = new Map(); // backendKind → { ts, upstream }

  async function queryUpstream(backendKind, check, force) {
    const cached = upstreamCache.get(backendKind);
    if (!force && cached) {
      const ttl =
        cached.upstream.status === "CHECK_FAILED" ? failureTtlMs : cacheTtlMs;
      if (now() - cached.ts < ttl) {
        return { ...cached.upstream, fromCache: true, checkedAt: cached.ts };
      }
    }
    if (typeof fetchImpl !== "function") {
      const upstream = {
        status: "CHECK_FAILED",
        error: "NETWORK",
        attempts: 0,
      };
      upstreamCache.set(backendKind, { ts: now(), upstream });
      return { ...upstream, fromCache: false, checkedAt: now() };
    }
    const upstream = await fetchLatestVersion(check, {
      fetchImpl,
      sleepImpl,
      timeoutMs: fetchTimeoutMs,
      retryDelayMs,
    });
    upstreamCache.set(backendKind, { ts: now(), upstream });
    return { ...upstream, fromCache: false, checkedAt: now() };
  }

  function verdict(detected, upstream) {
    if (upstream.status === "CHECK_FAILED") return "CHECK_FAILED";
    if (!detected.version) return "CURRENT_UNKNOWN";
    const comparison = compareRuntimeVersions(
      detected.version,
      upstream.latestVersion,
    );
    if (comparison === null) return "UNCOMPARABLE";
    if (comparison < 0) return "UPDATE_AVAILABLE";
    if (comparison > 0) return "AHEAD_OF_CHANNEL";
    return "UP_TO_DATE";
  }

  return {
    // checkRuntimeUpdate(backendKind, { force }) → the composite update
    // report the Settings surface renders. force bypasses the cache read
    // (the manual recheck); the service path is identical either way.
    async checkRuntimeUpdate(backendKind, { force = false } = {}) {
      const definition = getRuntimeDefinition(backendKind);
      if (!definition) {
        throw new Error(`Unknown runtime backendKind: ${backendKind}`);
      }
      const detected = detectRuntime(backendKind, deps);
      const capabilities = getAccountRuntimeCapabilities(backendKind);
      const certifiedVersions = collectCertifiedVersions(capabilities);
      const check = definition.update?.check || null;
      const base = {
        backendKind,
        runtimeVendor: definition.runtimeVendor,
        installed: detected.installed,
        installState: detected.state,
        currentVersion: detected.version ?? null,
        compatibility: {
          certifiedVersions,
          current: versionCompatibility(detected.version, certifiedVersions),
          available: null,
        },
        recovery: buildRecovery(definition.update?.recovery, certifiedVersions),
        executionEnabled: false,
        methods: definition.update.methods,
      };

      if (!detected.installed) {
        return {
          ...base,
          effectiveState: detected.state,
          check: {
            supported: check !== null,
            status: "NOT_RUN",
            latestVersion: null,
            checkedAt: null,
            source: null,
            fromCache: false,
            attempts: 0,
            error: null,
          },
        };
      }

      if (!check) {
        return {
          ...base,
          effectiveState: detected.state,
          check: {
            supported: false,
            status: "UNSUPPORTED",
            latestVersion: null,
            checkedAt: null,
            source: null,
            fromCache: false,
            attempts: 0,
            error: null,
          },
        };
      }

      const upstream = await queryUpstream(backendKind, check, force);
      const status = upstream.status === "OK" ? verdict(detected, upstream) : upstream.status;
      const checkedAt =
        typeof upstream.checkedAt === "number"
          ? new Date(upstream.checkedAt).toISOString()
          : null;
      return {
        ...base,
        effectiveState:
          status === "UPDATE_AVAILABLE" ? "UPDATE_AVAILABLE" : detected.state,
        compatibility: {
          ...base.compatibility,
          available: versionCompatibility(
            upstream.latestVersion ?? null,
            certifiedVersions,
          ),
        },
        check: {
          supported: true,
          status,
          latestVersion: upstream.latestVersion ?? null,
          checkedAt,
          source: upstream.sourceKind ?? check.kind,
          fromCache: upstream.fromCache === true,
          attempts: upstream.attempts,
          error: upstream.error ?? null,
        },
      };
    },

    // Test/diagnostic seam — not called by product code.
    clearCache() {
      upstreamCache.clear();
    },
  };
}

module.exports = {
  UPDATE_CHECK_ERROR_CODES,
  UPDATE_CHECK_STATES,
  collectCertifiedVersions,
  compareRuntimeVersions,
  createRuntimeUpdateChecker,
  fetchLatestVersion,
  parseRuntimeVersion,
  versionCompatibility,
};

import { describe, expect, it } from "vitest";
import updateCheckModule from "./update-check.js";
import serviceModule from "./service.js";

const {
  compareRuntimeVersions,
  createRuntimeUpdateChecker,
  fetchLatestVersion,
  parseRuntimeVersion,
} = updateCheckModule;
const { createRuntimeStatusService } = serviceModule;

// No test hits a real network or CLI — fetch/spawnSync are faked.
function fakeFetch(handler) {
  const calls = [];
  const impl = (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  impl.calls = calls;
  return impl;
}

const jsonResponse = (data) =>
  Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(data)) });
const textResponse = (body) =>
  Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body) });
const httpError = (status) =>
  Promise.resolve({ ok: false, status, text: () => Promise.resolve("") });

const checkerDeps = (overrides = {}) => ({
  platform: "win32",
  env: {},
  spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
  existsSyncImpl: () => false,
  fetchTimeoutMs: 20,
  retryDelayMs: 0,
  sleepImpl: () => Promise.resolve(),
  ...overrides,
});

// A detect result with an installed codex at the given version.
const installedCodex = (version) => ({
  platform: "win32",
  env: {},
  existsSyncImpl: () => false,
  spawnSyncImpl: (command, args) => {
    if (command === "where.exe" && args[0] === "codex.exe") {
      return { status: 0, stdout: "C:\\Tools\\codex.exe\r\n" };
    }
    if (command === "where.exe") return { status: 1, stdout: "" };
    if (args[0] === "--version") {
      return { status: 0, stdout: `codex ${version}`, stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "" };
  },
});

describe("runtime version comparison", () => {
  it("orders semver-ish numeric versions", () => {
    expect(compareRuntimeVersions("0.164.0", "0.165.0")).toBe(-1);
    expect(compareRuntimeVersions("0.165.0", "0.165.0")).toBe(0);
    expect(compareRuntimeVersions("2.1.312", "2.1.203")).toBe(1);
    expect(compareRuntimeVersions("1.0.70", "1.0.41")).toBe(1);
    expect(compareRuntimeVersions("3000.10.31", "3000.11.228")).toBe(-1);
    // Uneven segment counts compare numerically, not lexically.
    expect(compareRuntimeVersions("0.9", "0.165.0")).toBe(-1);
    expect(compareRuntimeVersions("1.19.5", "1.2")).toBe(1);
  });

  it("orders cursor's date + build-sha versions", () => {
    expect(
      compareRuntimeVersions("2026.09.18-9a7762b", "2026.10.22-27dcf5f"),
    ).toBe(-1);
    expect(
      compareRuntimeVersions("2026.10.22-27dcf5f", "2026.10.22-27dcf5f"),
    ).toBe(0);
    expect(
      compareRuntimeVersions("2026.11.01-aaaaaaa", "2026.10.22-27dcf5f"),
    ).toBe(1);
  });

  it("ranks a bare release above a suffixed build of the same core", () => {
    expect(compareRuntimeVersions("0.165.0", "0.165.0-beta.1")).toBe(1);
    expect(compareRuntimeVersions("0.165.0-alpha", "0.165.0-beta")).toBe(-1);
  });

  it("does not invent an order for different Cursor hashes on the same date", () => {
    expect(compareRuntimeVersions("2026.10.22-fffffff", "2026.10.22-0000001")).toBeNull();
    expect(compareRuntimeVersions("2026.10.22-0000001", "2026.10.22-fffffff")).toBeNull();
    expect(compareRuntimeVersions(" V2026.10.22-fffffff ", "v2026.10.22-0000001")).toBeNull();
  });

  it("accepts a leading v prefix and rejects non-versions", () => {
    expect(compareRuntimeVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareRuntimeVersions("beta", "1.2.3")).toBeNull();
    expect(compareRuntimeVersions("1.2.3", "not a version")).toBeNull();
    expect(parseRuntimeVersion("codex")).toBeNull();
  });
});

describe("fetchLatestVersion upstream sources", () => {
  it("reads the npm latest dist-tag", async () => {
    const fetchImpl = fakeFetch((url) => {
      expect(url).toBe(
        "https://registry.npmjs.org/%40openai%2Fcodex/latest",
      );
      return jsonResponse({ version: "0.165.0" });
    });
    const result = await fetchLatestVersion(
      { kind: "npm-latest", package: "@openai/codex" },
      { fetchImpl, sleepImpl: () => Promise.resolve(), timeoutMs: 20, retryDelayMs: 0 },
    );
    expect(result.status).toBe("OK");
    expect(result.latestVersion).toBe("0.165.0");
    expect(result.sourceKind).toBe("npm-latest");
  });

  it("reads a plain-text channel pointer and falls through to the mirror", async () => {
    const fetchImpl = fakeFetch((url) =>
      url === "https://x.ai/cli/stable"
        ? Promise.reject(new TypeError("fetch failed"))
        : textResponse("1.0.70\n"),
    );
    const result = await fetchLatestVersion(
      {
        kind: "channel-file",
        channel: "stable",
        urls: [
          "https://x.ai/cli/stable",
          "https://storage.googleapis.com/grok-build-public-artifacts/cli/stable",
        ],
      },
      { fetchImpl, sleepImpl: () => Promise.resolve(), timeoutMs: 20, retryDelayMs: 0 },
    );
    expect(result.status).toBe("OK");
    expect(result.latestVersion).toBe("1.0.70");
    // Primary failed twice (attempt + one retry) before the mirror ran.
    expect(fetchImpl.calls).toHaveLength(3);
    expect(fetchImpl.calls[2].url).toContain("storage.googleapis.com");
  });

  it("reads a JSON manifest version field", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({ version: "3000.11.228", platforms: {} }),
    );
    const result = await fetchLatestVersion(
      {
        kind: "json-manifest",
        url: "https://static.devin.ai/cli/current/manifest.json",
        field: "version",
      },
      { fetchImpl, sleepImpl: () => Promise.resolve(), timeoutMs: 20, retryDelayMs: 0 },
    );
    expect(result.status).toBe("OK");
    expect(result.latestVersion).toBe("3000.11.228");
  });

  it("parses the pinned build out of the official install script", async () => {
    const fetchImpl = fakeFetch(() =>
      textResponse(
        "$downloadUrl = 'https://downloads.cursor.com/lab/2026.10.22-27dcf5f/'\n" +
          "$version = '2026.10.22-27dcf5f'\nWrite-Host 'hi'",
      ),
    );
    const result = await fetchLatestVersion(
      { kind: "install-script", url: "https://cursor.com/install?win32=true" },
      { fetchImpl, sleepImpl: () => Promise.resolve(), timeoutMs: 20, retryDelayMs: 0 },
    );
    expect(result.status).toBe("OK");
    expect(result.latestVersion).toBe("2026.10.22-27dcf5f");
  });

  it("retries a transient failure once, then reports CHECK_FAILED", async () => {
    let calls = 0;
    const fetchImpl = fakeFetch(() => {
      calls += 1;
      return Promise.reject(new TypeError("socket hangup"));
    });
    const result = await fetchLatestVersion(
      { kind: "npm-latest", package: "@openai/codex" },
      { fetchImpl, sleepImpl: () => Promise.resolve(), timeoutMs: 20, retryDelayMs: 0 },
    );
    expect(result.status).toBe("CHECK_FAILED");
    expect(result.error).toBe("NETWORK");
    expect(calls).toBe(2); // initial attempt + one bounded retry
  });

  it("retries a 5xx but never a 404", async () => {
    const flaky = fakeFetch((url) =>
      url.includes("flaky") ? httpError(503) : httpError(404),
    );
    const fiveOhThree = await fetchLatestVersion(
      { kind: "json-manifest", url: "https://x/flaky" },
      { fetchImpl: flaky, sleepImpl: () => Promise.resolve(), timeoutMs: 20, retryDelayMs: 0 },
    );
    expect(fiveOhThree.status).toBe("CHECK_FAILED");
    expect(fiveOhThree.error).toBe("HTTP_503");
    expect(fiveOhThree.attempts).toBe(2);

    const notFound = await fetchLatestVersion(
      { kind: "json-manifest", url: "https://x/missing" },
      { fetchImpl: flaky, sleepImpl: () => Promise.resolve(), timeoutMs: 20, retryDelayMs: 0 },
    );
    expect(notFound.status).toBe("CHECK_FAILED");
    expect(notFound.error).toBe("HTTP_404");
    expect(notFound.attempts).toBe(1); // no retry on a definite answer
  });

  it("bounds a hung upstream with TIMEOUT, not a hang", async () => {
    const fetchImpl = fakeFetch(
      (_url, { signal }) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        }),
    );
    const result = await fetchLatestVersion(
      { kind: "npm-latest", package: "@openai/codex" },
      { fetchImpl, sleepImpl: () => Promise.resolve(), timeoutMs: 15, retryDelayMs: 0 },
    );
    expect(result.status).toBe("CHECK_FAILED");
    expect(result.error).toBe("TIMEOUT");
    expect(result.attempts).toBe(2);
  });

  it("reports INVALID_RESPONSE for a well-formed body without a version", async () => {
    const fetchImpl = fakeFetch(() => textResponse("<html>ok</html>"));
    const result = await fetchLatestVersion(
      { kind: "channel-file", channel: "stable", urls: ["https://x/stable"] },
      { fetchImpl, sleepImpl: () => Promise.resolve(), timeoutMs: 20, retryDelayMs: 0 },
    );
    expect(result.status).toBe("CHECK_FAILED");
    expect(result.error).toBe("INVALID_RESPONSE");
    expect(fetchImpl.calls).toHaveLength(1); // retrying garbage is pointless
  });

  it("normalizes native DOMException abort codes and retries the timeout", async () => {
    const fetchImpl = fakeFetch((_url, { signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }),
    );
    const result = await fetchLatestVersion(
      { kind: "npm-latest", package: "@openai/codex" },
      { fetchImpl, sleepImpl: async () => {}, timeoutMs: 10, retryDelayMs: 0 },
    );
    expect(result).toEqual({ status: "CHECK_FAILED", error: "TIMEOUT", attempts: 2 });
  });

  it("reports UNSUPPORTED for an unknown source kind", async () => {
    const result = await fetchLatestVersion(
      { kind: "carrier-pigeon" },
      { fetchImpl: fakeFetch(() => textResponse("1.2.3")), sleepImpl: () => Promise.resolve(), timeoutMs: 20, retryDelayMs: 0 },
    );
    expect(result.status).toBe("UNSUPPORTED");
    expect(result.attempts).toBe(0);
  });
});

describe("checkRuntimeUpdate service integration", () => {
  function makeService(overrides = {}) {
    return createRuntimeStatusService({
      profilesRoot: "E:\\tmp\\does-not-need-to-exist",
      deps: checkerDeps(overrides),
    });
  }

  it("reports UPDATE_AVAILABLE with certified-version compatibility", async () => {
    const service = makeService({
      ...installedCodex("0.164.0"),
      fetchImpl: fakeFetch(() => jsonResponse({ version: "0.165.0" })),
    });
    const result = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(result.check.status).toBe("UPDATE_AVAILABLE");
    expect(result.check.latestVersion).toBe("0.165.0");
    expect(result.check.source).toBe("npm-latest");
    expect(result.effectiveState).toBe("UPDATE_AVAILABLE");
    expect(result.installState).toBe("READY");
    expect(result.currentVersion).toBe("0.164.0");
    // Capability certification is bound to 0.165.0 exactly.
    expect(result.compatibility.certifiedVersions).toEqual(["0.165.0"]);
    expect(result.compatibility.current).toBe("UNVERIFIED");
    expect(result.compatibility.available).toBe("VERIFIED");
    // The honest rollback command is real npm metadata — display only.
    expect(result.recovery.kind).toBe("npm-pin");
    expect(result.recovery.command).toBe(
      "npm install -g @openai/codex@0.165.0",
    );
    expect(result.executionEnabled).toBe(false);
    expect(result.methods[0].args).toEqual(["update"]);
  });

  it("reports UP_TO_DATE and VERIFIED on the certified build", async () => {
    const service = makeService({
      ...installedCodex("0.165.0"),
      fetchImpl: fakeFetch(() => jsonResponse({ version: "0.165.0" })),
    });
    const result = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(result.check.status).toBe("UP_TO_DATE");
    expect(result.effectiveState).toBe("READY");
    expect(result.compatibility.current).toBe("VERIFIED");
  });

  it("reports CHECK_FAILED — never UP_TO_DATE — on network failure", async () => {
    const service = makeService({
      ...installedCodex("0.165.0"),
      fetchImpl: fakeFetch(() => Promise.reject(new TypeError("offline"))),
    });
    const result = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(result.check.status).toBe("CHECK_FAILED");
    expect(result.check.error).toBe("NETWORK");
    expect(result.check.latestVersion).toBeNull();
    // A failed check must not masquerade as a proven-good state.
    expect(result.effectiveState).toBe("READY");
  });

  it("reports NOT_RUN for a not-installed runtime without querying upstream", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ version: "9.9.9" }));
    const service = makeService({ fetchImpl });
    const result = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(result.check.status).toBe("NOT_RUN");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("reports CURRENT_UNKNOWN for a BROKEN runtime but still fetches latest", async () => {
    const service = makeService({
      platform: "win32",
      env: {},
      existsSyncImpl: () => false,
      spawnSyncImpl: (command, args) => {
        if (command === "where.exe" && args[0] === "codex.exe") {
          return { status: 0, stdout: "C:\\Tools\\codex.exe" };
        }
        if (command === "where.exe") return { status: 1, stdout: "" };
        return { status: null, error: new Error("spawn failed"), stdout: "" };
      },
      fetchImpl: fakeFetch(() => jsonResponse({ version: "0.165.0" })),
    });
    const result = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(result.installState).toBe("BROKEN");
    expect(result.check.status).toBe("CURRENT_UNKNOWN");
    expect(result.check.latestVersion).toBe("0.165.0");
  });

  it("reports AHEAD_OF_CHANNEL when the install is newer than upstream", async () => {
    const service = makeService({
      ...installedCodex("0.999.0"),
      fetchImpl: fakeFetch(() => jsonResponse({ version: "0.165.0" })),
    });
    const result = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(result.check.status).toBe("AHEAD_OF_CHANNEL");
    expect(result.effectiveState).toBe("READY");
  });

  it("serves a grok channel-file check with the mirror fallback", async () => {
    const fetchImpl = fakeFetch((url) =>
      url === "https://x.ai/cli/stable"
        ? httpError(503)
        : textResponse("1.0.70"),
    );
    const service = makeService({
      platform: "win32",
      env: { USERPROFILE: "C:\\Users\\u" },
      existsSyncImpl: (p) => p === "C:\\Users\\u\\.grok\\bin\\grok.exe",
      spawnSyncImpl: (command, args) =>
        command === "C:\\Users\\u\\.grok\\bin\\grok.exe" && args[0] === "version"
          ? { status: 0, stdout: "grok 1.0.41" }
          : { status: 1, stdout: "" },
      fetchImpl,
    });
    const result = await service.checkRuntimeUpdate("GROK_RUNTIME");
    expect(result.check.status).toBe("UPDATE_AVAILABLE");
    expect(result.check.latestVersion).toBe("1.0.70");
    expect(result.check.source).toBe("channel-file");
    // Grok has no certified baseline — compatibility is honest about it.
    expect(result.compatibility.current).toBe("NO_CERTIFIED_BASELINE");
    expect(result.recovery).toBeNull();
  });

  it.each([
    ["2026.09.18-9a7762b", "UPDATE_AVAILABLE"],
    ["2026.10.22-fffffff", "UNCOMPARABLE"],
  ])("compares Cursor build %s honestly as %s", async (localVersion, expectedStatus) => {
    const env = { LOCALAPPDATA: "C:\\L" };
    const service = makeService({
      platform: "win32",
      env,
      existsSyncImpl: (p) =>
        p === "C:\\L\\cursor-agent\\versions" ||
        p === `C:\\L\\cursor-agent\\versions\\${localVersion}\\node.exe` ||
        p === `C:\\L\\cursor-agent\\versions\\${localVersion}\\index.js`,
      readdirSyncImpl: (p, opts) =>
        p === "C:\\L\\cursor-agent\\versions"
          ? [
              {
                name: localVersion,
                isDirectory: () => true,
              },
            ]
          : [],
      spawnSyncImpl: (command, args) =>
        command.endsWith("node.exe") && args[1] === "--version"
          ? { status: 0, stdout: localVersion }
          : { status: 1, stdout: "" },
      fetchImpl: fakeFetch(() =>
        textResponse("$version = '2026.10.22-27dcf5f'"),
      ),
    });
    const result = await service.checkRuntimeUpdate("CURSOR_RUNTIME");
    expect(result.check.status).toBe(expectedStatus);
    expect(result.check.latestVersion).toBe("2026.10.22-27dcf5f");
    // No scripted downgrade exists for cursor — honest none, no command.
    expect(result.recovery).toBeNull();
  });
});

describe("update-check caching and manual recheck", () => {
  function makeServiceWithFetch(handler) {
    const fetchImpl = fakeFetch(handler);
    const service = createRuntimeStatusService({
      profilesRoot: "E:\\tmp\\nope",
      deps: checkerDeps({
        ...installedCodex("0.165.0"),
        fetchImpl,
      }),
    });
    return { service, fetchImpl };
  }

  it("caches the upstream verdict so a second check costs no request", async () => {
    const { service, fetchImpl } = makeServiceWithFetch(() =>
      jsonResponse({ version: "0.165.0" }),
    );
    const first = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    const second = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(fetchImpl.calls).toHaveLength(1);
    expect(first.check.fromCache).toBe(false);
    expect(second.check.fromCache).toBe(true);
    expect(second.check.checkedAt).toBe(first.check.checkedAt);
  });

  it("force bypasses the cache for the manual recheck", async () => {
    let version = "0.165.0";
    const { service, fetchImpl } = makeServiceWithFetch(() =>
      jsonResponse({ version }),
    );
    const first = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(first.check.status).toBe("UP_TO_DATE");
    version = "0.166.0";
    const forced = await service.checkRuntimeUpdate("CODEX_RUNTIME", {
      force: true,
    });
    expect(forced.check.status).toBe("UPDATE_AVAILABLE");
    expect(forced.check.fromCache).toBe(false);
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it("uses a short negative TTL so a failed check can recover quickly", async () => {
    let now = 1_000_000;
    const fetchImpl = fakeFetch(() =>
      Promise.reject(new TypeError("offline")),
    );
    const service = createRuntimeStatusService({
      profilesRoot: "E:\\tmp\\nope",
      deps: checkerDeps({
        ...installedCodex("0.165.0"),
        fetchImpl,
        now: () => now,
        failureTtlMs: 60_000,
      }),
    });
    const first = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(first.check.status).toBe("CHECK_FAILED");
    // Within the failure TTL the failure is replayed without a new request.
    now += 30_000;
    const replayed = await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(replayed.check.fromCache).toBe(true);
    expect(fetchImpl.calls).toHaveLength(2); // attempt + retry from first call
    // Past the failure TTL a fresh probe runs.
    now += 60_000;
    await service.checkRuntimeUpdate("CODEX_RUNTIME");
    expect(fetchImpl.calls).toHaveLength(4);
  });

  it("rejects unknown backendKinds on the check channel too", async () => {
    const { service } = makeServiceWithFetch(() =>
      jsonResponse({ version: "0.165.0" }),
    );
    await expect(
      service.checkRuntimeUpdate("GEMINI_RUNTIME"),
    ).rejects.toThrow(/Unknown runtime/);
  });
});

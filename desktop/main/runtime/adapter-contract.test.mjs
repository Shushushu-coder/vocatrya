// Consolidation adapter-contract tests — table-driven conformance for all
// six ACCOUNT_LOGIN adapters against the shared AccountRuntimeAdapter
// contract. Covers: required/optional method surface, provider/runtime
// matrix binding, unified error taxonomy mapping for the shared failure
// situations, auth-URL whitelist boundaries, and smoke invariants that
// every runtime must satisfy (managed env, Vocatrya cwd, prompt marker).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import serviceModule from "./connection-service.js";
import capabilities from "./capabilities.js";

const { PROVIDER_ADAPTERS } = serviceModule;
const { getAccountRuntimeCapabilities } = capabilities;

const SIX = [
  "CODEX_RUNTIME",
  "CLAUDE_RUNTIME",
  "OPENCODE_RUNTIME",
  "GROK_RUNTIME",
  "CURSOR_RUNTIME",
  "DEVIN_RUNTIME",
];

// The valid provider/runtime matrix for ACCOUNT_LOGIN today.
const VALID_COMBINATIONS = [
  ["CODEX_RUNTIME", "OPENAI"],
  ["CLAUDE_RUNTIME", "ANTHROPIC"],
  ["OPENCODE_RUNTIME", "OPENCODE_ZEN"],
  ["OPENCODE_RUNTIME", "OPENCODE_GO"],
  ["GROK_RUNTIME", "XAI"],
  ["CURSOR_RUNTIME", "CURSOR"],
  ["DEVIN_RUNTIME", "DEVIN"],
];

// Invalid pairings every adapter must refuse with null (never an adapter).
const INVALID_COMBINATIONS = [
  ["CODEX_RUNTIME", "ANTHROPIC"],
  ["CODEX_RUNTIME", "XAI"],
  ["CODEX_RUNTIME", "DEVIN"],
  ["CLAUDE_RUNTIME", "OPENAI"],
  ["CLAUDE_RUNTIME", "CURSOR"],
  ["OPENCODE_RUNTIME", "ANTHROPIC"],
  ["OPENCODE_RUNTIME", "XAI"],
  ["OPENCODE_RUNTIME", "CURSOR"],
  ["OPENCODE_RUNTIME", "DEVIN"],
  ["OPENCODE_RUNTIME", "OPENCODE"],
  // ChatGPT-via-OpenCode was removed product semantics — OpenCode hosts
  // only its own Zen/Go accounts.
  ["OPENCODE_RUNTIME", "OPENAI"],
  // Supported in the registry matrix but intentionally not implemented —
  // the lifecycle adapter refuses it rather than half-running a login.
  ["OPENCODE_RUNTIME", "GITHUB_COPILOT"],
  ["GROK_RUNTIME", "OPENAI"],
  ["GROK_RUNTIME", "CURSOR"],
  ["CURSOR_RUNTIME", "OPENAI"],
  ["CURSOR_RUNTIME", "DEVIN"],
  ["DEVIN_RUNTIME", "OPENAI"],
  ["DEVIN_RUNTIME", "CURSOR"],
];

function adapterFor(backendKind) {
  const adapter = PROVIDER_ADAPTERS[backendKind];
  expect(adapter, `no adapter bound for ${backendKind}`).toBeTruthy();
  return adapter;
}

// The canonical provider for binding each adapter in smoke/status tests.
const BINDING_PROVIDER = Object.fromEntries(VALID_COMBINATIONS);

// Auth-status fixtures: a synthetic parsed-status object per adapter for
// each shared situation. These mirror the parsers' output shapes, not raw
// CLI text — parse-level coverage lives in the per-adapter test files.
const STATUS_FIXTURES = {
  CODEX_RUNTIME: {
    notAuthed: { authState: "NOT_AUTHENTICATED", authMethod: null },
    unknown: { authState: "UNKNOWN", authMethod: null },
    wrongMethod: { authState: "AUTHENTICATED", authMethod: "api_key" },
    // Authenticated output that names no recognized method.
    unverifiableMethod: { authState: "AUTHENTICATED", authMethod: null },
    valid: { authState: "AUTHENTICATED", authMethod: "chatgpt" },
  },
  CLAUDE_RUNTIME: {
    notAuthed: { authState: "NOT_AUTHENTICATED", authKind: null },
    unknown: { authState: "UNKNOWN", authKind: null },
    wrongMethod: { authState: "AUTHENTICATED", authKind: "API_KEY" },
    unverifiableMethod: { authState: "AUTHENTICATED", authKind: "UNKNOWN" },
    valid: {
      authState: "AUTHENTICATED",
      authKind: "CLAUDE_AI_SUBSCRIPTION",
    },
  },
  OPENCODE_RUNTIME: {
    notAuthed: { authState: "NOT_AUTHENTICATED", authKind: null },
    unknown: { authState: "UNKNOWN", authKind: null },
    wrongMethod: { authState: "AUTHENTICATED", authKind: "OPENAI_API_KEY" },
    unverifiableMethod: { authState: "AUTHENTICATED", authKind: "UNKNOWN" },
    valid: {
      authState: "AUTHENTICATED",
      authKind: "OPENCODE_GO_API_KEY",
    },
  },
  GROK_RUNTIME: {
    notAuthed: { authState: "NOT_AUTHENTICATED", authKind: null },
    unknown: { authState: "UNKNOWN", authKind: null },
    wrongMethod: { authState: "AUTHENTICATED", authKind: "API_KEY" },
    unverifiableMethod: { authState: "AUTHENTICATED", authKind: "UNKNOWN" },
    valid: { authState: "AUTHENTICATED", authKind: "XAI_OAUTH_SESSION" },
  },
  CURSOR_RUNTIME: {
    notAuthed: { authState: "NOT_AUTHENTICATED" },
    unknown: { authState: "UNKNOWN" },
    // Provenance-based: inside the managed profile only `agent login` can
    // produce AUTHENTICATED. A foreign method is still refused.
    wrongMethod: { authState: "AUTHENTICATED", authMethod: "api_key" },
    valid: {
      authState: "AUTHENTICATED",
      authMethod: "CURSOR_BROWSER_ACCOUNT",
    },
  },
  DEVIN_RUNTIME: {
    notAuthed: { authState: "NOT_AUTHENTICATED", authKind: null },
    unknown: { authState: "UNKNOWN", authKind: null },
    wrongMethod: { authState: "AUTHENTICATED", authKind: "PAT" },
    unverifiableMethod: { authState: "AUTHENTICATED", authKind: "UNKNOWN" },
    valid: { authState: "AUTHENTICATED", authKind: "DEVIN_ACCOUNT" },
  },
};

describe("adapter contract — required surface", () => {
  it("every bound adapter exposes the same core contract", () => {
    for (const kind of SIX) {
      const base = adapterFor(kind);
      expect(base.backendKind, kind).toBe(kind);
      expect(typeof base.forAccountProvider, "function", kind).toBe(
        "function",
      );
      // Multi-provider runtimes carry the operation surface on the
      // provider-bound adapter, so assert against the bound form.
      const adapter =
        base.forAccountProvider(BINDING_PROVIDER[kind]) ?? base;
      expect(adapter.backendKind, kind).toBe(kind);
      expect(typeof adapter.loginGuardKey, "string", kind).toBe("string");
      for (const method of [
        "resolveExecutable",
        "buildLoginInvocation",
        "buildLogoutInvocation",
        "loginFailureCode",
        "reportableAuthState",
        "listModels",
        "buildSmokeInvocation",
        "extractSmokeText",
        // Business TEXT_ONLY execution surface.
        "buildTextInvocation",
        "extractText",
      ]) {
        expect(typeof adapter[method], `${kind}.${method}`).toBe("function");
      }
      // Status surface is exactly one of: a one-shot status command
      // (buildStatusInvocation + parseAuthStatus) or a probeAuth exchange
      // (Grok — auth is only observable through the ACP stdio handshake).
      if (typeof adapter.probeAuth === "function") {
        expect(adapter.buildStatusInvocation, kind).toBeUndefined();
        expect(adapter.parseAuthStatus, kind).toBeUndefined();
      } else {
        expect(typeof adapter.buildStatusInvocation, kind).toBe("function");
        expect(typeof adapter.parseAuthStatus, kind).toBe("function");
      }
      expect(typeof adapter.smokeExpected, "string", kind).toBe("string");
      expect(adapter.smokeExpected.length, kind).toBeGreaterThan(0);
    }
  });

  it("optional capabilities exist exactly where the matrix declares them", () => {
    for (const kind of SIX) {
      const base = adapterFor(kind);
      const adapter =
        base.forAccountProvider(BINDING_PROVIDER[kind]) ?? base;
      const caps = getAccountRuntimeCapabilities(kind);
      // ACP_STDIO verification ⟺ a probeAuth ACP exchange.
      expect(Boolean(adapter.probeAuth), kind).toBe(
        caps.auth.verification === "ACP_STDIO",
      );
      // surfacesAuthorizationUrl ⟺ an extractLoginUrl URL parser.
      expect(Boolean(adapter.extractLoginUrl), kind).toBe(
        caps.login.surfacesAuthorizationUrl,
      );
      // Multi-provider runtimes must validate the requested model route.
      expect(Boolean(adapter.resolveSmokeModel), kind).toBe(
        caps.supportedAccountProviders.length > 1,
      );
    }
    // Session preparation is Devin-only (org pinning + profile skeleton).
    for (const kind of SIX) {
      const base = adapterFor(kind);
      const adapter =
        base.forAccountProvider(BINDING_PROVIDER[kind]) ?? base;
      expect(Boolean(adapter.prepareSession), kind).toBe(
        kind === "DEVIN_RUNTIME",
      );
    }
  });
});

describe("adapter contract — provider/runtime matrix", () => {
  it("binds every valid combination to its adapter", () => {
    for (const [backendKind, provider] of VALID_COMBINATIONS) {
      const bound = adapterFor(backendKind).forAccountProvider(provider);
      expect(bound, `${provider}+${backendKind}`).toBeTruthy();
      expect(bound.backendKind).toBe(backendKind);
    }
  });

  it("refuses every invalid combination with null", () => {
    for (const [backendKind, provider] of INVALID_COMBINATIONS) {
      expect(
        adapterFor(backendKind).forAccountProvider(provider),
        `${provider}+${backendKind} must not bind`,
      ).toBeNull();
    }
  });
});

describe("adapter contract — unified login error mapping", () => {
  it("maps NOT_AUTHENTICATED to AUTH_NOT_CONFIRMED on every runtime", () => {
    for (const kind of SIX) {
      const adapter = adapterFor(kind).forAccountProvider(
        BINDING_PROVIDER[kind],
      );
      expect(
        adapter.loginFailureCode(STATUS_FIXTURES[kind].notAuthed),
        kind,
      ).toBe("AUTH_NOT_CONFIRMED");
    }
  });

  it("maps UNKNOWN probe output to AUTH_NOT_CONFIRMED on every runtime", () => {
    for (const kind of SIX) {
      const adapter = adapterFor(kind).forAccountProvider(
        BINDING_PROVIDER[kind],
      );
      expect(
        adapter.loginFailureCode(STATUS_FIXTURES[kind].unknown),
        kind,
      ).toBe("AUTH_NOT_CONFIRMED");
    }
  });

  it("never accepts a wrong or unverifiable auth method as success", () => {
    for (const kind of SIX) {
      const fixtures = STATUS_FIXTURES[kind];
      const adapter = adapterFor(kind).forAccountProvider(
        BINDING_PROVIDER[kind],
      );
      for (const key of ["wrongMethod", "unverifiableMethod"]) {
        if (!fixtures[key]) continue;
        expect(
          adapter.loginFailureCode(fixtures[key]),
          `${kind} ${key}`,
        ).toMatch(/UNSUPPORTED_AUTH_METHOD|AUTH_METHOD_UNVERIFIED/);
      }
    }
  });

  it("accepts exactly the required auth method on every runtime", () => {
    for (const kind of SIX) {
      const adapter = adapterFor(kind).forAccountProvider(
        BINDING_PROVIDER[kind],
      );
      expect(
        adapter.loginFailureCode(STATUS_FIXTURES[kind].valid),
        kind,
      ).toBeNull();
    }
  });

  it("reportableAuthState never leaks a wrong-method AUTHENTICATED", () => {
    for (const kind of SIX) {
      const adapter = adapterFor(kind).forAccountProvider(
        BINDING_PROVIDER[kind],
      );
      for (const key of ["wrongMethod", "unverifiableMethod"]) {
        const fixture = STATUS_FIXTURES[kind][key];
        if (!fixture) continue;
        expect(
          adapter.reportableAuthState(fixture),
          `${kind} ${key} must not report AUTHENTICATED`,
        ).not.toBe("AUTHENTICATED");
      }
      // A valid session always reports AUTHENTICATED.
      expect(adapter.reportableAuthState(STATUS_FIXTURES[kind].valid)).toBe(
        "AUTHENTICATED",
      );
    }
  });
});

describe("adapter contract — authorization URL whitelist", () => {
  const EVIL_URLS = [
    "https://evil.example.com/oauth/authorize",
    "http://auth.openai.com/oauth/authorize",
    "https://x.ai.evil.com/authorize",
    "javascript:alert(1)",
  ];

  it("each URL-surfacing adapter rejects non-vendor origins", () => {
    for (const kind of SIX) {
      const adapter = adapterFor(kind).forAccountProvider(
        BINDING_PROVIDER[kind],
      );
      if (!adapter.extractLoginUrl) continue;
      for (const url of EVIL_URLS) {
        // Feed the URL as stdout/stderr — extraction must not emit it.
        expect(
          adapter.extractLoginUrl(`open ${url} now`, kind),
          `${kind} leaked ${url}`,
        ).toBeNull();
      }
    }
  });
});

describe("adapter contract — smoke invariants", () => {
  let workingDirectory;

  beforeAll(() => {
    workingDirectory = fs.mkdtempSync(
      path.join(os.tmpdir(), "vocatrya-contract-smoke-"),
    );
  });

  afterAll(() => {
    fs.rmSync(workingDirectory, { recursive: true, force: true });
  });

  // Business prompts can exceed the Windows command-line limit, so every
  // adapter transports the prompt off-argv: piped stdin (stdinPipe +
  // onStdinReady writer) or a --prompt-file inside the fresh workDir.
  // This drives the declared transport and returns what the CLI would
  // actually receive.
  function collectPromptTransport(inv) {
    if (typeof inv.onStdinReady === "function") {
      expect(inv.stdinPipe, "stdin transport must pipe stdin").toBe(true);
      const chunks = [];
      const fakeStdin = {
        on() {},
        write(chunk) {
          chunks.push(String(chunk));
        },
        end(chunk) {
          if (chunk !== undefined) chunks.push(String(chunk));
          this.ended = true;
        },
        ended: false,
      };
      inv.onStdinReady(fakeStdin);
      expect(fakeStdin.ended, "stdin must reach EOF").toBe(true);
      return { kind: "stdin", prompt: chunks.join("") };
    }
    const fileFlag = inv.args.indexOf("--prompt-file");
    expect(
      fileFlag,
      "prompt must ride stdin or --prompt-file",
    ).toBeGreaterThan(-1);
    const promptPath = inv.args[fileFlag + 1];
    return { kind: "file", promptPath, prompt: fs.readFileSync(promptPath, "utf8") };
  }

  function expectPromptTransport(inv, prompt, kind) {
    // The prompt is never an argv element — never a shell string either.
    expect(inv.args, `${kind} prompt leaked into argv`).not.toContain(prompt);
    const transport = collectPromptTransport(inv);
    expect(transport.prompt, `${kind} transport lost the prompt`).toBe(
      prompt,
    );
    if (transport.kind === "file") {
      // Prompt files live only inside the per-execution workDir — the
      // service removes that directory wholesale after the run.
      expect(transport.promptPath.startsWith(inv.cwd)).toBe(true);
    }
  }

  it("every smoke invocation runs in the Vocatrya temp cwd with a marker", () => {
    for (const kind of SIX) {
      const adapter = adapterFor(kind).forAccountProvider(
        BINDING_PROVIDER[kind],
      );
      const profileDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "vocatrya-contract-profile-"),
      );
      const baseEnv = {
        PATH: "C:\\Windows",
        USERPROFILE: "C:\\Users\\Real",
        APPDATA: "C:\\Users\\Real\\AppData\\Roaming",
        OPENAI_API_KEY: "sk-poison",
        ANTHROPIC_API_KEY: "sk-ant-poison",
        GITHUB_TOKEN: "ghp_poison",
      };
      const inv = adapter.buildSmokeInvocation({
        executable: "C:\\fake\\rt.exe",
        profileDir,
        workingDirectory,
        model: "test-model",
        accountProvider: BINDING_PROVIDER[kind],
        baseEnv,
      });
      expect(inv.cwd, kind).toBe(workingDirectory);
      // The marker prompt rides the declared stdin/file transport —
      // never an args element or a shell string.
      const transport = collectPromptTransport(inv);
      expect(transport.prompt, `${kind} marker missing`).toContain(
        adapter.smokeExpected,
      );
      // No ambient provider credential reaches the managed env.
      for (const key of [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
      ]) {
        expect(inv.env[key], `${kind} leaked ${key}`).toBeUndefined();
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("every TEXT_ONLY invocation keeps the same boundary as smoke", () => {
    const prompt = "Summarize this job posting: Senior Engineer at Acme";
    for (const kind of SIX) {
      const adapter = adapterFor(kind).forAccountProvider(
        BINDING_PROVIDER[kind],
      );
      const profileDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "vocatrya-contract-profile-"),
      );
      const baseEnv = {
        PATH: "C:\\Windows",
        USERPROFILE: "C:\\Users\\Real",
        APPDATA: "C:\\Users\\Real\\AppData\\Roaming",
        OPENAI_API_KEY: "sk-poison",
        ANTHROPIC_API_KEY: "sk-ant-poison",
        GITHUB_TOKEN: "ghp_poison",
      };
      const inv = adapter.buildTextInvocation({
        executable: "C:\\fake\\rt.exe",
        profileDir,
        workingDirectory,
        model: "test-model",
        accountProvider: BINDING_PROVIDER[kind],
        baseEnv,
        prompt,
      });
      // cwd is always the caller's Vocatrya-owned temp dir — never a
      // profile dir or a user directory.
      expect(inv.cwd, kind).toBe(workingDirectory);
      expectPromptTransport(inv, prompt, kind);
      for (const key of [
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "GITHUB_TOKEN",
      ]) {
        expect(inv.env[key], `${kind} leaked ${key}`).toBeUndefined();
      }
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });

  it("a prompt beyond the Windows argv limit is transported intact", () => {
    // ~80 KB — far beyond the ~32k CreateProcess command-line ceiling
    // that made resume-import prompts fail spawn with ENAMETOOLONG.
    const prompt = `Long resume payload ${"x".repeat(80 * 1024)} end`;
    for (const kind of SIX) {
      const adapter = adapterFor(kind).forAccountProvider(
        BINDING_PROVIDER[kind],
      );
      const profileDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "vocatrya-contract-profile-"),
      );
      const inv = adapter.buildTextInvocation({
        executable: "C:\\fake\\rt.exe",
        profileDir,
        workingDirectory,
        model: "test-model",
        accountProvider: BINDING_PROVIDER[kind],
        baseEnv: { PATH: "C:\\Windows" },
        prompt,
      });
      expectPromptTransport(inv, prompt, kind);
      // Every argv element stays small — nothing approximates the prompt.
      expect(
        Math.max(...inv.args.map((a) => a.length)),
        `${kind} oversized argv element`,
      ).toBeLessThan(4096);
      fs.rmSync(profileDir, { recursive: true, force: true });
    }
  });
});

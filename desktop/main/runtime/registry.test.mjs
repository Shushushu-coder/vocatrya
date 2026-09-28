import { describe, expect, it } from "vitest";
import registry from "./registry.js";

const {
  RUNTIME_DEFINITIONS,
  collectSensitiveEnvKeys,
  getRuntimeDefinition,
  isRegisteredBackendKind,
  listRuntimeDefinitions,
} = registry;

// Runtime vendor ≠ account provider: the vendor labels the runtime, the
// supported list bounds which account providers may authenticate through
// it. OpenCode intentionally lists its two own products — vendor
// semantics never collapse to a single provider.
const EXPECTED_VENDOR_BY_BACKEND = {
  CODEX_RUNTIME: "OPENAI",
  CLAUDE_RUNTIME: "ANTHROPIC",
  GROK_RUNTIME: "XAI",
  OPENCODE_RUNTIME: "OPENCODE",
  CURSOR_RUNTIME: "CURSOR",
  COPILOT_RUNTIME: "GITHUB_COPILOT",
  DEVIN_RUNTIME: "DEVIN",
};

const EXPECTED_ACCOUNT_PROVIDERS_BY_BACKEND = {
  CODEX_RUNTIME: ["OPENAI"],
  CLAUDE_RUNTIME: ["ANTHROPIC"],
  GROK_RUNTIME: ["XAI"],
  OPENCODE_RUNTIME: ["OPENCODE_ZEN", "OPENCODE_GO", "GITHUB_COPILOT"],
  CURSOR_RUNTIME: ["CURSOR"],
  COPILOT_RUNTIME: ["GITHUB_COPILOT"],
  DEVIN_RUNTIME: ["DEVIN"],
};

describe("runtime definition registry", () => {
  it("contains exactly the seven first-wave runtimes", () => {
    expect(RUNTIME_DEFINITIONS).toHaveLength(7);
    const kinds = RUNTIME_DEFINITIONS.map((d) => d.backendKind);
    expect(new Set(kinds).size).toBe(7);
    for (const kind of Object.keys(EXPECTED_VENDOR_BY_BACKEND)) {
      expect(kinds).toContain(kind);
    }
  });

  it("labels every backendKind with its runtime vendor", () => {
    for (const [backendKind, vendor] of Object.entries(
      EXPECTED_VENDOR_BY_BACKEND,
    )) {
      expect(getRuntimeDefinition(backendKind).runtimeVendor).toBe(vendor);
    }
  });

  it("maps every backendKind to its supported account providers", () => {
    for (const [backendKind, providers] of Object.entries(
      EXPECTED_ACCOUNT_PROVIDERS_BY_BACKEND,
    )) {
      expect(getRuntimeDefinition(backendKind).supportedAccountProviders)
        .toEqual(providers);
    }
    // OpenCode hosts its own two account products — the vendor is never
    // an account provider itself, and ChatGPT is never an OpenCode
    // account login.
    const opencode = getRuntimeDefinition("OPENCODE_RUNTIME");
    expect(opencode.supportedAccountProviders).toEqual([
      "OPENCODE_ZEN",
      "OPENCODE_GO",
      "GITHUB_COPILOT",
    ]);
    expect(opencode.supportedAccountProviders).not.toContain("OPENCODE");
    expect(opencode.supportedAccountProviders).not.toContain("OPENAI");
  });

  it("gives every runtime the required definition fields", () => {
    for (const definition of RUNTIME_DEFINITIONS) {
      expect(definition.displayName).toBeTruthy();
      expect(definition.binaries.length).toBeGreaterThan(0);
      expect(definition.binaries[0].commands.length).toBeGreaterThan(0);
      expect(definition.profile.strategy).toBeTruthy();
      expect(definition.profile.env).toBeTypeOf("object");
      expect(Array.isArray(definition.profile.stripEnv)).toBe(true);
      expect(Array.isArray(definition.install.methods)).toBe(true);
      expect(definition.install.methods.length).toBeGreaterThan(0);
      expect(Array.isArray(definition.update.methods)).toBe(true);
      expect(Array.isArray(definition.versionProbe.args)).toBe(true);
      expect(Array.isArray(definition.authProbe.args)).toBe(true);
      expect(definition.capabilities.accountLogin).toBe(true);
    }
  });

  it("keeps install/update as metadata only — nothing auto-executes", () => {
    for (const definition of RUNTIME_DEFINITIONS) {
      expect(definition.install.executionEnabled).toBe(false);
      expect(definition.update.executionEnabled).toBe(false);
      for (const method of [
        ...definition.install.methods,
        ...definition.update.methods,
      ]) {
        // Structured data: executable + args array, never a shell string.
        expect(typeof method.executable).toBe("string");
        expect(Array.isArray(method.args)).toBe(true);
      }
    }
  });

  it("models OpenCode as XDG-root isolation, never OPENCODE_CONFIG_DIR alone", () => {
    // Regression for the corrected boundary: opencode stores auth.json
    // under XDG_DATA_HOME\opencode — a lone config dir cannot isolate
    // credentials. All four XDG roots must redirect into the profile.
    const opencode = getRuntimeDefinition("OPENCODE_RUNTIME");
    expect(opencode.profile.strategy).toBe("ISOLATED_ROOTS");
    for (const key of [
      "XDG_DATA_HOME",
      "XDG_CONFIG_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]) {
      expect(opencode.profile.env[key]).toContain("$PROFILE_DIR");
      expect(opencode.profile.env[key]).not.toBe("$PROFILE_DIR");
    }
    // OPENCODE_CONFIG_DIR may exist as a config override but must live
    // inside the XDG config root — never the credential boundary itself.
    expect(opencode.profile.env.OPENCODE_CONFIG_DIR).toContain("$PROFILE_DIR");
    // Provider credential env that would bypass managed OAuth is stripped.
    for (const key of [
      "OPENAI_API_KEY",
      "OPENROUTER_API_KEY",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "ANTHROPIC_API_KEY",
      "XAI_API_KEY",
    ]) {
      expect(opencode.profile.stripEnv).toContain(key);
    }
  });

  it("models Cursor as isolated roots, never CURSOR_CONFIG_DIR alone", () => {
    // Phase H boundary, verified against cursor-agent 2026.09.18-9a7762b:
    // credentials persist in %APPDATA%\Cursor\auth.json — a lone
    // CURSOR_CONFIG_DIR only covers cli-config.json and can never
    // isolate authentication.
    const cursor = getRuntimeDefinition("CURSOR_RUNTIME");
    expect(cursor.profile.strategy).toBe("ISOLATED_ROOTS");
    for (const key of [
      "CURSOR_CONFIG_DIR",
      "APPDATA",
      "LOCALAPPDATA",
      "HOME",
      "USERPROFILE",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]) {
      expect(cursor.profile.env[key]).toContain("$PROFILE_DIR");
      expect(cursor.profile.env[key]).not.toBe("$PROFILE_DIR");
    }
    // Credential and endpoint overrides that would bypass the managed
    // browser session are stripped globally.
    for (const key of [
      "CURSOR_API_KEY",
      "CURSOR_AUTH_TOKEN",
      "CURSOR_API_ENDPOINT",
      "CURSOR_WEBSITE_URL",
      "CURSOR_ENABLE_BEDROCK",
      "CURSOR_AGENT_CLI_AUTHLESS_MODE",
      "AGENT_CLI_CREDENTIAL_STORE",
      "AGENT_CLI_UPDATE_CHECK_URL",
      "HOMEDRIVE",
      "HOMEPATH",
    ]) {
      expect(cursor.profile.stripEnv).toContain(key);
    }
    // The bundle contract anchors executable resolution to the
    // versioned Node bundle — PATH `agent` collisions are not trusted.
    expect(cursor.bundle.kind).toBe("node-versions");
    expect(cursor.bundle.interpreter).toBe("node.exe");
    expect(cursor.bundle.entrypoint).toBe("index.js");
  });

  it("models Devin as isolated roots anchored on USERPROFILE", () => {
    // Verified against devin 3000.10.31: credentials persist at
    // %USERPROFILE%\AppData\Roaming\devin\credentials.toml — USERPROFILE is
    // the isolation boundary, APPDATA alone is not. --config relocates
    // config.json only, so there is no invocation.configArgs boundary.
    const devin = getRuntimeDefinition("DEVIN_RUNTIME");
    expect(devin.profile.strategy).toBe("ISOLATED_ROOTS");
    for (const key of [
      "USERPROFILE",
      "HOME",
      "APPDATA",
      "LOCALAPPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
      "XDG_STATE_HOME",
    ]) {
      expect(devin.profile.env[key]).toContain("$PROFILE_DIR");
      expect(devin.profile.env[key]).not.toBe("$PROFILE_DIR");
    }
    expect(devin.profile.invocation).toBeUndefined();
    for (const key of [
      "DEVIN_API_KEY",
      "DEVIN_TOKEN",
      "DEVIN_ACCESS_TOKEN",
      "DEVIN_PAT",
      "WINDSURF_API_KEY",
      "COGNITION_API_KEY",
      "DEVIN_API_URL",
      "DEVIN_WEBAPP_HOST",
      "DEVIN_ACP_BACKEND",
      "HOMEDRIVE",
      "HOMEPATH",
    ]) {
      expect(devin.profile.stripEnv).toContain(key);
    }
  });

  it("collects the union of provider credential-override env keys", () => {
    const keys = collectSensitiveEnvKeys();
    for (const key of [
      "CURSOR_API_KEY",
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GROK_API_KEY",
      "XAI_API_KEY",
    ]) {
      expect(keys.has(key)).toBe(true);
    }
  });

  it("exposes lookup helpers used by the IPC allowlist", () => {
    expect(isRegisteredBackendKind("CODEX_RUNTIME")).toBe(true);
    expect(isRegisteredBackendKind("GEMINI_RUNTIME")).toBe(false);
    expect(isRegisteredBackendKind("runtime:exec")).toBe(false);
    expect(listRuntimeDefinitions()).toHaveLength(7);
  });
});

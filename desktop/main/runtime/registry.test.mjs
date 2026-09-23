import { describe, expect, it } from "vitest";
import registry from "./registry.js";

const {
  RUNTIME_DEFINITIONS,
  collectSensitiveEnvKeys,
  getRuntimeDefinition,
  isRegisteredBackendKind,
  listRuntimeDefinitions,
} = registry;

const EXPECTED_PROVIDER_BY_BACKEND = {
  CODEX_RUNTIME: "OPENAI",
  CLAUDE_RUNTIME: "ANTHROPIC",
  GROK_RUNTIME: "XAI",
  OPENCODE_RUNTIME: "OPENCODE",
  CURSOR_RUNTIME: "CURSOR",
  COPILOT_RUNTIME: "GITHUB_COPILOT",
  DEVIN_RUNTIME: "DEVIN",
};

describe("runtime definition registry", () => {
  it("contains exactly the seven first-wave runtimes", () => {
    expect(RUNTIME_DEFINITIONS).toHaveLength(7);
    const kinds = RUNTIME_DEFINITIONS.map((d) => d.backendKind);
    expect(new Set(kinds).size).toBe(7);
    for (const kind of Object.keys(EXPECTED_PROVIDER_BY_BACKEND)) {
      expect(kinds).toContain(kind);
    }
  });

  it("maps every backendKind to the contracted provider", () => {
    for (const [backendKind, provider] of Object.entries(
      EXPECTED_PROVIDER_BY_BACKEND,
    )) {
      expect(getRuntimeDefinition(backendKind).provider).toBe(provider);
    }
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

  it("models Devin as isolated roots, not a single HOME env", () => {
    const devin = getRuntimeDefinition("DEVIN_RUNTIME");
    expect(devin.profile.strategy).toBe("ISOLATED_ROOTS");
    for (const key of [
      "APPDATA",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "HOME",
    ]) {
      expect(devin.profile.env[key]).toContain("$PROFILE_DIR");
    }
    expect(devin.profile.invocation.configArgs[0]).toBe("--config");
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

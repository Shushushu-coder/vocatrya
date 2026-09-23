// Consolidation capability-matrix tests — pin the unified
// getAccountRuntimeCapabilities contract so capability drift, fake
// "safe" booleans, or invented runtime abilities fail loudly. Values
// reflect verified facts only.
import { describe, expect, it } from "vitest";
import registry from "./registry.js";
import capabilities from "./capabilities.js";

const {
  ACCOUNT_RUNTIME_CAPABILITY_MATRIX,
  AUTO_UPDATE_STATES,
  LOGIN_INTERACTIONS,
  MODEL_STRATEGIES,
  PERMISSION_LEVELS,
  VERIFICATION_STATES,
  getAccountRuntimeCapabilities,
  listAccountRuntimeCapabilities,
} = capabilities;
const { getRuntimeDefinition, listRuntimeDefinitions } = registry;

const IMPLEMENTED = [
  "CODEX_RUNTIME",
  "CLAUDE_RUNTIME",
  "OPENCODE_RUNTIME",
  "GROK_RUNTIME",
  "CURSOR_RUNTIME",
  "DEVIN_RUNTIME",
];

describe("account runtime capability matrix", () => {
  it("covers every registry runtime exactly once", () => {
    const registered = listRuntimeDefinitions().map((d) => d.backendKind);
    expect(new Set(Object.keys(ACCOUNT_RUNTIME_CAPABILITY_MATRIX))).toEqual(
      new Set(registered),
    );
    expect(listAccountRuntimeCapabilities()).toHaveLength(registered.length);
  });

  it("mirrors registry identity facts without duplicating them", () => {
    for (const kind of Object.keys(ACCOUNT_RUNTIME_CAPABILITY_MATRIX)) {
      const definition = getRuntimeDefinition(kind);
      const descriptor = getAccountRuntimeCapabilities(kind);
      expect(descriptor.backendKind).toBe(definition.backendKind);
      expect(descriptor.displayName).toBe(definition.displayName);
      expect(descriptor.runtimeVendor).toBe(definition.runtimeVendor);
      expect(descriptor.supportedAccountProviders).toEqual(
        definition.supportedAccountProviders,
      );
      expect(descriptor.profile.strategy).toBe(definition.profile.strategy);
      expect(descriptor.profile.credentialBoundary).toEqual(
        definition.profile.credentialBoundary,
      );
    }
  });

  it("returns null for unknown backendKinds — never invented capabilities", () => {
    expect(getAccountRuntimeCapabilities("GEMINI_RUNTIME")).toBeNull();
    expect(getAccountRuntimeCapabilities("")).toBeNull();
    expect(getAccountRuntimeCapabilities(undefined)).toBeNull();
  });

  it("implements exactly the six account-login runtimes", () => {
    for (const kind of IMPLEMENTED) {
      expect(
        getAccountRuntimeCapabilities(kind).implemented,
        kind,
      ).toBe(true);
      expect(
        getAccountRuntimeCapabilities(kind).capabilities.accountLogin,
        kind,
      ).toBe(true);
    }
    // Copilot is registry-known but intentionally not implemented.
    const copilot = getAccountRuntimeCapabilities("COPILOT_RUNTIME");
    expect(copilot.implemented).toBe(false);
    expect(copilot.permission.level).toBe(PERMISSION_LEVELS.NOT_READY);
  });

  it("classifies permissions as levels — Codex sandboxed, the rest best-effort", () => {
    expect(getAccountRuntimeCapabilities("CODEX_RUNTIME").permission.level).toBe(
      PERMISSION_LEVELS.STRONG_SANDBOX,
    );
    for (const kind of IMPLEMENTED.slice(1)) {
      expect(
        getAccountRuntimeCapabilities(kind).permission.level,
        kind,
      ).toBe(PERMISSION_LEVELS.BEST_EFFORT_RUNTIME_PERMISSIONS);
    }
    // No runtime exposes a vague boolean safety claim.
    for (const descriptor of listAccountRuntimeCapabilities()) {
      expect(descriptor.capabilities).not.toHaveProperty("safe");
    }
  });

  it("states each runtime's Windows OS-sandbox truth explicitly", () => {
    const osSandbox = (kind) =>
      getAccountRuntimeCapabilities(kind).permission.osSandbox;
    expect(osSandbox("CODEX_RUNTIME")).toBe("READ_ONLY_WORKSPACE");
    expect(osSandbox("CLAUDE_RUNTIME")).toBe("NONE_ON_WINDOWS");
    expect(osSandbox("OPENCODE_RUNTIME")).toBe("NONE");
    expect(osSandbox("GROK_RUNTIME")).toBe("NO_OP_ON_WINDOWS");
    expect(osSandbox("CURSOR_RUNTIME")).toBe("RUNTIME_FLAG_UNVERIFIED");
    expect(osSandbox("DEVIN_RUNTIME")).toBe("UNAVAILABLE_ON_WINDOWS");
  });

  it("models login interaction per runtime, not per provider name", () => {
    const interaction = (kind) =>
      getAccountRuntimeCapabilities(kind).login.interaction;
    expect(interaction("CODEX_RUNTIME")).toBe(
      LOGIN_INTERACTIONS.RUNTIME_MANAGED_BROWSER,
    );
    expect(interaction("CLAUDE_RUNTIME")).toBe(
      LOGIN_INTERACTIONS.RUNTIME_MANAGED_BROWSER,
    );
    expect(interaction("OPENCODE_RUNTIME")).toBe(LOGIN_INTERACTIONS.BROWSER);
    expect(interaction("GROK_RUNTIME")).toBe(LOGIN_INTERACTIONS.BROWSER);
    expect(interaction("CURSOR_RUNTIME")).toBe(LOGIN_INTERACTIONS.BROWSER);
    expect(interaction("DEVIN_RUNTIME")).toBe(
      LOGIN_INTERACTIONS.VISIBLE_CONSOLE,
    );
    // Only runtimes whose CLI cannot open a browser surface an auth URL.
    const surfaces = (kind) =>
      getAccountRuntimeCapabilities(kind).login.surfacesAuthorizationUrl;
    for (const kind of ["OPENCODE_RUNTIME", "GROK_RUNTIME", "CURSOR_RUNTIME"]) {
      expect(surfaces(kind), kind).toBe(true);
    }
    for (const kind of ["CODEX_RUNTIME", "CLAUDE_RUNTIME", "DEVIN_RUNTIME"]) {
      expect(surfaces(kind), kind).toBe(false);
    }
  });

  it("describes auth verification mechanism and account-identity support", () => {
    const auth = (kind) => getAccountRuntimeCapabilities(kind).auth;
    expect(auth("GROK_RUNTIME").verification).toBe("ACP_STDIO");
    for (const kind of [
      "CODEX_RUNTIME",
      "CLAUDE_RUNTIME",
      "OPENCODE_RUNTIME",
      "CURSOR_RUNTIME",
      "DEVIN_RUNTIME",
    ]) {
      expect(auth(kind).verification, kind).toBe("STATUS_COMMAND");
    }
    // OpenCode's `auth list` reports provider+auth-type only — no identity.
    expect(auth("OPENCODE_RUNTIME").accountIdentity).toBe(false);
    expect(auth("CODEX_RUNTIME").accountIdentity).toBe(true);
    expect(auth("DEVIN_RUNTIME").accountIdentity).toBe(true);
  });

  it("keeps model-catalog truth per runtime — no fake unified discovery", () => {
    const models = (kind) => getAccountRuntimeCapabilities(kind).models;
    expect(models("CODEX_RUNTIME").strategy).toBe(
      MODEL_STRATEGIES.RUNTIME_WITH_FALLBACK,
    );
    expect(models("CLAUDE_RUNTIME").strategy).toBe(MODEL_STRATEGIES.CURATED);
    expect(models("CLAUDE_RUNTIME").dynamicDiscovery).toBe(false);
    for (const kind of [
      "OPENCODE_RUNTIME",
      "GROK_RUNTIME",
      "CURSOR_RUNTIME",
      "DEVIN_RUNTIME",
    ]) {
      expect(models(kind).strategy, kind).toBe(MODEL_STRATEGIES.RUNTIME);
      expect(models(kind).dynamicDiscovery, kind).toBe(true);
    }
    // Custom model ids are accepted everywhere; OpenCode constrains them
    // to the bound account provider's route.
    for (const kind of IMPLEMENTED) {
      expect(models(kind).customModel, kind).toBe(true);
    }
    expect(models("OPENCODE_RUNTIME").customModelConstraint).toBe(
      "PROVIDER_PREFIXED",
    );
  });

  it("records known auto-update behaviour and its managed suppression", () => {
    const update = (kind) =>
      getAccountRuntimeCapabilities(kind).capabilities.update;
    for (const kind of ["GROK_RUNTIME", "CURSOR_RUNTIME", "DEVIN_RUNTIME"]) {
      expect(update(kind).autoUpdate, kind).toBe(AUTO_UPDATE_STATES.MANAGED_OFF);
    }
    expect(update("CODEX_RUNTIME").autoUpdate).toBe(
      AUTO_UPDATE_STATES.NONE_OBSERVED,
    );
    // Install/update metadata exists but is never executable — no silent
    // install or upgrade path exists anywhere.
    for (const descriptor of listAccountRuntimeCapabilities()) {
      expect(descriptor.capabilities.install.executionEnabled).toBe(false);
      expect(descriptor.capabilities.update.executionEnabled).toBe(false);
    }
  });

  it("keeps manual-verification truth honest — only Devin is fully PASS", () => {
    const verification = (kind) =>
      getAccountRuntimeCapabilities(kind).verification;
    for (const field of [
      "realLoginE2E",
      "realModelCatalog",
      "realInferenceE2E",
      "adversarialPermissions",
    ]) {
      expect(verification("DEVIN_RUNTIME")[field]).toBe(
        VERIFICATION_STATES.PASS,
      );
    }
    for (const kind of IMPLEMENTED.filter((k) => k !== "DEVIN_RUNTIME")) {
      expect(
        verification(kind).realLoginE2E,
        `${kind} login E2E must stay PENDING until actually run`,
      ).toBe(VERIFICATION_STATES.PENDING);
      expect(
        verification(kind).realInferenceE2E,
        `${kind} inference E2E`,
      ).toBe(VERIFICATION_STATES.PENDING);
    }
    // Claude has no runtime model enumeration to verify.
    expect(verification("CLAUDE_RUNTIME").realModelCatalog).toBe(
      VERIFICATION_STATES.NOT_APPLICABLE,
    );
  });

  it("exposes the credential boundary and browser-login passthrough per profile", () => {
    const profile = (kind) => getAccountRuntimeCapabilities(kind).profile;
    expect(profile("CODEX_RUNTIME").credentialBoundary).toEqual(["CODEX_HOME"]);
    expect(profile("CLAUDE_RUNTIME").credentialBoundary).toEqual([
      "CLAUDE_CONFIG_DIR",
    ]);
    expect(profile("DEVIN_RUNTIME").credentialBoundary).toEqual([
      "USERPROFILE",
    ]);
    // Devin is the only runtime with a browser-login env override — the
    // host APPDATA/LOCALAPPDATA roots are restored for the login process
    // while USERPROFILE (credentials.toml) stays managed.
    expect(profile("DEVIN_RUNTIME").browserLoginEnvPassthrough).toEqual([
      "APPDATA",
      "LOCALAPPDATA",
    ]);
    for (const kind of IMPLEMENTED.filter((k) => k !== "DEVIN_RUNTIME")) {
      expect(profile(kind).browserLoginEnvPassthrough, kind).toEqual([]);
    }
    // A browser passthrough can never carry a credential-boundary key.
    for (const descriptor of listAccountRuntimeCapabilities()) {
      for (const key of descriptor.profile.browserLoginEnvPassthrough) {
        expect(
          descriptor.profile.credentialBoundary,
          `${descriptor.backendKind}: ${key} must not be a credential boundary`,
        ).not.toContain(key);
      }
    }
  });
});

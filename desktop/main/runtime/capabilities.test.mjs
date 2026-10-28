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
  STRUCTURED_OUTPUT_STRATEGIES,
  STRUCTURED_OUTPUT_VERIFICATIONS,
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
    // OpenCode's `auth login` is a console-input TUI (API-key entry for
    // Zen/Go) — the adapter launches it in a real console window like
    // Devin's login; there is no vendor authorize URL to surface.
    expect(interaction("OPENCODE_RUNTIME")).toBe(
      LOGIN_INTERACTIONS.VISIBLE_CONSOLE,
    );
    expect(interaction("GROK_RUNTIME")).toBe(LOGIN_INTERACTIONS.BROWSER);
    expect(interaction("CURSOR_RUNTIME")).toBe(LOGIN_INTERACTIONS.BROWSER);
    expect(interaction("DEVIN_RUNTIME")).toBe(
      LOGIN_INTERACTIONS.VISIBLE_CONSOLE,
    );
    // Only runtimes whose CLI cannot open a browser surface an auth URL.
    const surfaces = (kind) =>
      getAccountRuntimeCapabilities(kind).login.surfacesAuthorizationUrl;
    for (const kind of ["GROK_RUNTIME", "CURSOR_RUNTIME"]) {
      expect(surfaces(kind), kind).toBe(true);
    }
    for (const kind of [
      "CODEX_RUNTIME",
      "CLAUDE_RUNTIME",
      "OPENCODE_RUNTIME",
      "DEVIN_RUNTIME",
    ]) {
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

  it("classifies structured-output strategy per runtime — CLI mechanism only", () => {
    const so = (kind) => getAccountRuntimeCapabilities(kind).structuredOutput;
    // Native schema transports verified in `--help` on the installed
    // versions (codex-cli 0.154.0, claude 2.1.203, grok 1.0.41).
    for (const kind of [
      "CODEX_RUNTIME",
      "CLAUDE_RUNTIME",
      "GROK_RUNTIME",
    ]) {
      expect(so(kind).strategy, kind).toBe(
        STRUCTURED_OUTPUT_STRATEGIES.NATIVE_JSON_SCHEMA,
      );
      expect(so(kind).mechanism, kind).toBeTruthy();
    }
    // --output-format json / --format json envelopes are transport JSON,
    // not schema enforcement — these runtimes are prompt+validate only.
    for (const kind of [
      "OPENCODE_RUNTIME",
      "CURSOR_RUNTIME",
      "DEVIN_RUNTIME",
    ]) {
      expect(so(kind).strategy, kind).toBe(
        STRUCTURED_OUTPUT_STRATEGIES.PROMPT_AND_VALIDATE,
      );
      expect(so(kind).mechanism, kind).toBeNull();
    }
    expect(so("COPILOT_RUNTIME").strategy).toBe(
      STRUCTURED_OUTPUT_STRATEGIES.UNSUPPORTED,
    );
  });

  it("keeps structured-output verification honest — nothing is PASS without a managed trial", () => {
    for (const kind of IMPLEMENTED) {
      const so = getAccountRuntimeCapabilities(kind).structuredOutput;
      if (kind === "DEVIN_RUNTIME") {
        // Managed 9-trial probe on devin 3000.10.31: 9/9 first-pass
        // VALID under PROMPT_AND_VALIDATE.
        expect(so.verification, kind).toBe(STRUCTURED_OUTPUT_VERIFICATIONS.PASS);
        expect(so.verifiedRuntimeVersion, kind).toBe("3000.10.31");
        continue;
      }
      if (kind === "CODEX_RUNTIME") {
        // Re-verified on codex-cli 0.165.0 through production
        // `codex exec --output-schema`: all nine flat/job-like/resume-like
        // synthetic trials were first-pass VALID with no retries.
        expect(so.verification, kind).toBe(STRUCTURED_OUTPUT_VERIFICATIONS.PASS);
        expect(so.verifiedRuntimeVersion, kind).toBe("0.165.0");
        continue;
      }
      expect(so.verification, kind).toBe(
        STRUCTURED_OUTPUT_VERIFICATIONS.PENDING,
      );
      expect(so.verifiedRuntimeVersion, kind).toBeNull();
    }
    expect(
      getAccountRuntimeCapabilities("COPILOT_RUNTIME").structuredOutput
        .verification,
    ).toBe(STRUCTURED_OUTPUT_VERIFICATIONS.NOT_APPLICABLE);
  });

  it("reports streaming honestly — only managed-verified runtimes pass", () => {
    // DEVIN_RUNTIME earned PASS through a real managed E2E (devin -p
    // incremental stdout on 3000.10.31); CODEX_RUNTIME earned it through
    // the app-server delta channel on 0.165.0. The other four remain
    // PENDING — a documented stream mode without a managed delta run
    // never flips streaming to true.
    const VERIFIED_STREAMING = {
      DEVIN_RUNTIME: "3000.10.31",
      CODEX_RUNTIME: "0.165.0",
    };
    for (const kind of IMPLEMENTED) {
      const execution = getAccountRuntimeCapabilities(kind).execution;
      expect(execution.localOneShot, kind).toBe(true);
      expect(typeof execution.streamingMechanism, kind).toBe("string");
      expect(execution.streamingMechanism.length, kind).toBeGreaterThan(0);
      const bound = VERIFIED_STREAMING[kind];
      if (bound) {
        expect(execution.streaming, kind).toBe(true);
        expect(execution.streamingVerification, kind).toBe(
          VERIFICATION_STATES.PASS,
        );
        expect(execution.streamingVerifiedRuntimeVersion, kind).toBe(bound);
      } else {
        expect(execution.streaming, kind).toBe(false);
        expect(execution.streamingVerification, kind).toBe(
          VERIFICATION_STATES.PENDING,
        );
        // No verified run means no version binding — never a stale PASS.
        expect(execution.streamingVerifiedRuntimeVersion, kind).toBeNull();
      }
    }
    const copilot = getAccountRuntimeCapabilities("COPILOT_RUNTIME").execution;
    expect(copilot.localOneShot).toBe(false);
    expect(copilot.streaming).toBe(false);
    expect(copilot.streamingVerification).toBe(
      VERIFICATION_STATES.NOT_APPLICABLE,
    );
    expect(copilot.streamingMechanism).toBeNull();
    expect(copilot.streamingVerifiedRuntimeVersion).toBeNull();
  });

  it("certifies CODEX_RUNTIME 0.165.0 only — nearby and unknown versions stay unverified", () => {
    const caps = getAccountRuntimeCapabilities("CODEX_RUNTIME");
    expect(caps.execution.streaming).toBe(true);
    expect(caps.execution.streamingVerification).toBe(VERIFICATION_STATES.PASS);
    expect(caps.execution.streamingVerifiedRuntimeVersion).toBe("0.165.0");
    expect(caps.structuredOutput.strategy).toBe(
      STRUCTURED_OUTPUT_STRATEGIES.NATIVE_JSON_SCHEMA,
    );
    expect(caps.structuredOutput.verification).toBe(
      STRUCTURED_OUTPUT_VERIFICATIONS.PASS,
    );
    expect(caps.structuredOutput.verifiedRuntimeVersion).toBe("0.165.0");
    // Fail-closed exact equality. A previously certified build, a patch
    // neighbor, a newer build, and an unknown version are all unverified.
    for (const version of [
      "0.154.0",
      "0.159.0",
      "0.159.9",
      "0.160.0",
      "0.163.9",
      "0.164.1",
      "0.164.0",
      "0.161.0",
      "0.161.1",
      "",
      null,
    ]) {
      expect(
        version === caps.execution.streamingVerifiedRuntimeVersion,
        `streaming ${String(version)}`,
      ).toBe(false);
      expect(
        version === caps.structuredOutput.verifiedRuntimeVersion,
        `structured ${String(version)}`,
      ).toBe(false);
    }
  });
});

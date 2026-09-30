// @vitest-environment node
/**
 * Consolidation contract tests (backend side).
 *
 * Pins the unified surface the six ACCOUNT_LOGIN runtimes share:
 * - error-taxonomy parity between the desktop CONNECTION_OP_CODES and the
 *   backend AI_CONNECTION_OP_ERROR_CODES (the two enums must never drift)
 * - the provider/runtime matrix (valid pairs bind, invalid pairs refuse)
 * - the execution-seam contract: permission scopes and the pure readiness
 *   check the next phase's connectionId+model execution will gate on
 * - ACCOUNT_LOGIN never overlapping the API_KEY auth surface
 */
import { createRequire } from "node:module";
import path from "node:path";
import {
  AI_CONNECTION_OP_ERROR_CODES,
  AI_AUTH_TYPES,
  isSupportedAccountProviderForBackend,
  type AIBackendKind,
  type AIConnectionProvider,
} from "@/lib/ai/connections";
import {
  AI_PERMISSION_SCOPES,
  checkStreamingExecutionReadiness,
  checkTextOnlyExecutionReadiness,
  RUNTIME_LOGIN_INTERACTIONS,
  RUNTIME_PERMISSION_LEVELS,
  type AccountRuntimeCapabilities,
} from "@/lib/ai/runtime/capabilities";

const require = createRequire(import.meta.url);
const DESKTOP_RUNTIME = path.resolve(
  process.cwd(),
  "desktop/main/runtime",
);
const { CONNECTION_OP_CODES, PROVIDER_ADAPTERS } = require(
  path.join(DESKTOP_RUNTIME, "connection-service.js"),
);
const { getAccountRuntimeCapabilities } = require(
  path.join(DESKTOP_RUNTIME, "capabilities.js"),
);

describe("unified error taxonomy", () => {
  it("desktop and backend operation error codes are identical sets", () => {
    const desktop = new Set<string>(
      Object.values(CONNECTION_OP_CODES as Record<string, string>),
    );
    const backend = new Set<string>(
      Object.values(AI_CONNECTION_OP_ERROR_CODES),
    );
    for (const code of desktop) {
      expect(backend.has(code), `backend missing ${code}`).toBe(true);
    }
    for (const code of backend) {
      expect(desktop.has(code), `desktop missing ${code}`).toBe(true);
    }
  });

  it("covers the required taxonomy categories", () => {
    const codes = new Set<string>(
      Object.values(AI_CONNECTION_OP_ERROR_CODES),
    );
    for (const code of [
      // runtime availability
      "RUNTIME_NOT_INSTALLED",
      "RUNTIME_BROKEN",
      "RUNTIME_UPDATE_REQUIRED",
      // login lifecycle
      "LOGIN_ALREADY_IN_PROGRESS",
      "LOGIN_CANCELLED",
      "LOGIN_TIMEOUT",
      "LOGIN_FAILED",
      // auth state
      "AUTH_NOT_CONFIRMED",
      "REAUTH_REQUIRED",
      "AUTH_METHOD_UNVERIFIED",
      "UNSUPPORTED_AUTH_METHOD",
      "ACCOUNT_IDENTITY_CONFLICT",
      // provider/runtime matrix
      "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
      // model availability
      "MODEL_DISCOVERY_UNAVAILABLE",
      "MODEL_UNAVAILABLE",
      // execution boundary + inference
      "PERMISSION_BOUNDARY_NOT_READY",
      "INFERENCE_FAILED",
      // ticket/ownership + backend
      "INVALID_TICKET",
      "BACKEND_UNAVAILABLE",
    ]) {
      expect(codes.has(code), `taxonomy missing ${code}`).toBe(true);
    }
  });
});

describe("provider/runtime matrix", () => {
  const VALID: [AIBackendKind, AIConnectionProvider][] = [
    ["CODEX_RUNTIME", "OPENAI"],
    ["OPENCODE_RUNTIME", "OPENCODE_ZEN"],
    ["OPENCODE_RUNTIME", "OPENCODE_GO"],
    ["CLAUDE_RUNTIME", "ANTHROPIC"],
    ["GROK_RUNTIME", "XAI"],
    ["CURSOR_RUNTIME", "CURSOR"],
    ["DEVIN_RUNTIME", "DEVIN"],
  ];

  it("accepts the implemented ACCOUNT_LOGIN pairs", () => {
    for (const [backendKind, provider] of VALID) {
      expect(
        isSupportedAccountProviderForBackend(backendKind, provider),
        `${provider}+${backendKind}`,
      ).toBe(true);
    }
  });

  it("rejects invalid pairings including ChatGPT-via-OpenCode", () => {
    for (const [backendKind, provider] of [
      ["CLAUDE_RUNTIME", "OPENAI"],
      ["CODEX_RUNTIME", "ANTHROPIC"],
      ["DEVIN_RUNTIME", "CURSOR"],
      // OpenCode never hosts a ChatGPT account — removed product
      // semantics, not just a UI label.
      ["OPENCODE_RUNTIME", "OPENAI"],
      ["OPENCODE_RUNTIME", "OPENCODE"],
      ["OPENCODE_RUNTIME", "DEVIN"],
      ["GROK_RUNTIME", "OPENAI"],
      ["CURSOR_RUNTIME", "XAI"],
    ] as [AIBackendKind, AIConnectionProvider][]) {
      expect(
        isSupportedAccountProviderForBackend(backendKind, provider),
        `${provider}+${backendKind}`,
      ).toBe(false);
    }
    // Copilot-via-OpenCode stays a supported matrix entry but its
    // lifecycle is intentionally unimplemented (desktop adapter refuses).
    expect(
      isSupportedAccountProviderForBackend(
        "OPENCODE_RUNTIME",
        "GITHUB_COPILOT",
      ),
    ).toBe(true);
    expect(
      PROVIDER_ADAPTERS.OPENCODE_RUNTIME.forAccountProvider("GITHUB_COPILOT"),
    ).toBeNull();
  });
});

describe("capability descriptor parity", () => {
  it("the TS mirror and the desktop matrix agree on the six runtimes", () => {
    for (const backendKind of [
      "CODEX_RUNTIME",
      "CLAUDE_RUNTIME",
      "OPENCODE_RUNTIME",
      "GROK_RUNTIME",
      "CURSOR_RUNTIME",
      "DEVIN_RUNTIME",
    ]) {
      const descriptor: AccountRuntimeCapabilities =
        getAccountRuntimeCapabilities(backendKind);
      expect(descriptor.implemented).toBe(true);
      expect(descriptor.capabilities.accountLogin).toBe(true);
      expect(descriptor.capabilities.multiAccountIsolation).toBe(true);
      expect(descriptor.profile.credentialBoundary.length).toBeGreaterThan(0);
      expect(
        RUNTIME_PERMISSION_LEVELS as readonly string[],
      ).toContain(descriptor.permission.level);
      expect(
        RUNTIME_LOGIN_INTERACTIONS as readonly string[],
      ).toContain(descriptor.login.interaction);
    }
  });
});

describe("execution seam contract", () => {
  const cap = (kind: string) => getAccountRuntimeCapabilities(kind);

  it("declares TEXT_ONLY plus the reserved file scopes", () => {
    expect(AI_PERMISSION_SCOPES).toEqual([
      "TEXT_ONLY",
      "USER_SELECTED_FILES_READ",
      "USER_SELECTED_FILES_READ_WRITE",
    ]);
  });

  it("readies a CONNECTED connection on an implemented one-shot runtime", () => {
    for (const backendKind of [
      "CODEX_RUNTIME",
      "CLAUDE_RUNTIME",
      "OPENCODE_RUNTIME",
      "GROK_RUNTIME",
      "CURSOR_RUNTIME",
      "DEVIN_RUNTIME",
    ]) {
      expect(
        checkTextOnlyExecutionReadiness({
          capabilities: cap(backendKind),
          connectionStatus: "CONNECTED",
          permissionScope: "TEXT_ONLY",
        }),
        backendKind,
      ).toEqual({ ready: true });
    }
  });

  it("gates on auth state, runtime capability, and permission scope", () => {
    const codex = cap("CODEX_RUNTIME");
    expect(
      checkTextOnlyExecutionReadiness({
        capabilities: codex,
        connectionStatus: "REAUTH_REQUIRED",
        permissionScope: "TEXT_ONLY",
      }),
    ).toEqual({ ready: false, code: "REAUTH_REQUIRED" });
    expect(
      checkTextOnlyExecutionReadiness({
        capabilities: codex,
        connectionStatus: "DISCONNECTED",
        permissionScope: "TEXT_ONLY",
      }),
    ).toEqual({ ready: false, code: "AUTH_NOT_CONFIRMED" });
    expect(
      checkTextOnlyExecutionReadiness({
        capabilities: codex,
        connectionStatus: "CONNECTED",
        permissionScope: "USER_SELECTED_FILES_READ",
      }),
    ).toEqual({ ready: false, code: "PERMISSION_BOUNDARY_NOT_READY" });
    expect(
      checkTextOnlyExecutionReadiness({
        capabilities: cap("COPILOT_RUNTIME"),
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
      }),
    ).toEqual({ ready: false, code: "UNSUPPORTED_BACKEND" });
    expect(
      checkTextOnlyExecutionReadiness({
        capabilities: null,
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
      }),
    ).toEqual({ ready: false, code: "UNSUPPORTED_BACKEND" });
  });

  it("gates streaming on real verification — PENDING is not permission", () => {
    // The desktop matrix is the source of truth: the four runtimes that
    // never completed a managed streaming run fail closed, while Devin's
    // and Codex's verified PASSes are bound to the probed versions.
    for (const backendKind of [
      "CLAUDE_RUNTIME",
      "OPENCODE_RUNTIME",
      "GROK_RUNTIME",
      "CURSOR_RUNTIME",
    ]) {
      expect(
        checkStreamingExecutionReadiness({
          capabilities: cap(backendKind),
          connectionStatus: "CONNECTED",
          permissionScope: "TEXT_ONLY",
        }),
        backendKind,
      ).toEqual({ ready: false, code: "STREAMING_NOT_SUPPORTED" });
    }
    // Codex passed managed delta verification via `codex app-server`
    // item/agentMessage/delta on 0.154.0 — same version-bound contract.
    expect(
      checkStreamingExecutionReadiness({
        capabilities: cap("CODEX_RUNTIME"),
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
        runtimeVersion: "0.154.0",
      }),
    ).toEqual({ ready: true });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: cap("CODEX_RUNTIME"),
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
        runtimeVersion: "0.155.0",
      }),
    ).toEqual({ ready: false, code: "STREAMING_NOT_VERIFIED" });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: cap("CODEX_RUNTIME"),
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
      }),
    ).toEqual({ ready: false, code: "STREAMING_NOT_VERIFIED" });
    // Devin passed managed delta verification on 3000.10.31: ready only
    // when the installed binary matches the verified version.
    expect(
      checkStreamingExecutionReadiness({
        capabilities: cap("DEVIN_RUNTIME"),
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
        runtimeVersion: "3000.10.31",
      }),
    ).toEqual({ ready: true });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: cap("DEVIN_RUNTIME"),
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
        runtimeVersion: "3000.10.32",
      }),
    ).toEqual({ ready: false, code: "STREAMING_NOT_VERIFIED" });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: cap("DEVIN_RUNTIME"),
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
      }),
    ).toEqual({ ready: false, code: "STREAMING_NOT_VERIFIED" });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: cap("COPILOT_RUNTIME"),
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
      }),
    ).toEqual({ ready: false, code: "UNSUPPORTED_BACKEND" });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: null,
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
      }),
    ).toEqual({ ready: false, code: "UNSUPPORTED_BACKEND" });
  });

  it("streaming readiness gates on scope and auth state once verified", () => {
    const streamingCapable = {
      ...cap("CODEX_RUNTIME"),
      execution: {
        ...cap("CODEX_RUNTIME").execution,
        streaming: true,
        streamingVerification: "PASS",
        streamingVerifiedRuntimeVersion: "0.154.0",
      },
    };
    expect(
      checkStreamingExecutionReadiness({
        capabilities: streamingCapable,
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
        runtimeVersion: "0.154.0",
      }),
    ).toEqual({ ready: true });
    // The PASS is bound to the probed version — drift or absence is never
    // a silent accept.
    expect(
      checkStreamingExecutionReadiness({
        capabilities: streamingCapable,
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
        runtimeVersion: "0.155.0",
      }),
    ).toEqual({ ready: false, code: "STREAMING_NOT_VERIFIED" });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: streamingCapable,
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
      }),
    ).toEqual({ ready: false, code: "STREAMING_NOT_VERIFIED" });
    // streaming:true without a PASS verdict is unverified, not supported.
    const pendingCapable = {
      ...streamingCapable,
      execution: {
        ...streamingCapable.execution,
        streamingVerification: "PENDING",
      },
    };
    expect(
      checkStreamingExecutionReadiness({
        capabilities: pendingCapable,
        connectionStatus: "CONNECTED",
        permissionScope: "TEXT_ONLY",
        runtimeVersion: "0.154.0",
      }),
    ).toEqual({ ready: false, code: "STREAMING_NOT_VERIFIED" });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: streamingCapable,
        connectionStatus: "REAUTH_REQUIRED",
        permissionScope: "TEXT_ONLY",
        runtimeVersion: "0.154.0",
      }),
    ).toEqual({ ready: false, code: "REAUTH_REQUIRED" });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: streamingCapable,
        connectionStatus: "DISCONNECTED",
        permissionScope: "TEXT_ONLY",
        runtimeVersion: "0.154.0",
      }),
    ).toEqual({ ready: false, code: "AUTH_NOT_CONFIRMED" });
    expect(
      checkStreamingExecutionReadiness({
        capabilities: streamingCapable,
        connectionStatus: "CONNECTED",
        permissionScope: "USER_SELECTED_FILES_READ",
        runtimeVersion: "0.154.0",
      }),
    ).toEqual({ ready: false, code: "PERMISSION_BOUNDARY_NOT_READY" });
  });
});

describe("auth-type isolation", () => {
  it("ACCOUNT_LOGIN never shares the API_KEY surface", () => {
    expect(AI_AUTH_TYPES).toContain("ACCOUNT_LOGIN");
    expect(AI_AUTH_TYPES).toContain("API_KEY");
    // The operation error taxonomy has no credential-rotation codes —
    // ACCOUNT_LOGIN can never degrade into an API-key flow.
    for (const code of Object.values(AI_CONNECTION_OP_ERROR_CODES)) {
      expect(code).not.toMatch(/API_?KEY|SECRET|TOKEN_(?:ROTAT|STOR)/i);
    }
  });
});

// @vitest-environment node
/**
 * Phase C runtime/profile contract (backend side).
 *
 * Covers the pure seam only: opaque ref validation, installation/auth state
 * enums, and resolveRuntimeProfile over AIConnection rows. No filesystem,
 * no provider login, no model calls.
 */
import {
  RUNTIME_AUTH_STATES,
  RUNTIME_INSTALLATION_STATES,
  RUNTIME_PROFILE_REF_PATTERN,
  isRuntimeProfileRef,
  resolveRuntimeProfile,
} from "@/lib/ai/runtime/contract";
import {
  AI_RESOLUTION_ERROR_CODES,
  AIResolutionError,
} from "@/lib/ai/connections";

const VALID_REF = "rp_123e4567-e89b-42d3-a456-426614174000";

describe("runtime profile ref contract", () => {
  it("accepts only rp_<uuid> refs", () => {
    expect(isRuntimeProfileRef(VALID_REF)).toBe(true);
    expect(RUNTIME_PROFILE_REF_PATTERN.test(VALID_REF)).toBe(true);
    for (const bad of [
      "..",
      "rp_not-a-uuid",
      "rp_123",
      "C:\\Users\\x\\rp_123e4567-e89b-42d3-a456-426614174000",
      "/abs/path",
      "\\\\server\\share",
      "",
      null,
      undefined,
      7,
    ]) {
      expect(isRuntimeProfileRef(bad)).toBe(false);
    }
  });

  it("declares the runtime install/auth state machines", () => {
    expect(RUNTIME_INSTALLATION_STATES).toEqual([
      "NOT_INSTALLED",
      "READY",
      "UPDATE_AVAILABLE",
      "BROKEN",
    ]);
    expect(RUNTIME_AUTH_STATES).toContain("REAUTH_REQUIRED");
    // Runtime state and AIConnection.status are separate state machines —
    // READY + REAUTH_REQUIRED can and do coexist.
    expect(RUNTIME_INSTALLATION_STATES).not.toContain("CONNECTED");
  });
});

describe("resolveRuntimeProfile", () => {
  it("resolves a valid connection to its opaque profile binding", () => {
    const resolved = resolveRuntimeProfile({
      id: "conn-1",
      backendKind: "CODEX_RUNTIME",
      runtimeProfileRef: VALID_REF,
    });
    expect(resolved).toEqual({
      connectionId: "conn-1",
      backendKind: "CODEX_RUNTIME",
      runtimeProfileRef: VALID_REF,
    });
    // The result carries no filesystem path — ever.
    expect(JSON.stringify(resolved)).not.toMatch(/[A-Za-z]:\\/);
    expect(JSON.stringify(resolved)).not.toContain("/");
  });

  it("fails RUNTIME_NOT_AVAILABLE when no profile is provisioned", () => {
    expect(() =>
      resolveRuntimeProfile({
        id: "conn-2",
        backendKind: "CLAUDE_RUNTIME",
        runtimeProfileRef: null,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: AI_RESOLUTION_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      }) as Error,
    );
  });

  it("fails on an unknown backendKind before checking the ref", () => {
    try {
      resolveRuntimeProfile({
        id: "conn-3",
        backendKind: "GEMINI_RUNTIME",
        runtimeProfileRef: VALID_REF,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AIResolutionError);
      expect((error as AIResolutionError).code).toBe(
        AI_RESOLUTION_ERROR_CODES.RUNTIME_NOT_AVAILABLE,
      );
    }
  });

  it("fails on a malformed ref rather than trusting the DB string", () => {
    expect(() =>
      resolveRuntimeProfile({
        id: "conn-4",
        backendKind: "DEVIN_RUNTIME",
        runtimeProfileRef: "C:\\Users\\someone",
      }),
    ).toThrow(AIResolutionError);
  });
});

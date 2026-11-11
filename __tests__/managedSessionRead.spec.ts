// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHostedSessionProvider, HostedManagedClient } from "@/lib/ai/managed-client";
import { agentErrorCopy, categorizeAgentErrorCode } from "@/lib/agent/chatErrorUx";
import { formatAgentStreamError } from "@/lib/agent/errors";
import { readAgentChatError } from "@/lib/agent/chatTransport";
import { AIBusinessError } from "@/lib/ai/connections";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Managed session read failures", () => {
  function broker(fetchImpl: typeof fetch) {
    vi.stubEnv("VOCATRYA_HOSTED_SESSION_URL", "http://127.0.0.1:1234");
    vi.stubEnv("VOCATRYA_DESKTOP_INTERNAL_TOKEN", "synthetic-internal");
    vi.stubGlobal("fetch", fetchImpl);
    return new DesktopHostedSessionProvider();
  }

  it.each(["network", "timeout", "storage", "malformed", "json"])("keeps %s failures distinct from an absent session", async failure => {
    const provider = broker(vi.fn(async () => {
      if (failure === "network") throw new Error("private transport detail");
      if (failure === "timeout") throw new DOMException("private timeout", "TimeoutError");
      if (failure === "json") return new Response("invalid json");
      return failure === "storage" ? Response.json({}, { status: 400 }) : Response.json({ token: "invalid" });
    }));
    await expect(provider.tokenForLocalUser("local")).rejects.toMatchObject({ code: "MANAGED_RUNTIME_UNAVAILABLE" });
  });

  it("reads the broker again after a Key replacement and never caches the token", async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({}, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ token: "a".repeat(43) }));
    const provider = broker(fetcher);
    expect(await provider.tokenForLocalUser("local")).toBeNull();
    expect(await provider.tokenForLocalUser("local")).toBe("a".repeat(43));
    expect(fetcher.mock.calls.every(([, init]) => init.cache === "no-store")).toBe(true);
  });

  it("clears only the rejected token on an authoritative hosted 401", async () => {
    const sessions = { tokenForLocalUser: async () => "a".repeat(43), clearSession: vi.fn(async () => {}) };
    const client = new HostedManagedClient(sessions, "http://127.0.0.1:1234", async () => Response.json({ code: "MANAGED_AUTH_REQUIRED" }, { status: 401 }));
    await expect(client.identity("local")).rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" });
    expect(sessions.clearSession).toHaveBeenCalledWith("local", "a".repeat(43));
  });

  it.each(["identity", "catalog", "entitlement", "usage"] as const)("bypasses fetch caches for %s", async method => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ code: "MANAGED_AUTH_REQUIRED" }, { status: 401 }));
    const client = new HostedManagedClient({ tokenForLocalUser: async () => "a".repeat(43) }, "http://127.0.0.1:1234", fetcher);
    await expect(client[method]("local")).rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" });
    expect(fetcher.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });
});

describe("Managed errors through the chat stream and localized presentation", () => {
  it.each([
    ["QUOTA_EXCEEDED", "managedQuota", "settings"],
    ["NOT_ENTITLED", "managedEntitlement", "settings"],
    ["MODEL_NOT_ALLOWED", "managedEntitlement", "settings"],
    ["MANAGED_AUTH_REQUIRED", "managedAuth", "settings"],
    ["MANAGED_RUNTIME_UNAVAILABLE", "managedUnavailable", "settings"],
    ["GATEWAY_AUTH", "managedUnavailable", "settings"],
    ["INVOCATION_STATUS_UNKNOWN", "managedPending", null],
  ] as const)("preserves %s and gives actionable copy", (code, key, action) => {
    const wire = formatAgentStreamError(new AIBusinessError(code, "private detail"));
    const parsed = readAgentChatError(new Error(wire));
    expect(parsed.code).toBe(code);
    const copy = agentErrorCopy(categorizeAgentErrorCode(parsed.code));
    expect(copy).toMatchObject({ bodyKey: `agent.errors.${key}`, action });
    expect(wire).not.toContain("private detail");
  });
});

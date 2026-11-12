// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopHostedSessionProvider, HostedManagedClient } from "@/lib/ai/managed-client";
import { agentErrorCopy, categorizeAgentErrorCode } from "@/lib/agent/chatErrorUx";
import { formatAgentStreamError } from "@/lib/agent/errors";
import { readAgentChatError } from "@/lib/agent/chatTransport";
import { AIBusinessError } from "@/lib/ai/connections";

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Managed session read failures", () => {
  function clockedTimeouts() {
    vi.useFakeTimers();
    return vi.spyOn(AbortSignal, "timeout").mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("deadline", "TimeoutError")), ms);
      return controller.signal;
    });
  }
  const token = "a".repeat(43);
  const operation = (provider: DesktopHostedSessionProvider, method: string) => method === "read" ? provider.tokenForLocalUser("local") : method === "save" ? provider.saveSession("local", token) : provider.clearSession("local", token);

  it.each(["read", "save", "clear"])("allows a slow %s beyond 5 seconds but within its broker budget", async method => {
    const deadlines = clockedTimeouts();
    const provider = broker(vi.fn((_input, init) => new Promise<Response>((resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      setTimeout(() => resolve(Response.json({ token })), 6000);
    })));
    const pending = operation(provider, method);
    await vi.advanceTimersByTimeAsync(6000);
    expect(await pending).toBe(method === "read" ? token : undefined);
    expect(deadlines).toHaveBeenCalledWith(20000);
  });

  it.each(["read", "save", "clear"])("bounds a stalled %s and permits a later read without clearing credentials", async method => {
    clockedTimeouts();
    const fetcher = vi.fn<typeof fetch>((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const provider = broker(fetcher);
    const failure = expect(operation(provider, method)).rejects.toMatchObject({ code: "MANAGED_RUNTIME_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(20000);
    await failure;
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValueOnce(Response.json({ token }));
    expect(await provider.tokenForLocalUser("local")).toBe(token);
  });

  it("starts the Hosted deadline after the slow broker, then still bounds Hosted failure", async () => {
    const deadlines = clockedTimeouts();
    const provider = broker(vi.fn(() => new Promise<Response>(resolve => setTimeout(() => resolve(Response.json({ token })), 6000))));
    const hosted = vi.fn<typeof fetch>(async (_input, init) => {
      init!.signal!.throwIfAborted();
      return Response.json({ hostedUserId: "hosted-local" });
    });
    const client = new HostedManagedClient(provider, "http://127.0.0.1:4321", hosted);
    const first = client.identity("local");
    await vi.advanceTimersByTimeAsync(6000);
    expect(await first).toBe("hosted-local");
    expect(deadlines.mock.calls.map(([ms]) => ms)).toEqual([20000, 5000]);
    hosted.mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const failure = expect(client.identity("local")).rejects.toMatchObject({ code: "GATEWAY_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(11000);
    await failure;
  });

  it("honors caller cancellation during credential acquisition without a Hosted call", async () => {
    clockedTimeouts();
    const provider = broker(vi.fn(() => new Promise<Response>(resolve => setTimeout(() => resolve(Response.json({ token })), 6000))));
    const hosted = vi.fn<typeof fetch>();
    const client = new HostedManagedClient(provider, "http://127.0.0.1:4321", hosted);
    const controller = new AbortController();
    const failure = expect(client.bind("local", { modelKey: "fast", business: "CHAT", resourceKey: "local" }, controller.signal)).rejects.toMatchObject({ code: "MANAGED_RUNTIME_UNAVAILABLE" });
    controller.abort();
    await vi.advanceTimersByTimeAsync(6000);
    await failure;
    expect(hosted).not.toHaveBeenCalled();
  });

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

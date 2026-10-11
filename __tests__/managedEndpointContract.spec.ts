// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TRUSTED_HOSTED_MANAGED_ENDPOINT, HostedManagedClient, DesktopHostedSessionProvider } from "@/lib/ai/managed-client";

const CANONICAL = "https://managed.shucubed.xyz";
const SUPERSEDED = "https://managed.vocatrya.com";
const sessions = { tokenForLocalUser: async () => "a".repeat(43) };
const invocation = { bindingId: "binding-1", modelKey: "vocatrya-fast", prompt: "hello", operationId: "op-1", invocationKey: "op-1:0", attemptIndex: 0 };
const provenance = { schemaVersion: 1 as const, managedBindingId: "binding-1", requestedModelKey: "vocatrya-fast", upstreamModelId: "vendor-v1", mappingRevision: "mapping-1", adapterContractRevision: "managed-gateway-v1" };
const catalogBody = { revision: "catalog-1", models: [{ modelKey: "vocatrya-fast", displayName: "Fast", enabled: true, available: true, capabilities: { text: true, streaming: true, structuredOutput: true, tools: false } }] };

function recordingFetch(handler: (request: Request) => Promise<Response> | Response) {
  const requests: Request[] = [];
  const impl: typeof fetch = async (url, init) => {
    const request = new Request(String(url), init);
    requests.push(request.clone());
    return handler(request);
  };
  return { requests, impl };
}

beforeEach(() => { delete process.env.VOCATRYA_DEV_HOSTED_ENDPOINT; });
afterEach(() => { vi.unstubAllEnvs(); });

describe("BETA2_MANAGED_ENDPOINT_SHUCUBED contract", () => {
  it("pins the canonical hosted endpoint to the shucubed.xyz subdomain", () => {
    expect(TRUSTED_HOSTED_MANAGED_ENDPOINT).toBe(CANONICAL);
    expect(TRUSTED_HOSTED_MANAGED_ENDPOINT).not.toContain("vocatrya.com");
  });
  it("sends every managed route to the canonical origin with no superseded-domain request", async () => {
    const { requests, impl } = recordingFetch(request => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/session") return Response.json({ hostedUserId: "hosted-a" });
      if (path === "/v1/catalog") return Response.json(catalogBody);
      if (path === "/v1/bindings") return Response.json(provenance);
      if (path === "/v1/text") return Response.json({ text: "hi", model: "vocatrya-fast", provenance, structuredStrategy: null, stopReason: null });
      return Response.json({ code: "GATEWAY_RESPONSE" }, { status: 500 });
    });
    const client = new HostedManagedClient(sessions, undefined, impl);
    expect(await client.identity("local-a")).toBe("hosted-a");
    expect((await client.catalog("local-a")).models[0].modelKey).toBe("vocatrya-fast");
    expect(await client.bind("local-a", { modelKey: "vocatrya-fast", business: "RESUME", resourceKey: "r1" })).toEqual(provenance);
    expect((await client.generateText("local-a", invocation)).text).toBe("hi");
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(["/v1/session", "/v1/catalog", "/v1/bindings", "/v1/text"]);
    for (const request of requests) {
      expect(new URL(request.url).origin).toBe(CANONICAL);
      expect(request.url).not.toContain("vocatrya.com");
      expect(request.redirect).toBe("error");
      expect(request.headers.get("authorization")).toBe(`Bearer ${"a".repeat(43)}`);
    }
  });
  it("keeps the durable invocation identity unchanged by the endpoint revision", async () => {
    const { requests, impl } = recordingFetch(() => Response.json({ text: "hi", model: "vocatrya-fast", provenance, structuredStrategy: null, stopReason: null }));
    const client = new HostedManagedClient(sessions, undefined, impl);
    await client.generateText("local-a", invocation);
    expect(await requests[0].json()).toEqual(invocation);
  });
  it("streams and structured output keep their wire paths on the canonical origin", async () => {
    const { requests, impl } = recordingFetch(request => {
      const path = new URL(request.url).pathname;
      if (path === "/v1/stream") return new Response('{"type":"text-delta","delta":"hi"}\n' + JSON.stringify({ type: "completed", model: "vocatrya-fast", provenance }) + "\n", { headers: { "content-type": "application/x-ndjson" } });
      if (path === "/v1/structured") return Response.json({ text: "{}", model: "vocatrya-fast", provenance, structuredStrategy: "PROMPT_AND_VALIDATE", stopReason: null });
      return Response.json({ code: "GATEWAY_RESPONSE" }, { status: 500 });
    });
    const client = new HostedManagedClient(sessions, undefined, impl);
    const events = [];
    for await (const event of client.streamText("local-a", invocation)) events.push(event);
    expect(events.map(event => event.type)).toEqual(["text-delta", "completed"]);
    expect((await client.generateText("local-a", { ...invocation, invocationKey: "op-1:1", attemptIndex: 1, structuredOutput: { schema: {}, schemaName: "s" } })).structuredStrategy).toBe("PROMPT_AND_VALIDATE");
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(["/v1/stream", "/v1/structured"]);
  });
  it("ignores VOCATRYA_DEV_HOSTED_ENDPOINT in production and still uses the canonical endpoint", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("VOCATRYA_DEV_HOSTED_ENDPOINT", SUPERSEDED);
    const { requests, impl } = recordingFetch(() => Response.json({ hostedUserId: "hosted-a" }));
    const client = new HostedManagedClient(sessions, undefined, impl);
    await client.identity("local-a");
    expect(new URL(requests[0].url).origin).toBe(CANONICAL);
  });
  it("honours the controlled loopback dev override only outside production", async () => {
    vi.stubEnv("VOCATRYA_DEV_HOSTED_ENDPOINT", "http://127.0.0.1:8787");
    const { requests, impl } = recordingFetch(() => Response.json({ hostedUserId: "hosted-a" }));
    const client = new HostedManagedClient(sessions, undefined, impl);
    await client.identity("local-a");
    expect(new URL(requests[0].url).origin).toBe("http://127.0.0.1:8787");
  });
  it.each(["network", "dns", "tls"])("fails closed on %s failure with no fallback origin", async () => {
    const { requests, impl } = recordingFetch(() => { throw new TypeError("fetch failed"); });
    const client = new HostedManagedClient(sessions, undefined, impl);
    await expect(client.identity("local-a")).rejects.toMatchObject({ code: "MANAGED_RUNTIME_UNAVAILABLE" });
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0].url).origin).toBe(CANONICAL);
  });
  it("fails closed on an unauthenticated or unknown hosted response", async () => {
    for (const response of [Response.json({ code: "SOME_UNKNOWN" }, { status: 401 }), new Response("not json", { status: 502 })]) {
      const { impl } = recordingFetch(() => response);
      const client = new HostedManagedClient(sessions, undefined, impl);
      await expect(client.identity("local-a")).rejects.toMatchObject({ code: "MANAGED_RUNTIME_UNAVAILABLE" });
    }
  });
  it("requires a hosted session before any request leaves the desktop boundary", async () => {
    vi.stubEnv("VOCATRYA_HOSTED_SESSION_URL", "");
    const { requests, impl } = recordingFetch(() => Response.json({}));
    const client = new HostedManagedClient(new DesktopHostedSessionProvider(), undefined, impl);
    await expect(client.identity("local-a")).rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" });
    expect(requests).toHaveLength(0);
  });
  it("session broker refuses a public origin so tokens can never leak to the endpoint", async () => {
    vi.stubEnv("VOCATRYA_HOSTED_SESSION_URL", CANONICAL);
    vi.stubEnv("VOCATRYA_DESKTOP_INTERNAL_TOKEN", "internal");
    const provider = new DesktopHostedSessionProvider();
    await expect(provider.tokenForLocalUser("local-a")).rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" });
    vi.stubEnv("VOCATRYA_HOSTED_SESSION_URL", "http://127.0.0.1:9999");
    expect(await provider.tokenForLocalUser("local-a")).toBeNull();
  });
});

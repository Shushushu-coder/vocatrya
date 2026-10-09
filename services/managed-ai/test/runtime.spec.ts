import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelCatalog, validateCatalog, type ManagedCatalog } from "../src/catalog";
import { HostedStore, provenance } from "../src/store";
import { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } from "../src/gateway";
import { HostedManagedService } from "../src/service";
import { createHostedServer } from "../src/http";
import { PlanAuthority } from "../src/plan";
import { catalogConfig, planConfig, provision, secret } from "./helpers";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function store() { const result = new HostedStore(":memory:"); cleanup.push(() => result.close()); return result; }
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No address");
  return `http://127.0.0.1:${address.port}`;
}
function gateway(fetchImpl: typeof fetch = fetch, timeoutMs = 1000) { return new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret, timeoutMs }, fetchImpl); }
function fakeText(model = "vendor-v1", content = "hello"): Response { return Response.json({ model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } }); }
function fixture(fetchImpl: typeof fetch = async () => fakeText()) {
  const db = store(); const token = db.issueSession("hosted-a", Date.now() + 60000);
  const catalog = new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES);
  const service = new HostedManagedService(db, catalog, new PlanAuthority(planConfig()), gateway(fetchImpl));
  return { db, token, catalog, service };
}
async function call(service: HostedManagedService, token: string | null, path: string, body?: unknown) {
  return service.handle(new Request(`https://hosted.example/v1/${path}`, { method: body === undefined ? "GET" : "POST",
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }));
}
async function bind(service: HostedManagedService, token: string, resourceKey = "resource-1") {
  const response = await call(service, token, "bindings", { modelKey: "vocatrya-fast", business: "RESUME", resourceKey });
  expect(response.status).toBe(200); return response.json();
}
function invokeBody(bindingId: string, extra: Record<string, unknown> = {}) {
  return { bindingId, modelKey: "vocatrya-fast", prompt: "hello", operationId: "op-1", invocationKey: "op-1:0", attemptIndex: 0, ...extra };
}

describe("Hosted identity and immutable authority", () => {
  it("derives hosted identity only from valid server-issued sessions, rejects missing, expired and invalid", async () => {
    const { db, token, service } = fixture();
    expect(await (await call(service, token, "session")).json()).toEqual({ hostedUserId: "hosted-a" });
    for (const invalid of [null, "forged", "a".repeat(43)]) expect((await call(service, invalid, "session")).status).toBe(401);
    const expiring = db.issueSession("hosted-a", Date.now() + 10);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect((await call(service, expiring, "session")).status).toBe(401);
    db.revokeSession(token); expect((await call(service, token, "session")).status).toBe(401);
  });
  it("rejects forged local identity and foreign binding even with a valid hosted session", async () => {
    const { db, token, service } = fixture(); const snapshot = await bind(service, token);
    expect((await call(service, token, "bindings", { userId: "victim", modelKey: "vocatrya-fast", business: "RESUME", resourceKey: "x" })).status).toBe(400);
    const other = db.issueSession("hosted-b", Date.now() + 60000);
    const response = await call(service, other, "text", invokeBody(snapshot.managedBindingId));
    expect(await response.json()).toEqual({ code: "MANAGED_BINDING_UNAVAILABLE", message: "MANAGED_BINDING_UNAVAILABLE" });
    expect((await call(service, token, "text", invokeBody(snapshot.managedBindingId, { upstreamModelId: "malicious" }))).status).toBe(400);
  });
  it("freezes upstream mapping, aliases and revisions across catalog updates and process restarts", () => {
    const directory = mkdtempSync(join(tmpdir(), "m3-store-")); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, "hosted.db");
    const db = new HostedStore(file);
    db.issueSession("a", Date.now() + 60000);
    const binding = db.createBinding("a", "RESUME", "frozen", catalogConfig().models[0]);
    db.close();
    const reopened = new HostedStore(file); cleanup.push(() => reopened.close());
    const loaded = reopened.binding(binding.id, "a");
    expect(loaded).toMatchObject({ upstreamModelId: "vendor-v1", mappingRevision: "mapping-1", adapterContractRevision: "managed-gateway-v1" });
    const raw = new DatabaseSync(file); cleanup.push(() => raw.close());
    expect(() => raw.prepare("UPDATE ManagedAiBinding SET modelKey='x' WHERE id=?").run(binding.id)).toThrow();
  });
  it("executes old binding with exact historical mapping after catalog update; new binding uses new mapping", async () => {
    const { db, token, service } = fixture(); provision(db, "hosted-a", "ACTIVE");
    const old = await bind(service, token, "old");
    const changed = catalogConfig(); changed.revision = "catalog-2"; changed.models[0].upstreamModelId = "vendor-v2"; changed.models[0].mappingRevision = "mapping-2";
    const models: string[] = [];
    const runtime = gateway(async (_url, init) => { const model = JSON.parse(String(init?.body)).model; models.push(model); return fakeText(model); });
    const nextService = new HostedManagedService(db, new ModelCatalog(changed, VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(planConfig()), runtime);
    const next = await bind(nextService, token, "new");
    for (const [snapshot, op] of [[old, "op-old"], [next, "op-new"]] as const) {
      const result = await (await call(nextService, token, "text", invokeBody(snapshot.managedBindingId, { operationId: op, invocationKey: `${op}:0` }))).json();
      expect(result.provenance).toEqual(snapshot);
    }
    expect(models).toEqual(["vendor-v1", "vendor-v2"]);
  });
});

describe("Versioned catalog", () => {
  it("rejects duplicate keys, bad revision, limits, capabilities, defaults, upstream mappings and tools", () => {
    const variants = [
      (c: ManagedCatalog) => c.models.push(c.models[0]), (c: ManagedCatalog) => { c.models[0].mappingRevision = " "; },
      (c: ManagedCatalog) => { c.models[0].upstreamModelId = ""; }, (c: ManagedCatalog) => { c.models[0].maxInputTokens = -1; },
      (c: ManagedCatalog) => { c.defaultModelKey = "unknown"; }, (c: ManagedCatalog) => { c.models[0].capabilities.tools = true; },
      (c: ManagedCatalog) => { c.models[0].capabilities.text = "true" as unknown as boolean; },
    ];
    for (const change of variants) { const c = catalogConfig(); change(c); expect(() => validateCatalog(c)).toThrow(); }
  });
  it("fails closed for kill switch, disabled/unknown model and unverified capabilities", async () => {
    const c = catalogConfig(); c.managedAiEnabled = false;
    expect(() => new ModelCatalog(c, VERIFIED_GATEWAY_CAPABILITIES).resolve("vocatrya-fast")).toThrow(expect.objectContaining({ code: "MANAGED_AI_DISABLED" }));
    c.managedAiEnabled = true; c.models[0].enabled = false;
    expect(() => new ModelCatalog(c, VERIFIED_GATEWAY_CAPABILITIES).resolve("vocatrya-fast")).toThrow(expect.objectContaining({ code: "MODEL_DISABLED" }));
    c.models[0].enabled = true;
    const catalog = new ModelCatalog(c, { ...VERIFIED_GATEWAY_CAPABILITIES, streaming: false });
    expect(() => catalog.resolve("vocatrya-fast", "streaming")).toThrow(expect.objectContaining({ code: "CAPABILITY_UNSUPPORTED" }));
    expect(() => catalog.resolve("unknown")).toThrow(expect.objectContaining({ code: "MANAGED_BINDING_UNAVAILABLE" }));
    expect(JSON.stringify(catalog.dto())).not.toMatch(/upstreamModelId|vendor-v1|mappingRevision|gateway|apiKey/);
    let calls = 0;
    const db = store(); const token = db.issueSession("hosted-a", Date.now() + 60000);
    provision(db, "hosted-a", "ACTIVE");
    const plans = new PlanAuthority(planConfig());
    const enabled = new HostedManagedService(db, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), plans, gateway(async () => { calls += 1; return fakeText(); }));
    const snapshot = await bind(enabled, token);
    const disabled = new HostedManagedService(db, new ModelCatalog(catalogConfig({ managedAiEnabled: false }), VERIFIED_GATEWAY_CAPABILITIES), plans, gateway(async () => { calls += 1; return fakeText(); }));
    expect(await (await call(disabled, token, "text", invokeBody(snapshot.managedBindingId))).json()).toMatchObject({ code: "MANAGED_AI_DISABLED" });
    expect(calls).toBe(0);
  });
  it("rejects new executions of historical bindings when model is disabled", async () => {
    const { db, token, service } = fixture(); const snapshot = await bind(service, token);
    const c = catalogConfig(); c.models[0].enabled = false;
    const disabled = new HostedManagedService(db, new ModelCatalog(c, VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(planConfig()), gateway());
    expect(await (await call(disabled, token, "text", invokeBody(snapshot.managedBindingId))).json()).toMatchObject({ code: "MODEL_DISABLED" });
  });
});

describe("Gateway model alias verification", () => {
  it("accepts only explicitly frozen model aliases", async () => {
    const db = store(); db.issueSession("a", Date.now() + 60000);
    const binding = db.createBinding("a", "RESUME", "alias", { ...catalogConfig().models[0], allowedModelAliases: ["verified-alias"] });
    const input = { bindingId: binding.id, modelKey: binding.modelKey, prompt: "x", operationId: "op-1", invocationKey: "op-1:0", attemptIndex: 0 };
    expect((await gateway(async () => fakeText("verified-alias")).generateText(binding, input)).model).toBe(binding.modelKey);
    await expect(gateway(async () => fakeText("unlisted-alias")).generateText(binding, input)).rejects.toMatchObject({ code: "GATEWAY_RESPONSE" });
  });
});

describe("Synthetic gateway protocol and redaction", () => {
  it("executes real HTTP text/structured, freezes actual mapping, limits output and keeps secrets hosted-only", async () => {
    let upstreamBody: Record<string, unknown> = {};
    const upstream = await listen(createServer(async (req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${secret}`);
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      upstreamBody = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "vendor-v1", choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }] }));
    }));
    const { db, token, catalog } = fixture();
    provision(db, "hosted-a", "ACTIVE");
    const runtime = new ManagedGatewayRuntime({ baseUrl: upstream, apiKey: secret, allowLoopbackForTests: true });
    const base = await listen(createHostedServer(new HostedManagedService(db, catalog, new PlanAuthority(planConfig()), runtime)));
    const snapshot = await (await fetch(`${base}/v1/bindings`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ modelKey: "vocatrya-fast", business: "RESUME", resourceKey: "real-http" }) })).json();
    for (const [path, op] of [["text", "op-text"], ["structured", "op-structured"]] as const) {
      const body = invokeBody(snapshot.managedBindingId, { operationId: op, invocationKey: `${op}:0`, ...(path === "structured" ? { structuredOutput: { schema: { type: "object" }, schemaName: "test" } } : {}) });
      const response = await fetch(`${base}/v1/${path}`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
      const result = await response.json(); expect(result.text).toBe('{"ok":true}');
      expect(result.provenance).toEqual(snapshot); expect(JSON.stringify(result)).not.toContain(secret);
      expect(upstreamBody).toMatchObject({ model: "vendor-v1", max_tokens: 100, stream: false });
    }
  });
  it.each([[401, "GATEWAY_AUTH"], [403, "GATEWAY_AUTH"], [429, "GATEWAY_RATE_LIMIT"], [500, "GATEWAY_RESPONSE"]])("normalizes status %s without raw body or headers", async (status, code) => {
    const { db, token, service } = fixture(async () => new Response(`Authorization: ${secret} stack vendor dump`, { status: Number(status), headers: { "x-secret": secret } }));
    provision(db, "hosted-a", "ACTIVE");
    const snapshot = await bind(service, token);
    const response = await call(service, token, "text", invokeBody(snapshot.managedBindingId));
    expect(await response.json()).toEqual({ code, message: code });
  });
  it.each([() => new Response("{bad"), () => fakeText("unexpected"), () => Response.json({ model: "vendor-v1", choices: [] }), () => Response.json({ model: "vendor-v1", choices: { 0: { message: { content: "fake" }, finish_reason: "stop" } } })])("rejects malformed or mismatched gateway results", async factory => {
    const { db, token, service } = fixture(async () => factory()); provision(db, "hosted-a", "ACTIVE");
    const snapshot = await bind(service, token);
    expect(await (await call(service, token, "text", invokeBody(snapshot.managedBindingId, { prompt: "x" }))).json()).toMatchObject({ code: "GATEWAY_RESPONSE" });
  });
  it("never copies auth into redirects, normalizes network and timeouts", async () => {
    let leaked = false;
    const target = await listen(createServer((_req, res) => { leaked = true; res.end(); }));
    const redirect = await listen(createServer((_req, res) => { res.writeHead(307, { location: target }); res.end(); }));
    const db = store(); db.issueSession("a", Date.now() + 60000); const binding = db.createBinding("a", "RESUME", "x", catalogConfig().models[0]);
    const input = { bindingId: binding.id, modelKey: binding.modelKey, prompt: "x", operationId: "op-1", invocationKey: "op-1:0", attemptIndex: 0 };
    await expect(new ManagedGatewayRuntime({ baseUrl: redirect, apiKey: secret, allowLoopbackForTests: true }).generateText(binding, input)).rejects.toMatchObject({ code: "GATEWAY_NETWORK" });
    expect(leaked).toBe(false);
    const slow = await listen(createServer(() => undefined));
    await expect(new ManagedGatewayRuntime({ baseUrl: slow, apiKey: secret, timeoutMs: 20, allowLoopbackForTests: true }).generateText(binding, input)).rejects.toMatchObject({ code: "GATEWAY_TIMEOUT" });
    await expect(gateway(async () => { throw new Error(secret); }).generateText(binding, input)).rejects.toMatchObject({ code: "GATEWAY_NETWORK", message: "GATEWAY_NETWORK" });
  });
  it("does not fake success for malformed structured content; application layer receives text for validation", async () => {
    const { db, token, service } = fixture(async () => fakeText("vendor-v1", "{malformed-json")); provision(db, "hosted-a", "ACTIVE");
    const snapshot = await bind(service, token);
    const result = await (await call(service, token, "structured", invokeBody(snapshot.managedBindingId, { prompt: "schema prompt", structuredOutput: { schema: { type: "object" }, schemaName: "test" } }))).json();
    expect(result).toMatchObject({ text: "{malformed-json", structuredStrategy: "PROMPT_AND_VALIDATE" });
    expect(() => JSON.parse(result.text)).toThrow();
  });
});

describe("Incremental streaming and cancellation", () => {
  const frame = (delta: string, finish: string | null = null, model = "vendor-v1") => `data: ${JSON.stringify({ model, choices: [{ delta: { content: delta }, finish_reason: finish }] })}\n\n`;
  const streamInput = (bindingId: string) => ({ bindingId, modelKey: "vocatrya-fast", prompt: "x", operationId: "op-1", invocationKey: "op-1:0", attemptIndex: 0 });
  it("suppresses buffered late deltas after abort between iterator.next calls", async () => {
    const db = store(); db.issueSession("a", Date.now() + 60000); const binding = db.createBinding("a", "RESUME", "x", catalogConfig().models[0]);
    const runtime = gateway(async () => new Response(frame("first") + frame("late", "stop") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }));
    const controller = new AbortController(); const stream = runtime.streamText(binding, streamInput(binding.id), controller.signal);
    expect((await stream.next()).value).toEqual({ type: "text-delta", delta: "first" }); controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ code: "GATEWAY_NETWORK" });
  });
  it("emits first delta before upstream finishes and cancels upstream on consumer return", async () => {
    let endUpstream!: () => void; let closed!: () => void;
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const upstream = await listen(createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame("first"));
      endUpstream = () => res.end(frame("second", "stop") + "data: [DONE]\n\n"); res.on("close", closed);
    }));
    const db = store(); db.issueSession("a", Date.now() + 60000); const binding = db.createBinding("a", "RESUME", "stream", catalogConfig().models[0]);
    const runtime = new ManagedGatewayRuntime({ baseUrl: upstream, apiKey: secret, allowLoopbackForTests: true });
    const stream = runtime.streamText(binding, streamInput(binding.id));
    expect((await stream.next()).value).toEqual({ type: "text-delta", delta: "first" });
    endUpstream(); const rest = []; for await (const event of stream) rest.push(event);
    expect(rest).toEqual([{ type: "text-delta", delta: "second" }, { type: "completed", model: binding.modelKey, provenance: provenance(binding) }]);
    const early = runtime.streamText(binding, streamInput(binding.id)); await early.next(); await early.return(undefined); await disconnected;
  });
  it("propagates hosted HTTP client abort to upstream without late deltas or hanging request", async () => {
    let upstreamClosed!: () => void; const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
    const upstream = await listen(createServer((_req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(frame("first")); res.on("close", upstreamClosed); }));
    const { db, token, catalog, service } = fixture();
    provision(db, "hosted-a", "ACTIVE");
    const snapshot = await bind(service, token);
    const base = await listen(createHostedServer(new HostedManagedService(db, catalog, new PlanAuthority(planConfig()), new ManagedGatewayRuntime({ baseUrl: upstream, apiKey: secret, allowLoopbackForTests: true }))));
    const controller = new AbortController();
    const response = await fetch(`${base}/v1/stream`, { method: "POST", headers: { authorization: `Bearer ${token}` }, signal: controller.signal, body: JSON.stringify(invokeBody(snapshot.managedBindingId)) });
    const reader = response.body!.getReader(); expect(new TextDecoder().decode((await reader.read()).value)).toContain("first");
    controller.abort(); await expect(reader.read()).rejects.toThrow(); await closed;
  });
  it.each([frame("x"), "data: {bad}\n\n", frame("x", null, "unexpected"), frame("x", "stop") + frame("late") + "data: [DONE]\n\n", "data: [DONE]\n\n"])("rejects truncated, malformed, mismatched and late events", async body => {
    const db = store(); db.issueSession("a", Date.now() + 60000); const binding = db.createBinding("a", "RESUME", "x", catalogConfig().models[0]);
    const runtime = gateway(async () => new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const consume = async () => { for await (const _event of runtime.streamText(binding, streamInput(binding.id))) { void _event; } };
    await expect(consume()).rejects.toMatchObject({ code: "GATEWAY_RESPONSE" });
  });
});

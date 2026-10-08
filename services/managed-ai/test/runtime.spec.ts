import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ModelCatalog, type ManagedCatalog } from "../src/catalog";
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

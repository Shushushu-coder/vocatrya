// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { HostedStore } from "../services/managed-ai/src/store";
import { ModelCatalog } from "../services/managed-ai/src/catalog";
import { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } from "../services/managed-ai/src/gateway";
import { HostedManagedService } from "../services/managed-ai/src/service";
import { HostedManagedClient } from "@/lib/ai/managed-client";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeAIConnectionTextStream, checkStreamingTurnReadiness } from "@/lib/ai/streaming-execution";
import { executeStructuredForAssignment } from "@/lib/ai/structured-execution";
import { ensureManagedConnectionForLocalUser } from "@/lib/ai/managed-bootstrap";

const db = vi.hoisted(() => ({ aIConnection: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() }, aIBusinessAssignment: { findMany: vi.fn() }, userSettings: { findUnique: vi.fn() } }));
vi.mock("@/lib/db", () => ({ default: db }));
const managed = { id: "local-connection", userId: "local-a", provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", credentialRef: null, runtimeProfileRef: null, accountIdentity: null, status: "CONNECTED", archivedAt: null };
const input = { userId: "local-a", connectionId: managed.id, model: "vocatrya-fast", prompt: "hello" };
const config = { revision: "catalog-1", managedAiEnabled: true, defaultModelKey: "vocatrya-fast", models: [{ modelKey: "vocatrya-fast", displayName: "Fast", upstreamModelId: "vendor-v1", enabled: true, planRequirement: null, sortOrder: 0, mappingRevision: "mapping-1", maxInputTokens: 32000, maxOutputTokens: 100, capabilities: { text: true, streaming: true, structuredOutput: true, tools: false } }] };
function fixture(upstream: typeof fetch = async () => Response.json({ model: "vendor-v1", choices: [{ message: { content: "hello" }, finish_reason: "stop" }] })) {
  const store = new HostedStore(":memory:"); const token = store.issueSession("hosted-a", Date.now() + 60000);
  const service = new HostedManagedService(store, new ModelCatalog(config, VERIFIED_GATEWAY_CAPABILITIES), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: "SYNTHETIC_MANAGED_GATEWAY_SECRET_M2" }, upstream));
  const requests: Request[] = [];
  const client = new HostedManagedClient({ tokenForLocalUser: async id => id === "local-a" ? token : null }, "https://hosted.example", async (url, init) => { const request = new Request(String(url), init); requests.push(request.clone()); return service.handle(request); });
  return { client, store, requests };
}
beforeEach(() => { vi.resetAllMocks(); db.aIConnection.findFirst.mockResolvedValue(managed); });
describe("M1 → M2 dedicated shared dispatch", () => {
  it("executes Managed text through hosted identity with provenance, no Electron request", async () => {
    const { client, store, requests } = fixture(); const desktop = vi.fn();
    try {
      const result = await executeAIConnectionText(input, { managedClient: client, fetchImpl: desktop, execUrl: "http://desktop", internalToken: "internal" });
      expect(result).toMatchObject({ text: "hello", provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", model: "vocatrya-fast", managedAiProvenance: { requestedModelKey: "vocatrya-fast", upstreamModelId: "vendor-v1", mappingRevision: "mapping-1" } });
      expect(desktop).not.toHaveBeenCalled();
      for (const request of requests) { expect(await request.text()).not.toContain("local-a"); expect(request.redirect).toBe("error"); }
    } finally { store.close(); }
  });
  it("preserves ACCOUNT_LOGIN desktop execution and rejects INVALID identities before either channel", async () => {
    const desktop = vi.fn(async () => Response.json({ ok: true, text: "own" }));
    db.aIConnection.findFirst.mockResolvedValue({ ...managed, provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "ACCOUNT_LOGIN", runtimeProfileRef: "rp_account" });
    expect((await executeAIConnectionText(input, { execUrl: "http://desktop", internalToken: "internal", fetchImpl: desktop })).text).toBe("own");
    expect(desktop).toHaveBeenCalledTimes(1);
    for (const invalid of [{ ...managed, credentialRef: "forged" }, { ...managed, provider: "OPENAI", backendKind: "CODEX_RUNTIME", authType: "API_KEY" }, { ...managed, provider: "DEVIN", backendKind: "CODEX_RUNTIME", authType: "ACCOUNT_LOGIN" }]) {
      db.aIConnection.findFirst.mockResolvedValue(invalid);
      await expect(executeAIConnectionText(input, { fetchImpl: desktop })).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION" });
      await expect(executeAIConnectionTextStream(input, { fetchImpl: desktop }).next()).rejects.toMatchObject({ code: "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION" });
    }
    expect(desktop).toHaveBeenCalledTimes(1);
  });
  it("fails closed without hosted session and never uses another local user's hosted account", async () => {
    const client = new HostedManagedClient({ tokenForLocalUser: async () => null }); const desktop = vi.fn();
    await expect(executeAIConnectionText(input, { managedClient: client, fetchImpl: desktop })).rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" });
    expect(desktop).not.toHaveBeenCalled();
    const { client: bound, store } = fixture();
    try { await expect(executeAIConnectionText({ ...input, userId: "local-b" }, { managedClient: bound })).rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" }); }
    finally { store.close(); }
  });
  it("rejects malformed local provenance before hosted invocation", async () => {
    const { client, store, requests } = fixture();
    try { await expect(executeAIConnectionText({ ...input, managedAiProvenance: {} as never }, { managedClient: client })).rejects.toMatchObject({ code: "MANAGED_PROVENANCE_INVALID" }); expect(requests).toHaveLength(0); }
    finally { store.close(); }
  });
  it("streams real incremental Managed deltas and uses catalog readiness without Electron", async () => {
    const body = `data: ${JSON.stringify({ model: "vendor-v1", choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const { client, store } = fixture(async () => new Response(body, { headers: { "content-type": "text/event-stream" } })); const desktop = vi.fn();
    try {
      await checkStreamingTurnReadiness({ userId: input.userId, connection: managed, model: input.model, deps: { managedClient: client, fetchImpl: desktop } });
      const events = []; for await (const event of executeAIConnectionTextStream(input, { managedClient: client, fetchImpl: desktop })) events.push(event);
      expect(events).toMatchObject([{ type: "text-delta", delta: "hello" }, { type: "completed", model: "vocatrya-fast" }]); expect(desktop).not.toHaveBeenCalled();
    } finally { store.close(); }
  });
  it("local hosted client suppresses buffered late deltas after caller abort", async () => {
    const client = new HostedManagedClient({ tokenForLocalUser: async () => "a".repeat(43) }, "https://hosted.example", async () => new Response(
      '{"type":"text-delta","delta":"first"}\n{"type":"text-delta","delta":"late"}\n', { headers: { "content-type": "application/x-ndjson" } }));
    const controller = new AbortController(); const stream = client.streamText(input.userId, { bindingId: "binding", modelKey: input.model, prompt: "x" }, controller.signal);
    expect((await stream.next()).value).toEqual({ type: "text-delta", delta: "first" }); controller.abort();
    await expect(stream.next()).rejects.toMatchObject({ code: "GATEWAY_NETWORK" });
  });
  it.each(["{malformed", '{"wrong":"shape"}'])("reuses one immutable binding for structured schema repair of %s and returns provenance", async malformed => {
    let calls = 0; const models: unknown[] = [];
    const { client, store, requests } = fixture(async (_url, init) => { models.push(JSON.parse(String(init?.body)).model); return Response.json({ model: "vendor-v1", choices: [{ message: { content: calls++ === 0 ? malformed : '{"name":"fixed"}' }, finish_reason: "stop" }] }); });
    db.aIBusinessAssignment.findMany.mockResolvedValue([{ id: "assignment", purpose: "RESUME", userId: input.userId, connectionId: managed.id, model: input.model, connection: managed }]);
    try {
      const result = await executeStructuredForAssignment({ userId: input.userId, purpose: "RESUME", prompt: "task", schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }, schemaName: "test" }, { managedClient: client });
      expect(result).toMatchObject({ status: "OK", value: { name: "fixed" }, attemptCount: 2, retried: true, managedAiProvenance: { upstreamModelId: "vendor-v1" } });
      expect(models).toEqual(["vendor-v1", "vendor-v1"]);
      expect(requests.filter(request => new URL(request.url).pathname === "/v1/bindings")).toHaveLength(1);
      const invocations = await Promise.all(requests.filter(request => new URL(request.url).pathname === "/v1/structured").map(request => request.json()));
      expect(invocations[0].bindingId).toBe(invocations[1].bindingId);
    } finally { store.close(); }
  });
  it("bootstraps only after hosted authentication, preserves frozen null credential tuple", async () => {
    const { client, store } = fixture(); db.aIConnection.findFirst.mockResolvedValue(null); db.aIConnection.create.mockResolvedValue(managed); db.aIConnection.update.mockResolvedValue(managed);
    try {
      expect(await ensureManagedConnectionForLocalUser(input.userId, client, db as never)).toEqual(managed);
      expect(db.aIConnection.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ provider: "VOCATRYA", authType: "MANAGED", backendKind: "MANAGED_GATEWAY", credentialRef: null, runtimeProfileRef: null, accountIdentity: null }) }));
      db.aIConnection.create.mockClear();
      await expect(ensureManagedConnectionForLocalUser("local-b", client, db as never)).rejects.toMatchObject({ code: "MANAGED_AUTH_REQUIRED" }); expect(db.aIConnection.create).not.toHaveBeenCalled();
    } finally { store.close(); }
  });
});

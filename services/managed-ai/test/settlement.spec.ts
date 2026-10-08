import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog } from "../src/catalog";
import { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } from "../src/gateway";
import { HostedStore } from "../src/store";
import { HostedManagedService } from "../src/service";
import { PlanAuthority } from "../src/plan";
import { catalogConfig, planConfig, provision, bind, call, invoke, fakeText, secret } from "./helpers";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function make(fetchImpl: typeof fetch, plans = planConfig()) {
  const store = new HostedStore(":memory:"); cleanup.push(() => store.close());
  const token = store.issueSession("hosted-a", Date.now() + 60_000);
  const svc = new HostedManagedService(store, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(plans), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, fetchImpl), {});
  return { store, token, svc };
}

describe("Settlement and invocation idempotency", () => {
  it("commits quota on success and records tokens", async () => {
    const { store, token, svc } = make(async () => fakeText());
    provision(store, "hosted-a", "ACTIVE");
    const { managedBindingId } = await bind(svc, token);
    expect((await invoke(svc, token, managedBindingId)).status).toBe(200);
    const usage = store.usage("hosted-a", "op-1:0")!;
    expect(usage.status).toBe("SUCCEEDED"); expect(usage.settlement).toBe("COMMITTED");
    expect(usage.chargedUnits).toBe(1); expect(usage.inputTokens).toBe(2); expect(usage.outputTokens).toBe(3);
    expect(store.currentQuotaPeriod("hosted-a", Date.now())?.committedUnits).toBe(1);
  });
  it.each([
    ["gateway auth rejection", async () => new Response("{}", { status: 401 }), "GATEWAY_AUTH"],
    ["gateway rate-limit rejection", async () => new Response("{}", { status: 429 }), "GATEWAY_RATE_LIMIT"],
  ])("retains quota for ambiguous post-dispatch %s", async (_label, fetchImpl, expectedCode) => {
    const { store, token, svc } = make(fetchImpl as typeof fetch);
    provision(store, "hosted-a", "ACTIVE");
    const { managedBindingId } = await bind(svc, token);
    const response = await invoke(svc, token, managedBindingId);
    expect((await response.json()).code).toBe(expectedCode);
    const usage = store.usage("hosted-a", "op-1:0")!;
    expect(usage.status).toBe("UNKNOWN"); expect(usage.settlement).toBe("RESERVED"); expect(usage.chargedUnits).toBe(0);
    expect(store.currentQuotaPeriod("hosted-a", Date.now())?.reservedUnits).toBe(1);
  });
  it("marks network failure as UNKNOWN and never releases reservation", async () => {
    const { store, token, svc } = make(async () => { throw new Error("network down"); });
    provision(store, "hosted-a", "ACTIVE");
    const { managedBindingId } = await bind(svc, token);
    const response = await invoke(svc, token, managedBindingId);
    expect((await response.json()).code).toBe("GATEWAY_NETWORK");
    const usage = store.usage("hosted-a", "op-1:0")!;
    expect(usage.status).toBe("UNKNOWN"); expect(usage.settlement).toBe("RESERVED");
    expect(store.currentQuotaPeriod("hosted-a", Date.now())?.reservedUnits).toBe(1);
  });
  it("charges when the gateway executed but returned an unusable response", async () => {
    const { store, token, svc } = make(async () => new Response("{bad json", { status: 200 }));
    provision(store, "hosted-a", "ACTIVE");
    const { managedBindingId } = await bind(svc, token);
    const response = await invoke(svc, token, managedBindingId);
    expect((await response.json()).code).toBe("GATEWAY_RESPONSE");
    const usage = store.usage("hosted-a", "op-1:0")!;
    expect(usage.status).toBe("FAILED"); expect(usage.settlement).toBe("COMMITTED"); expect(usage.chargedUnits).toBe(1);
  });
  it("executes the gateway once for duplicate requests and returns a receipt", async () => {
    let calls = 0;
    const { store, token, svc } = make(async () => { calls += 1; return fakeText(); });
    provision(store, "hosted-a", "ACTIVE");
    const { managedBindingId } = await bind(svc, token);
    expect((await invoke(svc, token, managedBindingId)).status).toBe(200);
    const replay = await invoke(svc, token, managedBindingId);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ receipt: "completed", status: "SUCCEEDED" });
    expect(calls).toBe(1);
  });
  it("rejects a conflicting request for the same invocation key", async () => {
    const { store, token, svc } = make(async () => fakeText());
    provision(store, "hosted-a", "ACTIVE");
    const { managedBindingId } = await bind(svc, token);
    expect((await invoke(svc, token, managedBindingId)).status).toBe(200);
    const conflict = await call(svc, token, "text", { bindingId: managedBindingId, modelKey: "vocatrya-fast", prompt: "different", operationId: "op-1", invocationKey: "op-1:0", attemptIndex: 0 });
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("INVOCATION_CONFLICT");
  });
  it("never retries an UNKNOWN invocation and requires a stable invocation id", async () => {
    let calls = 0;
    const { store, token, svc } = make(async () => { calls += 1; throw new Error("network down"); });
    provision(store, "hosted-a", "ACTIVE");
    const { managedBindingId } = await bind(svc, token);
    expect((await (await invoke(svc, token, managedBindingId)).json()).code).toBe("GATEWAY_NETWORK");
    const retry = await invoke(svc, token, managedBindingId);
    expect(retry.status).toBe(409);
    expect((await retry.json()).code).toBe("INVOCATION_STATUS_UNKNOWN");
    expect(calls).toBe(1);
    const missing = await call(svc, token, "text", { bindingId: managedBindingId, modelKey: "vocatrya-fast", prompt: "x" });
    expect((await missing.json()).code).toBe("INVOCATION_ID_REQUIRED");
  });
  it("conservatively commits stale UNKNOWN reservations after the grace interval", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m3-reconcile-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "hosted.db");
    const store = new HostedStore(file); cleanup.push(() => store.close());
    const token = store.issueSession("hosted-a", Date.now() + 60_000);
    provision(store, "hosted-a", "ACTIVE");
    let now = Date.now();
    const svc = new HostedManagedService(store, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(planConfig()), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, async () => { throw new Error("network down"); }), { now: () => now, unknownSettlementGraceMs: 1000 });
    const { managedBindingId } = await bind(svc, token);
    expect((await (await invoke(svc, token, managedBindingId)).json()).code).toBe("GATEWAY_NETWORK");
    now += 2000;
    expect(store.reconcileStaleUnknown(now, 1000)).toBe(1);
    const usage = store.usage("hosted-a", "op-1:0")!;
    expect(usage.settlement).toBe("COMMITTED"); expect(usage.chargedUnits).toBe(1);
    expect(store.currentQuotaPeriod("hosted-a", now)?.committedUnits).toBe(1);
  });
  it("treats a structured repair as two separately-charged invocations", async () => {
    const { store, token, svc } = make(async () => fakeText());
    provision(store, "hosted-a", "ACTIVE");
    const { managedBindingId } = await bind(svc, token);
    const first = await call(svc, token, "structured", { bindingId: managedBindingId, modelKey: "vocatrya-fast", prompt: "task", structuredOutput: { schema: { type: "object" }, schemaName: "test" }, operationId: "op-repair", invocationKey: "op-repair:0", attemptIndex: 0 });
    expect(first.status).toBe(200);
    const second = await call(svc, token, "structured", { bindingId: managedBindingId, modelKey: "vocatrya-fast", prompt: "task fixed", structuredOutput: { schema: { type: "object" }, schemaName: "test" }, operationId: "op-repair", invocationKey: "op-repair:1", attemptIndex: 1 });
    expect(second.status).toBe(200);
    const row0 = store.usage("hosted-a", "op-repair:0")!; const row1 = store.usage("hosted-a", "op-repair:1")!;
    expect(row0.attemptIndex).toBe(0); expect(row1.attemptIndex).toBe(1);
    expect(row0.operationId).toBe(row1.operationId); expect(row0.managedBindingId).toBe(row1.managedBindingId);
    expect(store.currentQuotaPeriod("hosted-a", Date.now())?.committedUnits).toBe(2);
  });
  it("recovers a RUNNING row into UNKNOWN on restart, preserving reservation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m3-crash-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "hosted.db");
    const store = new HostedStore(file);
    const token = store.issueSession("hosted-a", Date.now() + 60_000);
    provision(store, "hosted-a", "ACTIVE");
    const binding = store.createBinding("hosted-a", "RESUME", "crash", { modelKey: "vocatrya-fast", upstreamModelId: "vendor-v1", mappingRevision: "mapping-1", displayName: "Fast", enabled: true, planRequirement: null, sortOrder: 0, maxInputTokens: 32000, maxOutputTokens: 100, capabilities: { text: true, streaming: true, structuredOutput: true, tools: false } });
    const reservation = store.reserveInvocation({ hostedUserId: "hosted-a", business: "RESUME", resourceKey: "crash", operationId: "op-crash", invocationKey: "op-crash:0", attemptIndex: 0, requestHash: "hash", binding, plans: new PlanAuthority(planConfig()), now: () => Date.now() });
    if (!reservation.created) throw new Error("unexpected duplicate");
    store.markRunning(reservation.usage.id);
    store.close();
    const reopened = new HostedStore(file); cleanup.push(() => reopened.close());
    expect(reopened.recoverRunning()).toBe(1);
    const row = reopened.usage("hosted-a", "op-crash:0")!;
    expect(row.status).toBe("UNKNOWN"); expect(row.settlement).toBe("RESERVED");
    expect(reopened.currentQuotaPeriod("hosted-a", Date.now())?.reservedUnits).toBe(1);
  });
  it("executes the gateway once for concurrent duplicate invocation keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m3-dup-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "hosted.db");
    const storeA = new HostedStore(file); const storeB = new HostedStore(file);
    cleanup.push(() => storeA.close(), () => storeB.close());
    const token = storeA.issueSession("hosted-a", Date.now() + 60_000);
    provision(storeA, "hosted-a", "ACTIVE");
    let calls = 0;
    const fetchImpl = async () => { calls += 1; await new Promise(resolve => setTimeout(resolve, 10)); return fakeText(); };
    const mk = (store: HostedStore) => new HostedManagedService(store, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(planConfig()), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, fetchImpl), {});
    const svcA = mk(storeA); const svcB = mk(storeB);
    const { managedBindingId } = await bind(svcA, token);
    const [a, b] = await Promise.all([
      invoke(svcA, token, managedBindingId, { operationId: "op-dup", invocationKey: "op-dup:0" }),
      invoke(svcB, token, managedBindingId, { operationId: "op-dup", invocationKey: "op-dup:0" }),
    ]);
    expect(calls).toBe(1);
    expect([a.status, b.status].sort()).toEqual([200, 200]);
  });
});

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog } from "../src/catalog";
import { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } from "../src/gateway";
import { HostedStore } from "../src/store";
import { HostedManagedService } from "../src/service";
import { PlanAuthority, type ManagedPlanConfig } from "../src/plan";
import { catalogConfig, planConfig, provision, bind, invoke, fakeText, secret } from "./helpers";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function singleStore(plans: ManagedPlanConfig = planConfig()) {
  const store = new HostedStore(":memory:"); cleanup.push(() => store.close());
  const token = store.issueSession("hosted-a", Date.now() + 60_000);
  const svc = new HostedManagedService(store, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(plans), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, async () => fakeText()), {});
  return { store, token, svc };
}

describe("Quota admission is atomic and period-frozen", () => {
  it("reserves within quota, allows the exact last unit, then rejects over-quota", async () => {
    const { store, token, svc } = singleStore(planConfig({ plans: [{ planKey: "starter", managedAiEnabled: true, allowedModels: ["vocatrya-fast"], periodQuotaUnits: 1, modelUsageUnits: { "vocatrya-fast": 1 } }] }));
    provision(store, "hosted-a", "ACTIVE");
    const { managedBindingId } = await bind(svc, token);
    expect((await invoke(svc, token, managedBindingId, { invocationKey: "op-1:0" })).status).toBe(200);
    const over = await invoke(svc, token, managedBindingId, { operationId: "op-2", invocationKey: "op-2:0" });
    expect((await over.json()).code).toBe("QUOTA_EXCEEDED");
  });
  it("two independent connections cannot oversubscribe the last unit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "m3-concurrency-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "hosted.db");
    const plans = planConfig({ plans: [{ planKey: "starter", managedAiEnabled: true, allowedModels: ["vocatrya-fast"], periodQuotaUnits: 1, modelUsageUnits: { "vocatrya-fast": 1 } }] });
    const storeA = new HostedStore(file); const storeB = new HostedStore(file);
    cleanup.push(() => storeA.close(), () => storeB.close());
    const token = storeA.issueSession("hosted-a", Date.now() + 60_000);
    storeA.setSubscription("hosted-a", { planKey: "starter", status: "ACTIVE", periodStart: Date.now() - 1000, periodEnd: Date.now() + 60_000 });
    const svcA = new HostedManagedService(storeA, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(plans), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, async () => fakeText()), {});
    const svcB = new HostedManagedService(storeB, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(plans), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, async () => fakeText()), {});
    const { managedBindingId } = await bind(svcA, token);
    const [a, b] = await Promise.all([
      invoke(svcA, token, managedBindingId, { operationId: "op-a", invocationKey: "op-a:0" }),
      invoke(svcB, token, managedBindingId, { operationId: "op-b", invocationKey: "op-b:0" }),
    ]);
    const codes = [(await a.json()).code ?? null, (await b.json()).code ?? null].filter(Boolean).sort();
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 400]);
    expect(codes).toEqual(["QUOTA_EXCEEDED"]);
  });
  it("rolls over to a fresh quota period and preserves history", async () => {
    const store = new HostedStore(":memory:"); cleanup.push(() => store.close());
    const token = store.issueSession("hosted-a", Date.now() + 60_000);
    let now = Date.now();
    const svc = new HostedManagedService(store, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(planConfig()), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, async () => fakeText()), { now: () => now });
    provision(store, "hosted-a", "ACTIVE", { start: now - 1000, end: now + 60_000 });
    const { managedBindingId } = await bind(svc, token);
    expect((await invoke(svc, token, managedBindingId)).status).toBe(200);
    expect(store.currentQuotaPeriod("hosted-a", now)?.committedUnits).toBe(1);
    const nextStart = now + 60_000; const nextEnd = now + 120_000;
    provision(store, "hosted-a", "ACTIVE", { start: nextStart, end: nextEnd });
    now = nextStart + 1000;
    expect((await invoke(svc, token, managedBindingId, { operationId: "op-2", invocationKey: "op-2:0" })).status).toBe(200);
    expect(store.currentQuotaPeriod("hosted-a", now)?.committedUnits).toBe(1);
    expect(store.currentQuotaPeriod("hosted-a", Date.now())).toBeNull(); // never substitutes history for the current subscription
  });
  it("never calls the gateway on entitlement or quota denial", async () => {
    let calls = 0;
    const store = new HostedStore(":memory:"); cleanup.push(() => store.close());
    const token = store.issueSession("hosted-a", Date.now() + 60_000);
    const plans = planConfig({ plans: [{ planKey: "starter", managedAiEnabled: true, allowedModels: ["vocatrya-fast"], periodQuotaUnits: 0, modelUsageUnits: { "vocatrya-fast": 1 } }] });
    const svc = new HostedManagedService(store, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(plans), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, async () => { calls += 1; return fakeText(); }), {});
    const { managedBindingId } = await bind(svc, token);
    // No subscription -> NOT_ENTITLED, zero gateway calls.
    expect((await (await invoke(svc, token, managedBindingId)).json()).code).toBe("NOT_ENTITLED");
    expect(calls).toBe(0);
    // Quota exhausted -> QUOTA_EXCEEDED, zero gateway calls.
    provision(store, "hosted-a", "ACTIVE");
    expect((await (await invoke(svc, token, managedBindingId, { operationId: "op-2", invocationKey: "op-2:0" })).json()).code).toBe("QUOTA_EXCEEDED");
    expect(calls).toBe(0);
  });
});

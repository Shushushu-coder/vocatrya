import { afterEach, describe, expect, it } from "vitest";
import { ModelCatalog, type ManagedCatalog } from "../src/catalog";
import { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } from "../src/gateway";
import { HostedStore } from "../src/store";
import { HostedManagedService } from "../src/service";
import { PlanAuthority, type ManagedPlanConfig } from "../src/plan";
import { catalogConfig, planConfig, provision, bind, call, invoke, fakeText, secret } from "./helpers";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });

function service(opts: { catalog?: ManagedCatalog; plans?: ManagedPlanConfig } = {}) {
  const store = new HostedStore(":memory:"); cleanup.push(() => store.close());
  const token = store.issueSession("hosted-a", Date.now() + 60_000);
  const catalog = new ModelCatalog(opts.catalog ?? catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES);
  const plans = new PlanAuthority(opts.plans ?? planConfig());
  const svc = new HostedManagedService(store, catalog, plans, new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, async () => fakeText()), {});
  return { store, token, catalog, plans, service: svc };
}

describe("Entitlement is derived authority", () => {
  it.each([
    ["ACTIVE valid period", "ACTIVE", -1000, 60_000, 200],
    ["ACTIVE expired period", "ACTIVE", -60_000, -1000, "NOT_ENTITLED"],
    ["PAST_DUE", "PAST_DUE", -1000, 60_000, "NOT_ENTITLED"],
    ["CANCELED", "CANCELED", -1000, 60_000, "NOT_ENTITLED"],
    ["EXPIRED", "EXPIRED", -1000, 60_000, "NOT_ENTITLED"],
  ] as const)("%s", async (_label, status, offsetStart, offsetEnd, expected) => {
    const { store, token, service: svc } = service();
    const now = Date.now();
    provision(store, "hosted-a", status, { start: now + offsetStart, end: now + offsetEnd });
    const { managedBindingId } = await bind(svc, token);
    const response = await invoke(svc, token, managedBindingId);
    if (expected === 200) expect(response.status).toBe(200);
    else expect((await response.json()).code).toBe(expected);
  });
  it("fails closed for unknown or disabled plans", async () => {
    const { store, token, service: svc } = service();
    const now = Date.now();
    provision(store, "hosted-a", "ACTIVE", { planKey: "unknown-plan", start: now - 1000, end: now + 60_000 });
    const { managedBindingId } = await bind(svc, token);
    expect((await (await invoke(svc, token, managedBindingId)).json()).code).toBe("NOT_ENTITLED");
  });
  it("enforces plan model allow-list", async () => {
    const catalog = catalogConfig({ models: [
      catalogConfig().models[0],
      { ...catalogConfig().models[0], modelKey: "vocatrya-slow", upstreamModelId: "vendor-v2" },
    ] });
    const plans = planConfig({ plans: [{ planKey: "starter", managedAiEnabled: true, allowedModels: ["vocatrya-fast"], periodQuotaUnits: 10, modelUsageUnits: { "vocatrya-fast": 1 } }] });
    const { store, token, service: svc } = service({ catalog, plans });
    provision(store, "hosted-a", "ACTIVE");
    const binding = store.createBinding("hosted-a", "RESUME", "slow", catalog.models[1]);
    const response = await call(svc, token, "text", { bindingId: binding.id, modelKey: "vocatrya-slow", prompt: "x", operationId: "op-1", invocationKey: "op-1:0", attemptIndex: 0 });
    expect((await response.json()).code).toBe("MODEL_NOT_ALLOWED");
  });
  it("rejects allowed models when the catalog kill switch or capability is off", async () => {
    const disabledCatalog = catalogConfig({ models: [{ ...catalogConfig().models[0], enabled: false }] });
    const { store, token, service: svc } = service({ catalog: disabledCatalog });
    provision(store, "hosted-a", "ACTIVE");
    const binding = store.createBinding("hosted-a", "RESUME", "disabled", disabledCatalog.models[0]);
    expect((await (await call(svc, token, "text", { bindingId: binding.id, modelKey: "vocatrya-fast", prompt: "x", operationId: "op-1", invocationKey: "op-1:0", attemptIndex: 0 })).json()).code).toBe("MODEL_DISABLED");
    const noStreamCatalog = catalogConfig({ models: [{ ...catalogConfig().models[0], capabilities: { text: true, streaming: false, structuredOutput: true, tools: false } }] });
    const { store: s2, token: t2, service: svc2 } = service({ catalog: noStreamCatalog });
    provision(s2, "hosted-a", "ACTIVE");
    const binding2 = s2.createBinding("hosted-a", "RESUME", "nostream", noStreamCatalog.models[0]);
    expect((await (await call(svc2, t2, "stream", { bindingId: binding2.id, modelKey: "vocatrya-fast", prompt: "x", operationId: "op-1", invocationKey: "op-1:0", attemptIndex: 0 })).json()).code).toBe("CAPABILITY_UNSUPPORTED");
  });
  it("exposes only the authenticated user's own entitlement and usage summary", async () => {
    const store = new HostedStore(":memory:"); cleanup.push(() => store.close());
    const tokenA = store.issueSession("hosted-a", Date.now() + 60_000);
    const tokenB = store.issueSession("hosted-b", Date.now() + 60_000);
    provision(store, "hosted-a", "ACTIVE");
    const svc = new HostedManagedService(store, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(planConfig()), new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret }, async () => fakeText()), {});
    const entitlement = await (await call(svc, tokenA, "me/entitlement")).json();
    expect(entitlement).toMatchObject({ subscriptionStatus: "ACTIVE", planKey: "starter", managedAiEnabled: true, allowedModels: ["vocatrya-fast"], quotaLimitUnits: 10 });
    const usage = await (await call(svc, tokenA, "me/usage")).json();
    expect(usage).toMatchObject({ quotaLimitUnits: 10, reservedUnits: 0, committedUnits: 0, remainingUnits: 10 });
    const other = await (await call(svc, tokenB, "me/entitlement")).json();
    expect(other).toMatchObject({ subscriptionStatus: null, managedAiEnabled: false });
  });
});

import { ModelCatalog, type ManagedCatalog } from "../src/catalog";
import { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } from "../src/gateway";
import { HostedStore } from "../src/store";
import { HostedManagedService } from "../src/service";
import { PlanAuthority, type ManagedPlanConfig } from "../src/plan";
import type { SubscriptionStatus } from "../src/types";

export const secret = "SYNTHETIC_MANAGED_GATEWAY_SECRET_M3";

export const catalogConfig = (overrides: Partial<ManagedCatalog> = {}): ManagedCatalog => ({
  revision: "catalog-1", managedAiEnabled: true, defaultModelKey: "vocatrya-fast",
  models: [{
    modelKey: "vocatrya-fast", displayName: "Fast", upstreamModelId: "vendor-v1", mappingRevision: "mapping-1", enabled: true,
    planRequirement: null, sortOrder: 0, maxInputTokens: 32000, maxOutputTokens: 100,
    capabilities: { text: true, streaming: true, structuredOutput: true, tools: false },
  }],
  ...overrides,
});

export const planConfig = (overrides: Partial<ManagedPlanConfig> = {}): ManagedPlanConfig => ({
  revision: "plans-1",
  plans: [{ planKey: "starter", managedAiEnabled: true, allowedModels: ["vocatrya-fast"], periodQuotaUnits: 10, modelUsageUnits: { "vocatrya-fast": 1 } }],
  ...overrides,
});

export interface Fixture {
  store: HostedStore;
  token: string;
  catalog: ModelCatalog;
  plans: PlanAuthority;
  service: HostedManagedService;
  now: () => number;
}
export function fixture(
  fetchImpl: typeof fetch = async () => fakeText(),
  opts: { plans?: ManagedPlanConfig; catalog?: ManagedCatalog; now?: () => number; graceMs?: number } = {},
): Fixture {
  const store = new HostedStore(":memory:");
  const token = store.issueSession("hosted-a", Date.now() + 60_000);
  const catalog = new ModelCatalog(opts.catalog ?? catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES);
  const plans = new PlanAuthority(opts.plans ?? planConfig());
  const now = opts.now ?? (() => Date.now());
  const service = new HostedManagedService(store, catalog, plans, new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret, timeoutMs: 1000 }, fetchImpl), { now, unknownSettlementGraceMs: opts.graceMs });
  return { store, token, catalog, plans, service, now };
}
export function fakeText(model = "vendor-v1", content = "hello"): Response {
  return Response.json({ model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
}
export function provision(store: HostedStore, hostedUserId: string, status: SubscriptionStatus = "ACTIVE", opts: { planKey?: string; start?: number; end?: number; sourceRevision?: string } = {}) {
  const now = Date.now();
  return store.setSubscription(hostedUserId, {
    planKey: opts.planKey ?? "starter", status,
    periodStart: opts.start ?? now - 1000, periodEnd: opts.end ?? now + 60_000,
    source: "OPERATOR", sourceRevision: opts.sourceRevision ?? null,
  });
}
export async function call(service: HostedManagedService, token: string | null, path: string, body?: unknown, method: "GET" | "POST" = body === undefined ? "GET" : "POST") {
  return service.handle(new Request(`https://hosted.example${path.startsWith("/") ? path : `/v1/${path}`}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}
export async function bind(service: HostedManagedService, token: string, resourceKey = "resource-1") {
  const response = await call(service, token, "bindings", { modelKey: "vocatrya-fast", business: "RESUME", resourceKey });
  if (response.status !== 200) throw new Error(`bind failed ${response.status}`);
  return response.json() as Promise<{ managedBindingId: string }>;
}
export async function invoke(service: HostedManagedService, token: string, bindingId: string, opts: { path?: string; operationId?: string; invocationKey?: string; attemptIndex?: number; prompt?: string } = {}) {
  return call(service, token, opts.path ?? "text", {
    bindingId, modelKey: "vocatrya-fast", prompt: opts.prompt ?? "hello",
    operationId: opts.operationId ?? "op-1", invocationKey: opts.invocationKey ?? "op-1:0", attemptIndex: opts.attemptIndex ?? 0,
  });
}

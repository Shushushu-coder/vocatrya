import { readFileSync } from "node:fs";
import { ModelCatalog, validateCatalog } from "./catalog";
import { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } from "./gateway";
import { HostedStore } from "./store";
import { HostedManagedService } from "./service";
import { PlanAuthority, validatePlanConfig } from "./plan";
import { createHostedServer } from "./http";
import { acquireServiceOwnership } from "./service-ownership";

function required(name: string): string { const value = process.env[name]; if (!value?.trim()) throw new Error(`Missing hosted config: ${name}`); return value; }
function unknownSettlementMs(): number {
  const raw = process.env.MANAGED_AI_UNKNOWN_SETTLEMENT_MS;
  if (raw === undefined || raw.trim() === "") return 60_000;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 3_600_000) throw new Error("Invalid MANAGED_AI_UNKNOWN_SETTLEMENT_MS");
  return value;
}

// Startup validation covers model catalog, plan config, schema and gateway
// config together. Any invalid configuration fails startup — no half-usable
// service is ever served.
const rawCatalog = validateCatalog(JSON.parse(readFileSync(required("MANAGED_AI_CATALOG_PATH"), "utf8")));
const catalog = new ModelCatalog({ ...rawCatalog, managedAiEnabled: rawCatalog.managedAiEnabled === true && process.env.MANAGED_AI_ENABLED === "true" }, VERIFIED_GATEWAY_CAPABILITIES);
const catalogModelKeys = new Set(rawCatalog.models.map(model => model.modelKey));
const planConfig = validatePlanConfig(JSON.parse(readFileSync(required("MANAGED_AI_PLAN_PATH"), "utf8")), catalogModelKeys);
const plans = new PlanAuthority(planConfig);
const database = required("MANAGED_AI_DATABASE_PATH");
const releaseOwnership = acquireServiceOwnership(database);
const store = new HostedStore(database);
store.recoverRunning();
const gateway = new ManagedGatewayRuntime({ baseUrl: required("MANAGED_AI_BASE_URL"), apiKey: required("MANAGED_AI_API_KEY") });
const server = createHostedServer(new HostedManagedService(store, catalog, plans, gateway, { unknownSettlementGraceMs: unknownSettlementMs() }));
server.listen(Number(process.env.PORT ?? 8787), "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.close(() => { store.close(); releaseOwnership(); }); server.closeAllConnections(); });

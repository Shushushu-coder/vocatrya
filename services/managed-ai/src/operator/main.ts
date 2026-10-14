import { readFileSync } from "node:fs";
import { validateCatalog } from "../catalog";
import { HostedStore } from "../store";
import { PlanAuthority, validatePlanConfig } from "../plan";
import { createHostedServer } from "../http";
import { OperatorStore } from "./store";
import { OperatorService } from "./service";

/**
 * Loopback Operator listener. It binds 127.0.0.1 only — reach it over an
 * owner-authorized SSH local forward (ssh -L). It deliberately does NOT take
 * the exclusive service-ownership lock and never runs startup recovery; the
 * hosted service owns those duties and the operator must never rewrite the
 * ledger on open.
 *
 * Required env: MANAGED_AI_DATABASE_PATH, MANAGED_AI_CATALOG_PATH,
 * MANAGED_AI_PLAN_PATH. Optional: MANAGED_AI_BASE_URL + MANAGED_AI_PROVIDER_LABEL
 * (provider display/probe — the platform API key is never read here),
 * MANAGED_AI_ENABLED (mirrors the hosted gate for display only),
 * OPERATOR_LISTEN_PORT (default 8790).
 */
function required(name: string): string { const value = process.env[name]; if (!value?.trim()) throw new Error(`Missing operator config: ${name}`); return value; }
function optional(name: string): string | null { const value = process.env[name]; return value?.trim() ? value : null; }
function port(): number {
  const raw = process.env.OPERATOR_LISTEN_PORT;
  if (raw === undefined || raw.trim() === "") return 8790;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) throw new Error("Invalid OPERATOR_LISTEN_PORT");
  return value;
}

const catalog = validateCatalog(JSON.parse(readFileSync(required("MANAGED_AI_CATALOG_PATH"), "utf8")));
const effectiveCatalog = { ...catalog, managedAiEnabled: catalog.managedAiEnabled === true && process.env.MANAGED_AI_ENABLED === "true" };
const catalogModelKeys = new Set(catalog.models.map(model => model.modelKey));
const plans = new PlanAuthority(validatePlanConfig(JSON.parse(readFileSync(required("MANAGED_AI_PLAN_PATH"), "utf8")), catalogModelKeys));

const store = new HostedStore(required("MANAGED_AI_DATABASE_PATH"));
const operator = new OperatorStore(store.internalDb());
const provider = { label: optional("MANAGED_AI_PROVIDER_LABEL") ?? "openai-compatible", baseUrl: optional("MANAGED_AI_BASE_URL") };
const server = createHostedServer(new OperatorService(store, operator, effectiveCatalog, plans, provider));
server.listen(port(), "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.close(() => { store.close(); }); server.closeAllConnections(); });

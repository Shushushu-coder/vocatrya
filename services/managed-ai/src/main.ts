import { readFileSync } from "node:fs";
import { ModelCatalog, validateCatalog } from "./catalog";
import { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } from "./gateway";
import { HostedStore } from "./store";
import { HostedManagedService } from "./service";
import { createHostedServer } from "./http";

function required(name: string): string { const value = process.env[name]; if (!value?.trim()) throw new Error(`Missing hosted config: ${name}`); return value; }
const raw = validateCatalog(JSON.parse(readFileSync(required("MANAGED_AI_CATALOG_PATH"), "utf8")));
const catalog = new ModelCatalog({ ...raw, managedAiEnabled: raw.managedAiEnabled === true && process.env.MANAGED_AI_ENABLED === "true" }, VERIFIED_GATEWAY_CAPABILITIES);
const store = new HostedStore(required("MANAGED_AI_DATABASE_PATH"));
const gateway = new ManagedGatewayRuntime({ baseUrl: required("MANAGED_AI_BASE_URL"), apiKey: required("MANAGED_AI_API_KEY") });
const server = createHostedServer(new HostedManagedService(store, catalog, gateway));
server.listen(Number(process.env.PORT ?? 8787), "0.0.0.0");
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { server.close(() => { store.close(); }); server.closeAllConnections(); });

import { afterEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { spawnSync } from "node:child_process";
import { HostedStore } from "../src/store";
import { MIGRATIONS } from "../src/schema";
import { PlanAuthority } from "../src/plan";
import { classifyGatewaySettlementRisk } from "../src/gateway";
import { acquireServiceOwnership } from "../src/service-ownership";
import { fixture, provision, bind, invoke, call, fakeText, planConfig, catalogConfig } from "./helpers";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.restoreAllMocks(); while (cleanup.length) cleanup.pop()!(); });
function directory() { const dir = mkdtempSync(join(tmpdir(), "m3-closure-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function make(fetchImpl: typeof fetch = async () => fakeText(), quota = 1) {
  const config = planConfig(); config.plans[0].periodQuotaUnits = quota;
  const f = fixture(fetchImpl, { plans: config }); cleanup.push(() => f.store.close());
  provision(f.store, "hosted-a"); return f;
}
function invariant(store: HostedStore, committed: number, reserved = 0) {
  const period = store.currentQuotaPeriod("hosted-a", Date.now())!;
  expect(period.reservedUnits).toBe(reserved); expect(period.committedUnits).toBe(committed);
  expect(period.reservedUnits).toBeGreaterThanOrEqual(0); expect(period.committedUnits).toBeGreaterThanOrEqual(0);
  expect(period.reservedUnits + period.committedUnits).toBeLessThanOrEqual(period.quotaLimitUnits);
}

// Workers execute the actual source through an isolated CommonJS TS loader.
// Both have independent SQLite connections and synchronize before admission.
const workerLoader = `
const { workerData: d, parentPort } = require('node:worker_threads');
const ts = require(d.typescript), fs = require('node:fs');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file,'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, file);
const { HostedStore } = require(d.root + '/src/store.ts');
const store = new HostedStore(d.file);
const gate = new Int32Array(d.gate);
`;
function worker(file: string, gate: SharedArrayBuffer, script: string, data: Record<string, unknown> = {}) {
  const job = new Worker(workerLoader + script, { eval: true, workerData: { file, gate, root: resolve("."), typescript: require.resolve("typescript"), ...data } });
  const result = new Promise<Record<string, unknown>>((accept, reject) => { job.once("message", accept); job.once("error", reject); job.once("exit", code => { if (code) reject(new Error(`worker exit ${code}`)); }); });
  return { job, result };
}

describe("M3 remediation authority and monotonic settlement closure", () => {
  it("checks same-key replay before the exhausted last unit", async () => {
    let calls = 0, finish!: (response: Response) => void;
    const f = make(async () => { calls++; return new Promise<Response>(resolve => { finish = resolve; }); });
    const binding = await bind(f.service, f.token);
    const original = invoke(f.service, f.token, binding.managedBindingId);
    await vi.waitFor(() => expect(calls).toBe(1));
    const duplicate = await invoke(f.service, f.token, binding.managedBindingId);
    expect(await duplicate.json()).toMatchObject({ executionState: "IN_PROGRESS", settlement: "RESERVED" });
    invariant(f.store, 0, 1);
    finish(fakeText()); expect((await original).status).toBe(200);
    expect(await (await invoke(f.service, f.token, binding.managedBindingId)).json()).toMatchObject({ executionState: "REPLAYED" });
    expect(calls).toBe(1); invariant(f.store, 1);
  });
  it("independent workers racing the last unit execute one gateway call", async () => {
    const file = join(directory(), "hosted.db"), store = new HostedStore(file); cleanup.push(() => store.close());
    const token = store.issueSession("hosted-a", Date.now() + 60_000); provision(store, "hosted-a");
    const binding = store.createBinding("hosted-a", "RESUME", "race", catalogConfig().models[0]);
    const config = planConfig(); config.plans[0].periodQuotaUnits = 1;
    const gate = new SharedArrayBuffer(12), cells = new Int32Array(gate);
    const script = `
const { HostedManagedService } = require(d.root+'/src/service.ts');
const { ModelCatalog } = require(d.root+'/src/catalog.ts');
const { PlanAuthority } = require(d.root+'/src/plan.ts');
const { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } = require(d.root+'/src/gateway.ts');
const gateway = new ManagedGatewayRuntime({baseUrl:'https://gateway.example/v1',apiKey:'synthetic'},async()=>{Atomics.add(gate,2,1); await new Promise(r=>setTimeout(r,20)); return Response.json({model:'vendor-v1',choices:[{message:{content:'ok'},finish_reason:'stop'}]});});
const service = new HostedManagedService(store,new ModelCatalog(d.catalog,VERIFIED_GATEWAY_CAPABILITIES),new PlanAuthority(d.plans),gateway);
Atomics.add(gate,0,1); Atomics.notify(gate,0); Atomics.wait(gate,1,0);
service.handle(new Request('https://hosted.example/v1/text',{method:'POST',headers:{authorization:'Bearer '+d.token,'content-type':'application/json'},body:JSON.stringify(d.input)})).then(async response=>{parentPort.postMessage({status:response.status,body:await response.json()});store.close();});`;
    const data = { catalog: catalogConfig(), plans: config, token, input: { bindingId: binding.id, modelKey: binding.modelKey, prompt: "race", operationId: "op-race", invocationKey: "op-race:0", attemptIndex: 0 } };
    const a = worker(file, gate, script, data), b = worker(file, gate, script, data);
    await vi.waitFor(() => expect(Atomics.load(cells, 0)).toBe(2));
    Atomics.store(cells, 1, 1); Atomics.notify(cells, 1);
    const results = await Promise.all([a.result, b.result]);
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(Atomics.load(cells, 2)).toBe(1); invariant(store, 1);
    expect(results.map(result => (result.body as { executionState: string }).executionState).sort()).toEqual(expect.arrayContaining(["EXECUTED"]));
    await Promise.all([a.job.terminate(), b.job.terminate()]);
  });
  it.each(["success", "401", "network"])("recovery + reconciliation + late %s preserves terminal truth and one charge", async kind => {
    let finish!: (response: Response) => void, reject!: (error: Error) => void;
    const f = make(async () => new Promise<Response>((resolve, fail) => { finish = resolve; reject = fail; }));
    const binding = await bind(f.service, f.token);
    const original = invoke(f.service, f.token, binding.managedBindingId);
    await vi.waitFor(() => expect(f.store.usage("hosted-a", "op-1:0")?.status).toBe("RUNNING"));
    const now = Date.now(); expect(f.store.recoverRunning(now)).toBe(1); invariant(f.store, 0, 1);
    expect(f.store.reconcileStaleUnknown(now + 2000, 1000)).toBe(1);
    const terminal = f.store.usage("hosted-a", "op-1:0");
    if (kind === "network") reject(new Error("network")); else finish(kind === "401" ? new Response(null, { status: 401 }) : fakeText());
    await original;
    expect(f.store.usage("hosted-a", "op-1:0")).toEqual(terminal); invariant(f.store, 1);
    expect(f.store.reconcileStaleUnknown(now + 4000, 1000)).toBe(0);
  });
  it("UNKNOWN + late 401 cannot release the recovery reservation", async () => {
    let finish!: (response: Response) => void;
    const f = make(async () => new Promise<Response>(resolve => { finish = resolve; }));
    const binding = await bind(f.service, f.token);
    const original = invoke(f.service, f.token, binding.managedBindingId);
    await vi.waitFor(() => expect(f.store.usage("hosted-a", "op-1:0")?.status).toBe("RUNNING"));
    f.store.recoverRunning(); finish(new Response(null, { status: 401 })); await original;
    expect(f.store.usage("hosted-a", "op-1:0")).toMatchObject({ status: "UNKNOWN", settlement: "RESERVED" }); invariant(f.store, 0, 1);
  });
  it.each(["COMMITTED", "RELEASED", "UNKNOWN"] as const)("state transition table keeps %s monotonic", async first => {
    let finish!: (response: Response) => void;
    const f = make(async () => new Promise<Response>(resolve => { finish = resolve; }));
    const binding = await bind(f.service, f.token), original = invoke(f.service, f.token, binding.managedBindingId);
    await vi.waitFor(() => expect(f.store.usage("hosted-a", "op-1:0")?.status).toBe("RUNNING"));
    const id = f.store.usage("hosted-a", "op-1:0")!.id;
    const transition = (next: string) => next === "COMMITTED" ? f.store.settleCommitted(id, { completedAt: Date.now() }) : next === "RELEASED" ? f.store.settleReleased(id, "PRE_DISPATCH") : f.store.settleUnknown(id, "AMBIGUOUS");
    transition(first);
    if (first === "UNKNOWN") { transition("RELEASED"); invariant(f.store, 0, 1); transition("COMMITTED"); }
    const terminal = f.store.usage("hosted-a", "op-1:0");
    for (const next of ["COMMITTED", "RELEASED", "UNKNOWN", "COMMITTED", "RELEASED"]) {
      transition(next); expect(f.store.usage("hosted-a", "op-1:0")).toEqual(terminal);
      invariant(f.store, first === "RELEASED" ? 0 : 1);
    }
    finish(fakeText()); await original; expect(f.store.usage("hosted-a", "op-1:0")).toEqual(terminal);
  });
  it.each([400, 401, 403, 408, 409, 425, 429, 500, 503])("post-dispatch HTTP %i is UNKNOWN, never released or retried", async status => {
    let calls = 0; const f = make(async () => { calls++; return new Response(null, { status }); });
    const binding = await bind(f.service, f.token); await invoke(f.service, f.token, binding.managedBindingId);
    expect(f.store.usage("hosted-a", "op-1:0")).toMatchObject({ status: "UNKNOWN", settlement: "RESERVED" }); invariant(f.store, 0, 1);
    expect(await (await invoke(f.service, f.token, binding.managedBindingId)).json()).toEqual({ code: "INVOCATION_STATUS_UNKNOWN", executionState: "UNKNOWN", invocationKey: "op-1:0", status: "UNKNOWN", settlement: "RESERVED" }); expect(calls).toBe(1);
  });
  it("risk classification uses dispatch facts; proven pre-dispatch abort releases exactly once", async () => {
    expect(classifyGatewaySettlementRisk({ dispatched: false })).toBe("RELEASED");
    expect(classifyGatewaySettlementRisk({ dispatched: true })).toBe("UNKNOWN");
    expect(classifyGatewaySettlementRisk({ dispatched: true, generated: true })).toBe("COMMITTED");
    const f = make(); const binding = await bind(f.service, f.token), controller = new AbortController(); controller.abort();
    const response = await f.service.handle(new Request("https://hosted.example/v1/text", { method: "POST", signal: controller.signal,
      headers: { authorization: `Bearer ${f.token}` }, body: JSON.stringify({ bindingId: binding.managedBindingId, modelKey: "vocatrya-fast", prompt: "x", operationId: "op-abort", invocationKey: "op-abort:0", attemptIndex: 0 }) }));
    expect(response.status).toBe(400); expect(f.store.usage("hosted-a", "op-abort:0")?.settlement).toBe("RELEASED"); invariant(f.store, 0);
  });
  it("request hash distinguishes execution mode and canonicalizes schema property order", async () => {
    const f = make(undefined, 4); const binding = await bind(f.service, f.token);
    await invoke(f.service, f.token, binding.managedBindingId);
    expect(await (await invoke(f.service, f.token, binding.managedBindingId, { path: "stream" })).json()).toMatchObject({ code: "INVOCATION_CONFLICT" });
    const body = { bindingId: binding.managedBindingId, modelKey: "vocatrya-fast", prompt: "x", operationId: "schema-op", invocationKey: "schema-op:0", attemptIndex: 0,
      structuredOutput: { schemaName: "s", schema: { type: "object", properties: { name: { type: "string", description: "n" } } } } };
    expect((await call(f.service, f.token, "structured", body)).status).toBe(200);
    body.structuredOutput.schema = { properties: { name: { description: "n", type: "string" } }, type: "object" };
    expect(await (await call(f.service, f.token, "structured", body)).json()).toMatchObject({ executionState: "REPLAYED" }); invariant(f.store, 2);
  });
  it("same source revision compares the entire normalized payload under the lock", () => {
    const f = make(); const current = f.store.subscription("hosted-a")!;
    const value = { planKey: current.planKey, status: current.status, periodStart: current.periodStart, periodEnd: current.periodEnd, source: "SYNC", sourceRevision: "r-1", externalSubscriptionRef: "sub-A" };
    const first = f.store.setSubscription("hosted-a", value, 100);
    expect(f.store.setSubscription("hosted-a", { ...value, source: " SYNC ", externalSubscriptionRef: " sub-A " }, 200)).toEqual(first);
    for (const change of [{ status: "CANCELED" as const }, { externalSubscriptionRef: "sub-B" }, { cancelAtPeriodEnd: true }]) {
      expect(() => f.store.setSubscription("hosted-a", { ...value, ...change })).toThrow("SOURCE_REVISION_CONFLICT");
      expect(f.store.subscription("hosted-a")).toEqual(first);
    }
    expect(() => f.store.setSubscription("missing", value)).toThrow("Hosted user does not exist");
  });
  it.each(["admission-first", "revoke-first"])("subscription revoke/admission is linearized: %s", async order => {
    const file = join(directory(), "hosted.db"), store = new HostedStore(file); cleanup.push(() => store.close());
    store.issueSession("hosted-a", Date.now() + 60_000); provision(store, "hosted-a");
    const binding = store.createBinding("hosted-a", "RESUME", "revoke-race", catalogConfig().models[0]);
    const gate = new SharedArrayBuffer(8), cells = new Int32Array(gate);
    const script = `Atomics.store(gate,0,1); Atomics.notify(gate,0); Atomics.wait(gate,1,0);
const existing = store.subscription('hosted-a');
store.setSubscription('hosted-a',{planKey:existing.planKey,status:'CANCELED',periodStart:existing.periodStart,periodEnd:existing.periodEnd});
parentPort.postMessage({status:store.subscription('hosted-a').status});store.close();`;
    const b = worker(file, gate, script);
    await vi.waitFor(() => expect(Atomics.load(cells, 0)).toBe(1));
    const args = { hostedUserId: "hosted-a", business: binding.business, resourceKey: binding.resourceKey, binding, plans: new PlanAuthority(planConfig()), now: () => Date.now(), operationId: "op-race", invocationKey: "op-race:0", attemptIndex: 0, requestHash: "race" };
    if (order === "revoke-first") {
      Atomics.store(cells, 1, 1); Atomics.notify(cells, 1); await b.result;
      expect(() => store.reserveInvocation(args)).toThrow("NOT_ENTITLED"); expect(store.usage("hosted-a", "op-race:0")).toBeNull();
    } else {
      const subscription = store.subscription.bind(store);
      vi.spyOn(store, "subscription").mockImplementation(user => {
        // This runs after BEGIN IMMEDIATE; the competing mutation blocks until COMMIT.
        Atomics.store(cells, 1, 1); Atomics.notify(cells, 1); return subscription(user);
      });
      expect(store.reserveInvocation(args).created).toBe(true);
      await b.result; expect(store.subscription("hosted-a")?.status).toBe("CANCELED"); invariant(store, 0, 1);
    }
    await b.job.terminate();
  });
  it("usage DTO selects exact subscription period, returns zero before current quota creation", async () => {
    const f = make(undefined, 10); const binding = await bind(f.service, f.token);
    await invoke(f.service, f.token, binding.managedBindingId);
    const old = f.store.subscription("hosted-a")!;
    f.store.setSubscription("hosted-a", { planKey: old.planKey, status: "ACTIVE", periodStart: old.periodStart - 10000, periodEnd: old.periodEnd });
    expect(await (await call(f.service, f.token, "/v1/me/usage")).json()).toMatchObject({ periodStart: old.periodStart - 10000, committedUnits: 0, reservedUnits: 0 });
    await invoke(f.service, f.token, binding.managedBindingId, { operationId: "new", invocationKey: "new:0" });
    expect(await (await call(f.service, f.token, "/v1/me/usage")).json()).toMatchObject({ periodStart: old.periodStart - 10000, committedUnits: 1 });
  });
  it("lock waiting across periodEnd reads the authoritative time only after acquiring admission lock", async () => {
    const file = join(directory(), "hosted.db"), store = new HostedStore(file); cleanup.push(() => store.close());
    store.issueSession("hosted-a", Date.now() + 60_000);
    store.setSubscription("hosted-a", { planKey: "starter", status: "ACTIVE", periodStart: 0, periodEnd: 1500 });
    const binding = store.createBinding("hosted-a", "RESUME", "expiry-race", catalogConfig().models[0]);
    const gate = new SharedArrayBuffer(12), cells = new Int32Array(gate); cells[2] = 1000;
    const b = worker(file, gate, `const {DatabaseSync}=require('node:sqlite'); const writer=new DatabaseSync(d.file);
writer.exec('BEGIN IMMEDIATE'); Atomics.store(gate,0,1); Atomics.notify(gate,0);
Atomics.wait(gate,1,0); Atomics.wait(gate,1,1,150); Atomics.store(gate,2,2000);
writer.exec('COMMIT'); writer.close();store.close();parentPort.postMessage({released:true});`);
    await vi.waitFor(() => expect(Atomics.load(cells, 0)).toBe(1));
    Atomics.store(cells, 1, 1); Atomics.notify(cells, 1);
    const clock = vi.fn(() => Atomics.load(cells, 2));
    expect(() => store.reserveInvocation({ hostedUserId: "hosted-a", business: binding.business, resourceKey: binding.resourceKey, binding,
      plans: new PlanAuthority(planConfig()), now: clock, operationId: "expiry", invocationKey: "expiry:0", attemptIndex: 0, requestHash: "expiry" })).toThrow("NOT_ENTITLED");
    expect(clock).toHaveBeenCalledTimes(1); expect(clock.mock.results[0].value).toBe(2000);
    expect(store.usage("hosted-a", "expiry:0")).toBeNull();
    await b.result; await b.job.terminate();
  });
  it("plan authority freezes caller config and DTO distinguishes current and frozen quota revisions", async () => {
    const f = make(undefined, 10), binding = await bind(f.service, f.token);
    await invoke(f.service, f.token, binding.managedBindingId);
    const config = planConfig({ revision: "new-policy" }); config.plans[0].periodQuotaUnits = 20;
    const authority = new PlanAuthority(config); config.plans[0].periodQuotaUnits = 999;
    const summary = f.store.entitlementSummary("hosted-a", authority, Date.now);
    expect(authority.plan("starter")?.periodQuotaUnits).toBe(20);
    expect(summary).toMatchObject({ planRevision: "new-policy", quotaPlanRevision: "plans-1", quotaLimitUnits: 10, committedUnits: 1 });
  });
  it("timeout retains UNKNOWN reservation without automatic retry", async () => {
    const f = make(async (_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("timeout")))));
    const binding = await bind(f.service, f.token);
    expect(await (await invoke(f.service, f.token, binding.managedBindingId)).json()).toMatchObject({ code: "GATEWAY_TIMEOUT" });
    invariant(f.store, 0, 1); expect(f.store.usage("hosted-a", "op-1:0")?.status).toBe("UNKNOWN");
  });
  it.each(["column", "foreign-key", "unique", "trigger", "registered"])("damaged M2 schema fails closed without migration metadata: %s", damage => {
    const file = join(directory(), "hosted.db"), db = new DatabaseSync(file);
    MIGRATIONS[0].up(db);
    if (damage === "column") db.exec("ALTER TABLE HostedSession DROP COLUMN expiresAt");
    if (damage === "foreign-key") db.exec("DROP TABLE HostedSession; CREATE TABLE HostedSession(tokenHash TEXT PRIMARY KEY,hostedUserId TEXT NOT NULL,expiresAt INTEGER NOT NULL)");
    if (damage === "unique") db.exec("DROP TABLE ManagedAiBinding; CREATE TABLE ManagedAiBinding(id TEXT PRIMARY KEY,hostedUserId TEXT NOT NULL REFERENCES HostedUser(id),business TEXT NOT NULL,resourceKey TEXT NOT NULL,modelKey TEXT NOT NULL,snapshot TEXT NOT NULL); CREATE TRIGGER ImmutableManagedBinding BEFORE UPDATE ON ManagedAiBinding BEGIN SELECT RAISE(ABORT,'immutable binding'); END");
    if (damage === "trigger") db.exec("DROP TRIGGER ImmutableManagedBinding");
    if (damage === "registered") { db.exec("CREATE TABLE HostedSchemaMigration(version INTEGER PRIMARY KEY,name TEXT NOT NULL,appliedAt INTEGER NOT NULL); INSERT INTO HostedSchemaMigration VALUES(1,'m2-hosted-baseline',1); DROP TRIGGER ImmutableManagedBinding"); }
    const before = db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(); db.close();
    expect(() => new HostedStore(file)).toThrow("Invalid Hosted schema");
    const check = new DatabaseSync(file); expect(check.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()).toEqual(before); check.close();
  });
  it("enforces single active service ownership and releases it on close", () => {
    const file = join(directory(), "hosted.db"), release = acquireServiceOwnership(file);
    expect(() => acquireServiceOwnership(file)).toThrow("already owns"); release();
    const again = acquireServiceOwnership(file); again();
  });
  it("operator dry-run validates with zero DB changes and never creates a fresh DB", () => {
    const dir = directory(), file = join(dir, "hosted.db"), store = new HostedStore(file);
    store.issueSession("hosted-a", Date.now() + 60_000); provision(store, "hosted-a"); store.close();
    const plans = join(dir, "plans.json"); writeFileSync(plans, JSON.stringify(planConfig()));
    const loader = join(dir, "loader.cjs"); writeFileSync(loader, `const ts=require(${JSON.stringify(require.resolve("typescript"))});require.extensions['.ts']=(module,file)=>module._compile(ts.transpileModule(require('node:fs').readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,file);`);
    const cli = (args: string[], database = file) => spawnSync(process.execPath, ["--require", loader, resolve("src/operator-cli.ts"), ...args], { env: { ...process.env, MANAGED_AI_DATABASE_PATH: database, MANAGED_AI_PLAN_PATH: plans }, encoding: "utf8", windowsHide: true });
    const before = readFileSync(file), options = ["set-subscription", "hosted-a", "starter", "ACTIVE", "1000", "2000", "--dry-run"];
    expect(cli(options).status).toBe(0); expect(readFileSync(file)).toEqual(before);
    expect(cli(["set-subscription", "hosted-a", "starter", "ACTIVE", "2000", "1000", "--dry-run"]).status).not.toBe(0); expect(readFileSync(file)).toEqual(before);
    expect(cli(["set-subscription", "missing", "starter", "ACTIVE", "1000", "2000"]).status).not.toBe(0);
    const fresh = join(dir, "fresh.db"); expect(cli(options, fresh).status).not.toBe(0); expect(existsSync(fresh)).toBe(false);
  });
  it("abort after dispatch remains reserved", async () => {
    const controller = new AbortController(), f = make(async (_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener("abort", () => reject(new Error("abort")))));
    const binding = await bind(f.service, f.token);
    const input = { bindingId: binding.managedBindingId, modelKey: "vocatrya-fast", prompt: "x", operationId: "op-abort", invocationKey: "op-abort:0", attemptIndex: 0 };
    const original = f.service.handle(new Request("https://hosted.example/v1/text", { method: "POST", headers: { authorization: `Bearer ${f.token}` }, signal: controller.signal, body: JSON.stringify(input) }));
    await vi.waitFor(() => expect(f.store.usage("hosted-a", "op-abort:0")?.status).toBe("RUNNING")); controller.abort(); await original;
    expect(f.store.usage("hosted-a", "op-abort:0")?.settlement).toBe("RESERVED"); invariant(f.store, 0, 1);
  });
});

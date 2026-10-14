import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelCatalog } from "../src/catalog";
import { ManagedGatewayRuntime, VERIFIED_GATEWAY_CAPABILITIES } from "../src/gateway";
import { HostedStore } from "../src/store";
import { HostedManagedService } from "../src/service";
import { createHostedServer } from "../src/http";
import { PlanAuthority } from "../src/plan";
import { OperatorStore } from "../src/operator/store";
import { OperatorService, maskBaseUrl } from "../src/operator/service";
import { catalogConfig, fakeText, planConfig, secret } from "./helpers";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanup.length) await cleanup.pop()!(); });
function directory() { const dir = mkdtempSync(join(tmpdir(), "operator-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }

interface Fixture {
  hosted: HostedStore;
  operator: OperatorStore;
  service: OperatorService;
  hostedService: HostedManagedService;
  credential: { id: string; secret: string };
  probeFetch: ReturnType<typeof vi.fn>;
}
function fixture(opts: { file?: string; baseUrl?: string | null } = {}): Fixture {
  const hosted = new HostedStore(opts.file ?? ":memory:");
  let closed = false;
  cleanup.push(() => { if (!closed) { closed = true; hosted.close(); } });
  const close = hosted.close.bind(hosted);
  hosted.close = () => { closed = true; close(); };
  const operator = new OperatorStore(hosted.internalDb());
  const credential = operator.createCredential("owner", { credentialId: "test-fixture" });
  const probeFetch = vi.fn(async () => new Response(null, { status: 200 }));
  const catalog = catalogConfig();
  const plans = new PlanAuthority(planConfig());
  const provider = { label: "test-provider", baseUrl: opts.baseUrl === undefined ? "https://provider.example/v1" : opts.baseUrl };
  const service = new OperatorService(hosted, operator, catalog, plans, provider, { fetchImpl: probeFetch as unknown as typeof fetch });
  const hostedService = new HostedManagedService(hosted, new ModelCatalog(catalog, VERIFIED_GATEWAY_CAPABILITIES), plans,
    new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret, timeoutMs: 1000 }, async () => fakeText()));
  return { hosted, operator, service, hostedService, credential, probeFetch };
}
function call(service: OperatorService, token: string | null, method: string, path: string, body?: unknown) {
  return service.handle(new Request(`http://127.0.0.1:8790${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}
async function login(f: Fixture, secretValue = f.credential.secret): Promise<string> {
  const res = await call(f.service, null, "POST", "/operator/v1/session", { credential: secretValue });
  expect(res.status).toBe(200);
  return (await res.json() as { token: string }).token;
}
async function hostedInvoke(f: Fixture, hostedToken: string, bindingId: string, invocationKey = "op-1:0") {
  return f.hostedService.handle(new Request("https://hosted.example/v1/text", {
    method: "POST", headers: { authorization: `Bearer ${hostedToken}`, "content-type": "application/json" },
    body: JSON.stringify({ bindingId, modelKey: "vocatrya-fast", prompt: "hello", operationId: "op-1", invocationKey, attemptIndex: 0 }),
  }));
}
async function setupEntitledUser(f: Fixture, uid = "hosted-a") {
  const op = await login(f);
  expect((await call(f.service, op, "POST", "/operator/v1/users", { hostedUserId: uid })).status).toBe(200);
  const now = Date.now();
  const sub = await call(f.service, op, "POST", `/operator/v1/users/${uid}/subscription/provision`,
    { planKey: "starter", periodStart: now - 1000, periodEnd: now + 60_000 });
  expect(sub.status).toBe(200);
  const issued = await call(f.service, op, "POST", `/operator/v1/users/${uid}/sessions`, {});
  expect(issued.status).toBe(200);
  const hostedToken = (await issued.json() as { token: string }).token;
  const bind = await f.hostedService.handle(new Request("https://hosted.example/v1/bindings", {
    method: "POST", headers: { authorization: `Bearer ${hostedToken}`, "content-type": "application/json" },
    body: JSON.stringify({ modelKey: "vocatrya-fast", business: "RESUME", resourceKey: "res-1" }),
  }));
  expect(bind.status).toBe(200);
  return { op, hostedToken, bindingId: (await bind.json() as { managedBindingId: string }).managedBindingId };
}
function auditActions(f: Fixture): string[] {
  return (f.hosted.internalDb().prepare("SELECT action FROM OperatorAudit").all() as { action: string }[]).map(row => row.action);
}

describe("Operator identity and session isolation", () => {
  it("issues sessions only for valid unre revoked credentials and audits both outcomes", async () => {
    const f = fixture();
    expect((await call(f.service, null, "POST", "/operator/v1/session", { credential: "opc_wrongwrongwrongwrongwrongwrongwrongwrongwrongXX" })).status).toBe(401);
    expect((await call(f.service, null, "POST", "/operator/v1/session", { credential: "not-a-credential" })).status).toBe(401);
    const token = await login(f);
    expect((await call(f.service, token, "GET", "/operator/v1/overview")).status).toBe(200);
    expect(auditActions(f)).toEqual(["credential.create", "session.login", "session.login", "session.login"]); // fixture issuance, then two denied logins
    const audit = f.hosted.internalDb().prepare("SELECT result, credentialId FROM OperatorAudit ORDER BY createdAt, rowid").all() as { result: string; credentialId: string | null }[];
    expect(audit.map(row => row.result)).toEqual(["OK", "DENIED", "DENIED", "OK"]);
    expect(audit[1].credentialId).toBeNull();
    expect(audit[3].credentialId).toBe(f.credential.id);
  });
  it("is bidirectionally isolated from hosted sessions", async () => {
    const f = fixture();
    const opToken = await login(f);
    const hostedToken = f.hosted.issueSession("hosted-a", Date.now() + 60_000);
    expect((await call(f.service, hostedToken, "GET", "/operator/v1/overview")).status).toBe(401);
    expect((await call(f.service, f.credential.secret, "GET", "/operator/v1/overview")).status).toBe(401);
    const hostedRes = await f.hostedService.handle(new Request("https://hosted.example/v1/session", { headers: { authorization: `Bearer ${opToken}` } }));
    expect(hostedRes.status).toBe(401);
  });
  it("revoking a credential invalidates its sessions immediately; logout revokes the session", async () => {
    const f = fixture();
    const token = await login(f);
    expect(f.operator.revokeCredential(f.credential.id, { credentialId: "test-fixture" })).toBe(true);
    expect((await call(f.service, token, "GET", "/operator/v1/overview")).status).toBe(401);
    const second = f.operator.createCredential("owner-2", { credentialId: "test-fixture" });
    const token2 = await login(f, second.secret);
    expect((await call(f.service, token2, "DELETE", "/operator/v1/session")).status).toBe(200);
    expect((await call(f.service, token2, "GET", "/operator/v1/overview")).status).toBe(401);
  });
  it("serves the console shell without a session but requires auth for every API route", async () => {
    const f = fixture();
    for (const path of ["/", "/index.html", "/app.js", "/style.css"]) {
      const res = await call(f.service, null, "GET", path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    for (const path of ["/operator/v1/overview", "/operator/v1/users", "/operator/v1/usage", "/operator/v1/runtime", "/operator/v1/audit"])
      expect((await call(f.service, null, "GET", path)).status).toBe(401);
    expect((await call(f.service, null, "GET", "/operator/v1/nope")).status).toBe(401);
  });
});

describe("Subscriptions via operator API", () => {
  it("provisions, sets and revokes with idempotency and audit", async () => {
    const f = fixture();
    const op = await login(f);
    await call(f.service, op, "POST", "/operator/v1/users", { hostedUserId: "u1" });
    const now = Date.now();
    const body = { planKey: "starter", status: "ACTIVE", periodStart: now - 1000, periodEnd: now + 60_000, idempotencyKey: "key-1" };
    const first = await (await call(f.service, op, "POST", "/operator/v1/users/u1/subscription/set", body)).json() as { subscription: { revision: number }; replayed: boolean };
    expect(first.subscription.revision).toBe(1); expect(first.replayed).toBe(false);
    const replay = await (await call(f.service, op, "POST", "/operator/v1/users/u1/subscription/set", body)).json() as { subscription: { revision: number }; replayed: boolean };
    expect(replay.subscription.revision).toBe(1); expect(replay.replayed).toBe(true);
    const conflict = await call(f.service, op, "POST", "/operator/v1/users/u1/subscription/set", { ...body, status: "PAST_DUE" });
    expect(conflict.status).toBe(409);
    const revoke = await call(f.service, op, "POST", "/operator/v1/users/u1/subscription/revoke", {});
    expect((await revoke.json() as { subscription: { status: string } }).subscription.status).toBe("CANCELED");
    expect(f.hosted.subscription("u1")?.status).toBe("CANCELED");
    for (const action of ["subscription.set", "subscription.revoke"]) expect(auditActions(f)).toContain(action);
  });
  it("validates input, requires an existing user and a known enabled plan", async () => {
    const f = fixture();
    const op = await login(f);
    const now = Date.now();
    expect((await call(f.service, op, "POST", "/operator/v1/users/ghost/subscription/set", { planKey: "starter", status: "ACTIVE", periodStart: now, periodEnd: now + 1 })).status).toBe(404);
    await call(f.service, op, "POST", "/operator/v1/users", { hostedUserId: "u2" });
    expect((await call(f.service, op, "POST", "/operator/v1/users/u2/subscription/set", { planKey: "nope", status: "ACTIVE", periodStart: now, periodEnd: now + 1 })).status).toBe(400);
    expect((await call(f.service, op, "POST", "/operator/v1/users/u2/subscription/set", { planKey: "starter", status: "WEIRD", periodStart: now, periodEnd: now + 1 })).status).toBe(400);
    expect((await call(f.service, op, "POST", "/operator/v1/users/u2/subscription/set", { planKey: "starter", status: "ACTIVE", periodStart: now + 1, periodEnd: now })).status).toBe(400);
    expect((await call(f.service, op, "POST", "/operator/v1/users/u2/subscription/set", { planKey: "starter", status: "ACTIVE", periodStart: now, periodEnd: now + 1, injected: true })).status).toBe(400);
  });
  it("revokes a subscription whose plan was retired from plan.json", async () => {
    const f = fixture();
    const op = await login(f);
    await call(f.service, op, "POST", "/operator/v1/users", { hostedUserId: "u-retired" });
    f.hosted.setSubscription("u-retired", { planKey: "retired-plan", status: "ACTIVE", periodStart: Date.now() - 1000, periodEnd: Date.now() + 60_000, source: "OPERATOR_CONSOLE" });
    const revoke = await call(f.service, op, "POST", "/operator/v1/users/u-retired/subscription/revoke", {});
    expect(revoke.status).toBe(200);
    expect(f.hosted.subscription("u-retired")?.status).toBe("CANCELED");
    expect((await call(f.service, op, "POST", "/operator/v1/users/u-retired/subscription/bogus", {})).status).toBe(404);
  });
});

describe("Hosted session issuance via operator API", () => {
  it("shows the token once, never stores it, and revokes by hash prefix", async () => {
    const f = fixture();
    const op = await login(f);
    await call(f.service, op, "POST", "/operator/v1/users", { hostedUserId: "sess-user" });
    const issued = await (await call(f.service, op, "POST", "/operator/v1/users/sess-user/sessions", {})).json() as { token: string; expiresAt: number };
    expect(issued.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const hostedRes = await f.hostedService.handle(new Request("https://hosted.example/v1/session", { headers: { authorization: `Bearer ${issued.token}` } }));
    expect(hostedRes.status).toBe(200);
    const detail = await (await call(f.service, op, "GET", "/operator/v1/users/sess-user")).json() as { activeSessions: { prefix: string }[] };
    expect(detail.activeSessions).toHaveLength(1);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(issued.token);
    const revoked = await (await call(f.service, op, "POST", "/operator/v1/users/sess-user/sessions/revoke", { prefix: detail.activeSessions[0].prefix })).json() as { revoked: number };
    expect(revoked.revoked).toBe(1);
    expect((await f.hostedService.handle(new Request("https://hosted.example/v1/session", { headers: { authorization: `Bearer ${issued.token}` } }))).status).toBe(401);
    expect(auditActions(f)).toEqual(expect.arrayContaining(["hostedsession.issue", "hostedsession.revoke"]));
    const auditText = JSON.stringify(f.hosted.internalDb().prepare("SELECT * FROM OperatorAudit").all());
    expect(auditText).not.toContain(issued.token);
  });
});

describe("Staged catalog", () => {
  it("stores validated and invalid revisions for review without touching the effective catalog", async () => {
    const f = fixture();
    const op = await login(f);
    const staged = catalogConfig({ revision: "catalog-staged-2" });
    staged.models[0].upstreamModelId = "vendor-v2";
    const res = await call(f.service, op, "POST", "/operator/v1/catalog/staged", { catalog: staged });
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe("VALIDATED");
    const effective = await (await f.hostedService.handle(new Request("https://hosted.example/v1/catalog", { headers: { authorization: `Bearer ${f.hosted.issueSession("x2", Date.now() + 60000)}` } }))).json() as { revision: string };
    expect(effective.revision).toBe("catalog-1");
    const dup = await call(f.service, op, "POST", "/operator/v1/catalog/staged", { catalog: staged });
    expect(dup.status).toBe(409);
    const broken = { revision: "catalog-broken", managedAiEnabled: true, defaultModelKey: "missing", models: [] };
    const bad = await call(f.service, op, "POST", "/operator/v1/catalog/staged", { catalog: broken });
    expect((await bad.json() as { status: string }).status).toBe("INVALID");
    const list = await (await call(f.service, op, "GET", "/operator/v1/catalog/staged")).json() as { items: { id: string; revision: string; status: string }[] };
    expect(list.items.map(i => i.revision).sort()).toEqual(["catalog-broken", "catalog-staged-2"]);
    const stagedId = list.items.find(i => i.revision === "catalog-staged-2")!.id;
    const detail = await (await call(f.service, op, "GET", `/operator/v1/catalog/staged/${stagedId}`)).json() as { revision: string; payload: { revision: string } };
    expect(detail.revision).toBe("catalog-staged-2");
    expect(detail.payload.revision).toBe("catalog-staged-2");
    expect(auditActions(f)).toContain("catalog.stage");
  });
  it("flags staged catalogs that drop models still referenced by plan policy", async () => {
    const f = fixture();
    const op = await login(f);
    const renamed = catalogConfig({ revision: "catalog-no-fast" });
    renamed.models[0].modelKey = "other-model";
    renamed.defaultModelKey = "other-model";
    const res = await call(f.service, op, "POST", "/operator/v1/catalog/staged", { catalog: renamed });
    const body = await res.json() as { status: string; validationErrors: string[] };
    expect(body.status).toBe("INVALID");
    expect(body.validationErrors.join(" ")).toContain("plan");
  });
});

describe("Runtime kill switch", () => {
  it("blocks new admissions inside the reservation transaction while replays and in-flight settlement proceed", async () => {
    const f = fixture();
    const { hostedToken, bindingId } = await setupEntitledUser(f);
    expect((await hostedInvoke(f, hostedToken, bindingId)).status).toBe(200);
    const op = await login(f);
    const disabled = await (await call(f.service, op, "POST", "/operator/v1/runtime/disable", { reason: "upstream incident" })).json() as { disabled: boolean };
    expect(disabled.disabled).toBe(true);
    const blocked = await hostedInvoke(f, hostedToken, bindingId, "op-2:0");
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toEqual({ code: "MANAGED_AI_DISABLED", message: "MANAGED_AI_DISABLED" });
    expect(f.hosted.usage("hosted-a", "op-2:0")).toBeNull();
    const replay = await hostedInvoke(f, hostedToken, bindingId, "op-1:0");
    expect((await replay.json() as { executionState: string }).executionState).toBe("REPLAYED");
    const enabled = await (await call(f.service, op, "POST", "/operator/v1/runtime/enable", { reason: "resolved" })).json() as { disabled: boolean };
    expect(enabled.disabled).toBe(false);
    expect((await hostedInvoke(f, hostedToken, bindingId, "op-3:0")).status).toBe(200);
    expect(auditActions(f)).toEqual(expect.arrayContaining(["runtime.disable", "runtime.enable"]));
  });
  it("lets an in-flight admitted invocation settle after the switch", async () => {
    const f = fixture();
    const { hostedToken, bindingId } = await setupEntitledUser(f);
    let release!: (r: Response) => void;
    const slowGateway = new ManagedGatewayRuntime({ baseUrl: "https://gateway.example/v1", apiKey: secret, timeoutMs: 5000 },
      () => new Promise<Response>(resolve => { release = resolve; }));
    const service = new HostedManagedService(f.hosted, new ModelCatalog(catalogConfig(), VERIFIED_GATEWAY_CAPABILITIES), new PlanAuthority(planConfig()), slowGateway);
    const pending = service.handle(new Request("https://hosted.example/v1/text", {
      method: "POST", headers: { authorization: `Bearer ${hostedToken}`, "content-type": "application/json" },
      body: JSON.stringify({ bindingId, modelKey: "vocatrya-fast", prompt: "hi", operationId: "op-slow", invocationKey: "op-slow:0", attemptIndex: 0 }),
    }));
    await vi.waitFor(() => expect(f.hosted.usage("hosted-a", "op-slow:0")?.status === "RUNNING" || f.hosted.usage("hosted-a", "op-slow:0")?.status === "RESERVED").toBe(true));
    const op = await login(f);
    await call(f.service, op, "POST", "/operator/v1/runtime/disable", { reason: "incident" });
    release(fakeText());
    expect((await pending).status).toBe(200);
    expect(f.hosted.usage("hosted-a", "op-slow:0")).toMatchObject({ status: "SUCCEEDED", settlement: "COMMITTED" });
  });
  it("fails closed when the runtime state row is missing or unreadable", async () => {
    const f = fixture();
    const { hostedToken, bindingId } = await setupEntitledUser(f);
    f.hosted.internalDb().prepare("DELETE FROM ManagedAiRuntimeState WHERE id=1").run();
    expect(f.operator.runtimeState().disabled).toBe(true);
    const blocked = await hostedInvoke(f, hostedToken, bindingId, "op-missing:0");
    expect(blocked.status).toBe(400);
    expect(await blocked.json()).toEqual({ code: "MANAGED_AI_DISABLED", message: "MANAGED_AI_DISABLED" });
    f.hosted.internalDb().prepare("INSERT INTO ManagedAiRuntimeState(id, disabled, updatedAt) VALUES (1, 0, 0)").run();
    expect((await hostedInvoke(f, hostedToken, bindingId, "op-back:0")).status).toBe(200);
  });
  it("persists the disabled state across process restarts", async () => {
    const dir = directory();
    const file = join(dir, "hosted.db");
    const first = fixture({ file });
    const { hostedToken, bindingId } = await setupEntitledUser(first);
    const op = await login(first);
    await call(first.service, op, "POST", "/operator/v1/runtime/disable", { reason: "persisted" });
    first.hosted.close();
    const second = fixture({ file });
    const blocked = await hostedInvoke(second, hostedToken, bindingId, "op-restart:0");
    expect(blocked.status).toBe(400);
    expect(second.operator.runtimeState().disabled).toBe(true);
    expect(second.operator.runtimeState().reason).toBe("persisted");
  });
  it("never rewrites UNKNOWN ledger rows and exposes no ledger mutation route", async () => {
    const f = fixture();
    const { hostedToken, bindingId } = await setupEntitledUser(f);
    const created = f.hosted.reserveInvocation({ hostedUserId: "hosted-a", business: "RESUME", resourceKey: "res-1", binding: f.hosted.binding(bindingId, "hosted-a"),
      plans: new PlanAuthority(planConfig()), now: () => Date.now(), operationId: "op-u", invocationKey: "op-u:0", attemptIndex: 0, requestHash: "h" });
    if (!created.created) throw new Error("setup");
    f.hosted.settleUnknown(created.usage.id, "GATEWAY_TIMEOUT", Date.now());
    const op = await login(f);
    const list = await (await call(f.service, op, "GET", "/operator/v1/usage?status=UNKNOWN")).json() as { items: { status: string; settlement: string }[] };
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ status: "UNKNOWN", settlement: "RESERVED" });
    expect((await call(f.service, op, "POST", "/operator/v1/usage", { anything: true })).status).toBe(404);
    const raw = f.hosted.internalDb().prepare("SELECT status, settlement FROM ManagedAiUsage WHERE id=?").get(created.usage.id) as { status: string; settlement: string };
    expect(raw).toEqual({ status: "UNKNOWN", settlement: "RESERVED" });
  });
});

describe("Provider view and probe", () => {
  it("masks the base URL and never sends credentials on probe", async () => {
    expect(maskBaseUrl("https://provider.example/v1")).toBe("https://provider.example/…");
    expect(maskBaseUrl("https://provider.example/tenant-id/openai/deployments/x")).toBe("https://provider.example/…");
    expect(maskBaseUrl("https://provider.example")).toBe("https://provider.example");
    expect(maskBaseUrl("not a url")).toBeNull();
    const f = fixture();
    const op = await login(f);
    const res = await call(f.service, op, "POST", "/operator/v1/provider/probe", {});
    expect(res.status).toBe(200);
    expect(f.probeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = f.probeFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://provider.example/");
    expect(init.method).toBe("HEAD");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
    const probe = await res.json() as { ok: boolean; httpStatus: number };
    expect(probe).toMatchObject({ ok: true, httpStatus: 200 });
    const view = await (await call(f.service, op, "GET", "/operator/v1/provider")).json() as { baseUrlMasked: string; lastProbe: { ok: boolean } };
    expect(view.baseUrlMasked).toBe("https://provider.example/…");
    expect(view.lastProbe.ok).toBe(true);
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(auditActions(f)).toContain("provider.probe");
  });
  it("reports unconfigured provider and unreachable probe without leaking internals", async () => {
    const f = fixture({ baseUrl: null });
    const op = await login(f);
    expect((await call(f.service, op, "POST", "/operator/v1/provider/probe", {})).status).toBe(400);
    const g = fixture({ baseUrl: "https://down.example/v1" });
    g.probeFetch.mockRejectedValue(new Error("ENOTFOUND down.example"));
    const gop = await login(g);
    const res = await call(g.service, gop, "POST", "/operator/v1/provider/probe", {});
    const probe = await res.json() as { ok: boolean; error: string };
    expect(probe.ok).toBe(false);
    expect(probe.error).toBe("UNREACHABLE");
    expect(JSON.stringify(probe)).not.toContain("ENOTFOUND");
  });
});

describe("Listing, DTO whitelist and pagination", () => {
  it("paginates users with search and never exposes token material", async () => {
    const f = fixture();
    const op = await login(f);
    for (const id of ["u-a", "u-b", "u-c"]) await call(f.service, op, "POST", "/operator/v1/users", { hostedUserId: id });
    const page1 = await (await call(f.service, op, "GET", "/operator/v1/users?limit=2")).json() as { items: { hostedUserId: string }[]; nextCursor: string | null };
    expect(page1.items).toHaveLength(2); expect(page1.nextCursor).toBeTruthy();
    const page2 = await (await call(f.service, op, "GET", `/operator/v1/users?limit=2&cursor=${encodeURIComponent(page1.nextCursor!)}`)).json() as { items: { hostedUserId: string }[]; nextCursor: string | null };
    expect(page2.items).toHaveLength(1); expect(page2.nextCursor).toBeNull();
    const searched = await (await call(f.service, op, "GET", "/operator/v1/users?search=u-b")).json() as { items: { hostedUserId: string }[] };
    expect(searched.items.map(i => i.hostedUserId)).toEqual(["u-b"]);
    expect(JSON.stringify(page1)).not.toMatch(/tokenHash|secretHash|token|secret/i);
  });
  it("whitelists usage fields and excludes internal hashes", async () => {
    const f = fixture();
    const { hostedToken, bindingId } = await setupEntitledUser(f);
    await hostedInvoke(f, hostedToken, bindingId);
    const op = await login(f);
    const list = await (await call(f.service, op, "GET", "/operator/v1/usage?user=hosted-a")).json() as { items: Record<string, unknown>[] };
    expect(list.items).toHaveLength(1);
    const row = list.items[0];
    for (const forbidden of ["requestHash", "gatewayRequestId", "quotaPeriodId"]) expect(row).not.toHaveProperty(forbidden);
    for (const expected of ["id", "hostedUserId", "status", "settlement", "chargedUnits", "modelKey", "invocationKey"]) expect(row).toHaveProperty(expected);
    const filtered = await (await call(f.service, op, "GET", "/operator/v1/usage?status=FAILED")).json() as { items: unknown[] };
    expect(filtered.items).toHaveLength(0);
  });
  it("paginates audit rows that share a millisecond without dropping any", async () => {
    const f = fixture();
    const fixed = new OperatorStore(f.hosted.internalDb(), () => 5_000_000);
    fixed.audit({ credentialId: null, action: "probe.a", target: null, detail: null, result: "OK" });
    fixed.audit({ credentialId: null, action: "probe.b", target: null, detail: null, result: "OK" });
    const page1 = f.operator.listAudit(null, 1);
    expect(page1.items).toHaveLength(1);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = f.operator.listAudit(page1.nextCursor, 10);
    const all = [page1.items[0], ...page2.items].map(item => item.action);
    expect(all).toEqual(expect.arrayContaining(["probe.a", "probe.b", "credential.create"]));
  });
});

describe("HTTP surface hardening", () => {
  it("binds loopback only and applies security headers over real HTTP", async () => {
    const f = fixture();
    const server = createHostedServer(f.service);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    cleanup.push(() => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    expect(address.address).toBe("127.0.0.1");
    const res = await fetch(`http://127.0.0.1:${address.port}/operator/v1/overview`);
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await fetch(`http://127.0.0.1:${address.port}/`);
    expect(html.headers.get("content-security-policy")).toContain("connect-src 'self'");
  });
  it("rejects malformed bodies, unknown methods and out-of-range limits", async () => {
    const f = fixture();
    const op = await login(f);
    const bad = await f.service.handle(new Request("http://127.0.0.1/operator/v1/users", { method: "POST", headers: { authorization: `Bearer ${op}` }, body: "{not json" }));
    expect(bad.status).toBe(400);
    expect((await call(f.service, op, "DELETE", "/operator/v1/users/u-a")).status).toBe(404);
    expect((await call(f.service, op, "GET", "/operator/v1/users?limit=10000")).status).toBe(400);
    expect((await f.service.handle(new Request("http://127.0.0.1/operator/v1/users", { method: "POST", headers: { authorization: `Bearer ${op}`, "content-type": "application/json" }, body: JSON.stringify({ hostedUserId: "x".repeat(300), extra: 1 }) }))).status).toBe(400);
  });
});

describe("Operator data access is read-only over hosted authority", () => {
  it("cannot promote a hosted user and stores only credential digests", async () => {
    const f = fixture();
    const rows = f.hosted.internalDb().prepare("SELECT secretHash FROM OperatorCredential").all() as { secretHash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].secretHash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].secretHash).not.toContain(f.credential.secret);
    const op = await login(f);
    for (const path of ["/operator/v1/credentials", "/operator/v1/users/u-a/promote", "/operator/v1/credential"])
      expect((await call(f.service, op, "POST", path, {})).status).toBe(404);
  });
});

import { randomUUID } from "node:crypto";
import { ManagedError } from "../../../../src/lib/ai/managed-contract";
import { validateCatalog, type ManagedCatalog } from "../catalog";
import { PlanAuthority } from "../plan";
import { HostedStore, type SetSubscriptionInput } from "../store";
import { SUBSCRIPTION_STATUSES, USAGE_STATUSES, type HostedSubscription, type SubscriptionStatus } from "../types";
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS } from "./console-assets";
import { OperatorStore, type OperatorIdentity } from "./store";

/** Operator wire errors are local to this service; hosted ManagedError codes are mapped at the boundary. */
class OperatorError extends Error {
  constructor(public readonly code: string, public readonly status: number) { super(code); this.name = "OperatorError"; }
}
function fail(code: string, status = 400): never { throw new OperatorError(code, status); }

const BODY_LIMIT = 256 * 1024;
const MAX_LIMIT = 100;

function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) fail("VALIDATION_FAILED");
  return raw as Record<string, unknown>;
}
function str(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) fail("VALIDATION_FAILED");
  return value;
}
function optStr(value: unknown, max = 512): string | null {
  if (value === undefined || value === null) return null;
  return str(value, "optional", max);
}
function boolOpt(value: unknown): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") fail("VALIDATION_FAILED");
  return value;
}
/** Accepts integer epoch-ms or an ISO-8601 string, mirroring the operator CLI. */
function tsValue(value: unknown, name: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string") {
    if (/^\d+$/.test(value)) { const ms = Number(value); if (Number.isSafeInteger(ms) && ms >= 0) return ms; }
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  fail("VALIDATION_FAILED");
}
function limitParam(params: URLSearchParams): number {
  const raw = params.get("limit");
  if (raw === null) return 50;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) fail("VALIDATION_FAILED");
  return value;
}

export interface OperatorProvider { label: string; baseUrl: string | null }
/** Origin only — the path may embed tenant or deployment identifiers and is never displayed. */
export function maskBaseUrl(baseUrl: string | null): string | null {
  if (!baseUrl) return null;
  try {
    const url = new URL(baseUrl);
    return url.origin + (url.pathname === "/" ? "" : "/…");
  } catch { return null; }
}
export interface OperatorServiceOptions { now?: () => number; fetchImpl?: typeof fetch; probeTimeoutMs?: number }

const CONTENT_TYPES: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };
const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "cross-origin-resource-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** Explicit whitelist DTOs — raw rows never leave the service. */
const subscriptionDto = (s: HostedSubscription) => ({
  planKey: s.planKey, status: s.status, periodStart: s.periodStart, periodEnd: s.periodEnd,
  cancelAtPeriodEnd: Number(s.cancelAtPeriodEnd) === 1, source: s.source, externalSubscriptionRef: s.externalSubscriptionRef,
  sourceRevision: s.sourceRevision, revision: s.revision, createdAt: s.createdAt, updatedAt: s.updatedAt,
});
const usageDto = (u: Record<string, unknown>) => ({
  id: u.id, hostedUserId: u.hostedUserId, business: u.business, resourceKey: u.resourceKey,
  operationId: u.operationId, invocationKey: u.invocationKey, attemptIndex: u.attemptIndex,
  managedBindingId: u.managedBindingId, modelKey: u.modelKey, upstreamModelId: u.upstreamModelId, actualModel: u.actualModel,
  status: u.status, settlement: u.settlement, reservedUnits: u.reservedUnits, chargedUnits: u.chargedUnits,
  inputTokens: u.inputTokens, outputTokens: u.outputTokens, latencyMs: u.latencyMs, errorCategory: u.errorCategory,
  createdAt: u.createdAt, completedAt: u.completedAt,
});
const quotaDto = (q: Record<string, unknown>) => ({
  id: q.id, periodStart: q.periodStart, periodEnd: q.periodEnd, planKey: q.planKey, planRevision: q.planRevision,
  quotaLimitUnits: q.quotaLimitUnits, reservedUnits: q.reservedUnits, committedUnits: q.committedUnits,
  createdAt: q.createdAt, updatedAt: q.updatedAt,
});
const bindingDto = (b: Record<string, unknown>) => ({
  id: b.id, business: b.business, resourceKey: b.resourceKey, modelKey: b.modelKey,
  upstreamModelId: b.upstreamModelId, mappingRevision: b.mappingRevision, adapterContractRevision: b.adapterContractRevision,
  allowedModelAliases: b.allowedModelAliases, maxInputTokens: b.maxInputTokens, maxOutputTokens: b.maxOutputTokens, createdAt: b.createdAt,
});

/**
 * Loopback-only Operator management surface. It shares the authority database
 * with the hosted service but is a separate listener, credential authority and
 * audit trail. There is deliberately no route that mutates ManagedAiUsage,
 * ManagedAiBinding, plan policy, provider credentials, or that activates a
 * staged catalog.
 */
export class OperatorService {
  private readonly now: () => number;
  private readonly fetchImpl: typeof fetch;
  private readonly probeTimeoutMs: number;
  constructor(
    private readonly hosted: HostedStore,
    private readonly operator: OperatorStore,
    private readonly catalog: ManagedCatalog,
    private readonly plans: PlanAuthority,
    private readonly provider: OperatorProvider,
    options: OperatorServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (request.method === "GET") {
        if (path === "/" || path === "/index.html") return this.asset("html", CONSOLE_HTML);
        if (path === "/app.js") return this.asset("js", CONSOLE_JS);
        if (path === "/style.css") return this.asset("css", CONSOLE_CSS);
      }
      if (path === "/operator/v1/session") {
        if (request.method === "POST") return await this.login(request);
        if (request.method === "DELETE") {
          const identity = this.authenticate(request);
          this.operator.logout(identity.tokenHash);
          this.operator.audit({ credentialId: identity.credentialId, action: "session.logout", target: null, detail: null, result: "OK" });
          return this.json({ revoked: true });
        }
        return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
      }
      if (!path.startsWith("/operator/v1/")) return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
      const identity = this.authenticate(request);
      return await this.dispatch(identity, request, path, url.searchParams);
    } catch (error) {
      if (error instanceof ManagedError) {
        const status = error.code === "MANAGED_AUTH_REQUIRED" ? 401 : 400;
        return this.json({ code: status === 401 ? "OPERATOR_AUTH_REQUIRED" : error.code, message: error.code }, status);
      }
      if (error instanceof OperatorError) return this.json({ code: error.code, message: error.code }, error.status);
      return this.json({ code: "INTERNAL_ERROR", message: "INTERNAL_ERROR" }, 500);
    }
  }

  private authenticate(request: Request): OperatorIdentity {
    return this.operator.authenticate(request.headers.get("authorization"));
  }

  private async dispatch(identity: OperatorIdentity, request: Request, path: string, params: URLSearchParams): Promise<Response> {
    let segments: string[];
    try { segments = path.slice("/operator/v1/".length).split("/").map(decodeURIComponent); }
    catch { return this.json({ code: "VALIDATION_FAILED", message: "VALIDATION_FAILED" }, 400); }
    if (request.method === "GET") {
      if (path === "/operator/v1/overview") return this.overview();
      if (path === "/operator/v1/provider") return this.providerView();
      if (path === "/operator/v1/catalog") return this.json(this.catalogDto());
      if (path === "/operator/v1/catalog/staged") return this.json({ items: this.operator.listStagedCatalogs(limitParam(params)) });
      if (segments[0] === "catalog" && segments[1] === "staged" && segments.length === 3) {
        const staged = this.operator.stagedCatalog(segments[2]);
        if (!staged) return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
        return this.json(staged);
      }
      if (path === "/operator/v1/plans") return this.json({ revision: this.plans.revision, plans: this.plans.plans });
      if (path === "/operator/v1/users") return this.usersList(params);
      if (segments[0] === "users" && segments.length === 2) return this.userDetail(segments[1]);
      if (path === "/operator/v1/usage") return this.usageList(params);
      if (path === "/operator/v1/audit") {
        const cursor = params.get("cursor");
        if (cursor !== null && !/^\d+:[^\s:]+$/.test(cursor)) fail("VALIDATION_FAILED");
        const page = this.operator.listAudit(cursor, limitParam(params));
        return this.json(page);
      }
      if (path === "/operator/v1/runtime") return this.json(this.operator.runtimeState());
      return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
    }
    if (request.method !== "POST") return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
    const body = await boundedBody(request);
    if (path === "/operator/v1/users") return this.createUser(identity, body);
    if (segments[0] === "users" && segments.length === 4 && segments[2] === "subscription" &&
      (segments[3] === "provision" || segments[3] === "set" || segments[3] === "revoke"))
      return this.writeSubscription(identity, segments[1], segments[3], body);
    if (segments[0] === "users" && segments.length === 3 && segments[2] === "sessions") return this.issueHostedSession(identity, segments[1], body);
    if (segments[0] === "users" && segments.length === 4 && segments[2] === "sessions" && segments[3] === "revoke") return this.revokeHostedSessions(identity, segments[1], body);
    if (path === "/operator/v1/catalog/staged") return this.stageCatalog(identity, body);
    if (path === "/operator/v1/provider/probe") return this.probe(identity);
    if (path === "/operator/v1/runtime/disable" || path === "/operator/v1/runtime/enable") return this.setRuntime(identity, body, path.endsWith("disable"));
    return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
  }

  // ---- session (unauthenticated; the credential exchange is the trusted entry) ----
  private async login(request: Request): Promise<Response> {
    const body = record(await boundedBody(request), ["credential"]);
    const result = this.operator.login(str(body.credential, "credential", 128));
    if (!result.ok) {
      this.operator.audit({ credentialId: result.credentialId, action: "session.login", target: null, detail: null, result: "DENIED" });
      return this.json({ code: "OPERATOR_AUTH_REQUIRED", message: "OPERATOR_AUTH_REQUIRED" }, 401);
    }
    this.operator.audit({ credentialId: result.credentialId, action: "session.login", target: null, detail: null, result: "OK" });
    // The session token is returned exactly once, in this response body only.
    return this.json({ token: result.token, expiresAt: result.expiresAt, credentialLabel: result.label });
  }

  // ---- A. Overview ----
  private overview(): Response {
    return this.json({
      ...this.operator.overview(this.now()),
      catalog: { revision: this.catalog.revision, managedAiEnabled: this.catalog.managedAiEnabled, models: this.catalog.models.length },
      plans: { revision: this.plans.revision, plans: this.plans.plans.length },
      provider: { label: this.provider.label, baseUrlMasked: maskBaseUrl(this.provider.baseUrl), lastProbe: this.operator.lastProbe() },
    });
  }

  // ---- B. Provider & Models ----
  private providerView(): Response {
    return this.json({
      label: this.provider.label, baseUrlMasked: maskBaseUrl(this.provider.baseUrl),
      configured: this.provider.baseUrl !== null,
      catalog: this.catalogDto(),
      lastProbe: this.operator.lastProbe(),
    });
  }
  private catalogDto() {
    return {
      revision: this.catalog.revision, managedAiEnabled: this.catalog.managedAiEnabled, defaultModelKey: this.catalog.defaultModelKey,
      models: [...this.catalog.models].sort((a, b) => a.sortOrder - b.sortOrder).map(model => ({
        modelKey: model.modelKey, displayName: model.displayName, enabled: model.enabled,
        upstreamModelId: model.upstreamModelId, mappingRevision: model.mappingRevision,
        planRequirement: model.planRequirement, sortOrder: model.sortOrder,
        maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens,
        allowedModelAliases: model.allowedModelAliases ?? [],
        capabilities: model.capabilities,
      })),
    };
  }
  private async probe(identity: OperatorIdentity): Promise<Response> {
    if (!this.provider.baseUrl) return this.json({ code: "PROVIDER_NOT_CONFIGURED", message: "PROVIDER_NOT_CONFIGURED" }, 400);
    const startedAt = this.now();
    // Connectivity probe only: unauthenticated HEAD to the provider origin —
    // never the completions path, never an Authorization header, never a paid call.
    let probe: { ok: boolean; httpStatus: number | null; latencyMs: number; error: string | null };
    try {
      let origin: string;
      try { origin = new URL(this.provider.baseUrl).origin; } catch { return this.json({ code: "PROVIDER_NOT_CONFIGURED", message: "PROVIDER_NOT_CONFIGURED" }, 400); }
      const response = await this.fetchImpl(origin + "/", { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(this.probeTimeoutMs) });
      await response.body?.cancel();
      probe = { ok: response.status < 500, httpStatus: response.status, latencyMs: this.now() - startedAt, error: null };
    } catch {
      probe = { ok: false, httpStatus: null, latencyMs: this.now() - startedAt, error: "UNREACHABLE" };
    }
    return this.json(this.operator.recordProbe(probe, identity));
  }

  // ---- C. Plans & Users ----
  private usersList(params: URLSearchParams): Response {
    const search = params.get("search");
    if (search !== null && search.length > 256) fail("VALIDATION_FAILED");
    const page = this.operator.listUsers({ search, cursor: params.get("cursor"), limit: limitParam(params) });
    return this.json({
      items: page.items.map(row => ({
        hostedUserId: row.id,
        subscription: row.planKey == null ? null : {
          planKey: row.planKey, status: row.status, periodStart: row.periodStart, periodEnd: row.periodEnd, revision: row.revision,
        },
        activeSessions: row.activeSessions, invocations: row.invocations, committedUnits: row.committedUnits,
      })),
      nextCursor: page.nextCursor,
    });
  }
  private userDetail(hostedUserId: string): Response {
    const detail = this.operator.userDetail(hostedUserId);
    if (!detail) return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
    return this.json({
      hostedUserId,
      subscription: detail.subscription ? subscriptionDto(detail.subscription as unknown as HostedSubscription) : null,
      quotaPeriods: detail.quotaPeriods.map(quotaDto),
      activeSessions: detail.sessions,
      bindings: detail.bindings.map(bindingDto),
      usage: detail.usage,
      recentUsage: detail.recentUsage.map(usageDto),
    });
  }
  private createUser(identity: OperatorIdentity, body: unknown): Response {
    const data = record(body, ["hostedUserId"]);
    const hostedUserId = str(data.hostedUserId, "hostedUserId");
    let inserted = false;
    try {
      inserted = this.hosted.ensureHostedUser(hostedUserId,
        this.operator.auditFor(identity, "user.create", hostedUserId, null));
    } catch { return this.json({ code: "VALIDATION_FAILED", message: "VALIDATION_FAILED" }, 400); }
    return this.json({ hostedUserId, created: inserted });
  }
  private writeSubscription(identity: OperatorIdentity, hostedUserId: string, mode: "provision" | "set" | "revoke", body: unknown): Response {
    if (!this.operator.userExists(hostedUserId)) return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
    const existing = this.hosted.subscription(hostedUserId);
    const data = mode === "revoke"
      ? record(body, ["idempotencyKey"])
      : record(body, ["planKey", "status", "periodStart", "periodEnd", "cancelAtPeriodEnd", "externalSubscriptionRef", "idempotencyKey"]);
    const sourceRevision = optStr(data.idempotencyKey, 128);
    let input: Omit<SetSubscriptionInput, "source" | "sourceRevision">;
    if (mode === "revoke") {
      if (!existing) return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
      input = { planKey: existing.planKey, status: "CANCELED" as SubscriptionStatus, periodStart: existing.periodStart, periodEnd: existing.periodEnd,
        cancelAtPeriodEnd: existing.cancelAtPeriodEnd, externalSubscriptionRef: existing.externalSubscriptionRef };
    } else {
      const status = mode === "provision" ? (data.status === undefined ? "ACTIVE" : str(data.status, "status")) : str(data.status, "status");
      if (!SUBSCRIPTION_STATUSES.includes(status as SubscriptionStatus)) fail("VALIDATION_FAILED");
      input = { planKey: str(data.planKey, "planKey"), status: status as SubscriptionStatus,
        periodStart: tsValue(data.periodStart, "periodStart"), periodEnd: tsValue(data.periodEnd, "periodEnd"),
        cancelAtPeriodEnd: boolOpt(data.cancelAtPeriodEnd), externalSubscriptionRef: optStr(data.externalSubscriptionRef) };
    }
    const mutation = { ...input, source: "OPERATOR_CONSOLE", sourceRevision };
    try {
      // Revoke inherits the existing planKey — it must work even after the plan
      // is retired or disabled in plan.json, so the plan-presence check is skipped.
      if (mode !== "revoke" && !this.plans.plan(mutation.planKey)) return this.json({ code: "UNKNOWN_PLAN", message: "UNKNOWN_PLAN" }, 400);
      const replayed = this.hosted.previewSubscription(hostedUserId, mutation).replay;
      const result = this.hosted.setSubscription(hostedUserId, mutation, this.now(),
        this.operator.auditFor(identity, `subscription.${mode}`, hostedUserId,
          { planKey: mutation.planKey, status: mutation.status, periodStart: mutation.periodStart, periodEnd: mutation.periodEnd, sourceRevision, replayed }));
      return this.json({ subscription: subscriptionDto(result), replayed });
    } catch (error) {
      const code = error instanceof Error ? error.message : "FAILED";
      const status = code === "SOURCE_REVISION_CONFLICT" ? 409 : code === "Hosted user does not exist" ? 404 : 400;
      this.operator.audit({ credentialId: identity.credentialId, action: `subscription.${mode}`, target: hostedUserId, detail: { error: code }, result: "FAILED" });
      return this.json({ code, message: code }, status);
    }
  }
  private issueHostedSession(identity: OperatorIdentity, hostedUserId: string, body: unknown): Response {
    if (!this.operator.userExists(hostedUserId)) return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
    const data = record(body, ["ttlMs"]);
    let ttl = 24 * 60 * 60 * 1000;
    if (data.ttlMs !== undefined) {
      if (typeof data.ttlMs !== "number" || !Number.isSafeInteger(data.ttlMs)) fail("VALIDATION_FAILED");
      ttl = Math.min(Math.max(data.ttlMs, 60_000), 7 * 24 * 60 * 60 * 1000);
    }
    const expiresAt = this.now() + ttl;
    // Issued exactly once in this response; only its hash is ever persisted.
    const token = this.hosted.issueSession(hostedUserId, expiresAt,
      this.operator.auditFor(identity, "hostedsession.issue", hostedUserId, { expiresAt }));
    return this.json({ hostedUserId, token, expiresAt });
  }
  private revokeHostedSessions(identity: OperatorIdentity, hostedUserId: string, body: unknown): Response {
    if (!this.operator.userExists(hostedUserId)) return this.json({ code: "NOT_FOUND", message: "NOT_FOUND" }, 404);
    const data = record(body, ["prefix"]);
    const prefix = optStr(data.prefix, 64);
    if (prefix !== null && (!/^[0-9a-f]{8,64}$/i.test(prefix))) fail("VALIDATION_FAILED");
    const revoked = this.operator.revokeUserSessions(hostedUserId, prefix, identity);
    return this.json({ hostedUserId, revoked });
  }

  // ---- Staged catalog: review-only, activation is not implementable here ----
  private stageCatalog(identity: OperatorIdentity, body: unknown): Response {
    const data = record(body, ["catalog"]);
    const errors: string[] = [];
    let valid: ManagedCatalog | null = null;
    try { valid = validateCatalog(data.catalog); } catch (error) { errors.push(error instanceof Error ? error.message : "invalid catalog"); }
    if (valid) {
      const modelKeys = new Set(valid.models.map(model => model.modelKey));
      for (const plan of this.plans.plans) {
        for (const model of plan.allowedModels) if (!modelKeys.has(model)) errors.push(`plan ${plan.planKey} allows missing model ${model}`);
        for (const key of Object.keys(plan.modelUsageUnits)) if (!modelKeys.has(key)) errors.push(`plan ${plan.planKey} prices missing model ${key}`);
      }
    }
    const declared = valid ? valid.revision
      : (data.catalog && typeof data.catalog === "object" && typeof (data.catalog as { revision?: unknown }).revision === "string"
        ? String((data.catalog as { revision: unknown }).revision) : null);
    const staged = this.operator.createStagedCatalog(data.catalog, declared ?? `invalid-${randomUUID()}`, errors, identity);
    if (!staged) return this.json({ code: "STAGED_REVISION_EXISTS", message: "STAGED_REVISION_EXISTS" }, 409);
    return this.json(staged);
  }

  // ---- D. Usage & Ledger (read-only views; the ledger is never rewritten here) ----
  private usageList(params: URLSearchParams): Response {
    const status = params.get("status");
    if (status !== null && !(USAGE_STATUSES as readonly string[]).includes(status)) fail("VALIDATION_FAILED");
    const cursor = params.get("cursor");
    if (cursor !== null && !/^\d+:[^\s:]+$/.test(cursor)) fail("VALIDATION_FAILED");
    const page = this.operator.listUsage({
      hostedUserId: params.get("user"), status, business: params.get("business"),
      cursor, limit: limitParam(params),
    });
    return this.json({ items: page.items.map(usageDto), nextCursor: page.nextCursor });
  }

  // ---- E. Operations ----
  private setRuntime(identity: OperatorIdentity, body: unknown, disable: boolean): Response {
    const data = record(body, ["reason"]);
    const reason = optStr(data.reason, 512);
    if (disable && !reason) fail("VALIDATION_FAILED");
    return this.json(this.operator.setRuntimeDisabled(disable, identity, reason));
  }

  private asset(kind: "html" | "js" | "css", content: string): Response {
    const headers = new Headers({ "content-type": CONTENT_TYPES[kind], ...SECURITY_HEADERS });
    return new Response(content, { headers });
  }
  private json(body: unknown, status = 200): Response {
    return Response.json(body, { status, headers: SECURITY_HEADERS });
  }
}
async function boundedBody(request: Request): Promise<unknown> {
  if (!request.body) throw new OperatorError("VALIDATION_FAILED", 400);
  const reader = request.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > BODY_LIMIT) throw new OperatorError("VALIDATION_FAILED", 400); chunks.push(chunk.value); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new OperatorError("VALIDATION_FAILED", 400); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

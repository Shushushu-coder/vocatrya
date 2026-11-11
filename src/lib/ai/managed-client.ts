import "server-only";
import { isLoopbackHostedEndpoint } from "./managed-availability";
import { ManagedError, MANAGED_ERROR_CODES, type ManagedInvocationReceipt, type ManagedInvocation, type ManagedTextResult, type ManagedStreamEvent, type ManagedModelDTO } from "./managed-contract";
import { managedAiProvenanceV1Schema, type ManagedAiProvenanceV1 } from "./managed-provenance";

// Release-owned endpoint. Changing it requires a reviewed release build.
// REVISION: BETA2_MANAGED_ENDPOINT_SHUCUBED
// SUPERSEDED: https://managed.vocatrya.com
// EFFECTIVE_ENDPOINT: https://managed.shucubed.xyz
// REASON: vocatrya.com is not registered. Internal Beta will use the
// existing shucubed.xyz domain.
export const TRUSTED_HOSTED_MANAGED_ENDPOINT = "https://managed.shucubed.xyz";
export interface HostedSessionProvider {
  tokenForLocalUser(localUserId: string): Promise<string | null>;
  /** Persists a hosted-issued session under OS protection. Providers without a write channel omit this — redemption fails closed there. */
  saveSession?(localUserId: string, token: string): Promise<void>;
  /** Explicit clearing fails on storage errors; expectedToken makes automatic rejection cleanup conditional. */
  clearSession?(localUserId: string, expectedToken?: string): Promise<void>;
}

// Development-only store backing the redeem flow on plain-web dev runs (no
// Electron broker). Same trust level as VOCATRYA_DEV_HOSTED_SESSION_TOKEN;
// production builds never touch it. Symbol.for survives per-bundle module
// duplication in the Next server.
const DEV_SESSION_STORE_KEY = Symbol.for("vocatrya.managedDevSessions.v1");
function devSessionStore(): Map<string, string | null> {
  const scope = globalThis as unknown as Record<symbol, Map<string, string | null> | undefined>;
  let store = scope[DEV_SESSION_STORE_KEY];
  if (!store) { store = new Map(); scope[DEV_SESSION_STORE_KEY] = store; }
  return store;
}

export class DesktopHostedSessionProvider implements HostedSessionProvider {
  private broker(): { url: URL; token: string } | null {
    const base = process.env.VOCATRYA_HOSTED_SESSION_URL;
    const internalToken = process.env.VOCATRYA_DESKTOP_INTERNAL_TOKEN;
    if (!base || !internalToken) return null;
    const url = new URL(base);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new ManagedError("MANAGED_AUTH_REQUIRED");
    url.pathname = "/session";
    return { url, token: internalToken };
  }
  async tokenForLocalUser(localUserId: string): Promise<string | null> {
    const broker = this.broker();
    if (broker) {
      broker.url.searchParams.set("localUserId", localUserId);
      try {
        const response = await fetch(broker.url, { cache: "no-store", headers: { authorization: `Bearer ${broker.token}` }, redirect: "error", signal: AbortSignal.timeout(5000) });
        if (response.status === 401) return null;
        if (!response.ok) throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE");
        const body = await response.json();
        if (typeof body?.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE");
        return body.token;
      } catch { throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE"); }
    }
    if (process.env.NODE_ENV === "production") return null;
    const store = devSessionStore();
    if (store.has(localUserId)) {
      const stored = store.get(localUserId);
      return stored && /^[A-Za-z0-9_-]{43}$/.test(stored) ? stored : null;
    }
    // Development-only delivery channel: an operator-provisioned hosted
    // token handed over through the environment (plain-web dev runs have no
    // Electron session broker). Still a real hosted session — the value is
    // never minted locally and production ignores this variable entirely.
    const dev = process.env.VOCATRYA_DEV_HOSTED_SESSION_TOKEN;
    return dev && /^[A-Za-z0-9_-]{43}$/.test(dev) ? dev : null;
  }
  async saveSession(localUserId: string, token: string): Promise<void> {
    const broker = this.broker();
    if (!broker) {
      if (process.env.NODE_ENV === "production") throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE");
      devSessionStore().set(localUserId, token);
      return;
    }
    try {
      const response = await fetch(broker.url, { method: "PUT", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" }, body: JSON.stringify({ localUserId, token }) });
      if (!response.ok) throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE");
    } catch (error) { if (error instanceof ManagedError) throw error; throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE"); }
  }
  async clearSession(localUserId: string, expectedToken?: string): Promise<void> {
    const broker = this.broker();
    if (!broker) {
      if (process.env.NODE_ENV !== "production") {
        const store = devSessionStore();
        const current = store.has(localUserId) ? store.get(localUserId) : process.env.VOCATRYA_DEV_HOSTED_SESSION_TOKEN;
        if (expectedToken === undefined || current === expectedToken) store.set(localUserId, null);
      }
      return;
    }
    broker.url.searchParams.set("localUserId", localUserId);
    try {
      const response = await fetch(broker.url, { method: "DELETE", redirect: "error", signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${broker.token}`, "content-type": "application/json" }, body: JSON.stringify({ expectedToken }) });
      if (!response.ok) throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE");
    } catch { throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE"); }
  }
}
function endpoint(): string {
  const production = process.env.NODE_ENV === "production";
  if (!production) {
    const dev = process.env.VOCATRYA_DEV_HOSTED_ENDPOINT;
    if (dev) return dev;
  }
  // VOCATRYA_HOSTED_ENDPOINT is the operator channel: a loopback value marks
  // the local Hosted broker and is honored in every build, production
  // included. A remote value is an override of the pinned release authority,
  // so only non-production builds may use it (https required by the
  // constructor contract below either way).
  const configured = process.env.VOCATRYA_HOSTED_ENDPOINT;
  if (configured) {
    if (isLoopbackHostedEndpoint(configured)) return configured;
    if (!production) {
      try {
        if (new URL(configured).protocol === "https:") return configured;
      } catch {
        // Unparseable override falls through to the pinned authority.
      }
    }
  }
  return TRUSTED_HOSTED_MANAGED_ENDPOINT;
}
function receiptError(body: unknown, invocationKey?: string): ManagedError | null {
  if (!body || typeof body !== "object") return null;
  const value = body as Record<string, unknown>;
  if (!["REPLAYED", "IN_PROGRESS", "UNKNOWN"].includes(String(value.executionState))) return null;
  if (typeof value.invocationKey !== "string" || (invocationKey !== undefined && value.invocationKey !== invocationKey) ||
      !["RESERVED", "RUNNING", "SUCCEEDED", "FAILED", "UNKNOWN"].includes(String(value.status)) ||
      !["RESERVED", "COMMITTED", "RELEASED"].includes(String(value.settlement))) throw new ManagedError("GATEWAY_RESPONSE");
  const receipt: ManagedInvocationReceipt = { executionState: value.executionState as ManagedInvocationReceipt["executionState"],
    invocationKey: value.invocationKey, status: value.status as ManagedInvocationReceipt["status"], settlement: value.settlement as ManagedInvocationReceipt["settlement"] };
  return new ManagedError(receipt.executionState === "UNKNOWN" ? "INVOCATION_STATUS_UNKNOWN" : receipt.executionState === "IN_PROGRESS" ? "INVOCATION_IN_PROGRESS" : "INVOCATION_REPLAYED", receipt);
}
export class HostedManagedClient {
  private readonly base: string;
  constructor(private readonly sessions: HostedSessionProvider = new DesktopHostedSessionProvider(), base = endpoint(), private readonly fetchImpl: typeof fetch = fetch) {
    const url = new URL(base);
    const loopback = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !loopback) || url.username || url.password || url.search || url.hash) throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE");
    this.base = url.toString().replace(/\/$/, "");
  }
  private async request(userId: string, path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const token = await this.sessions.tokenForLocalUser(userId);
    if (!token) throw new ManagedError("MANAGED_AUTH_REQUIRED");
    try {
      const response = await this.fetchImpl(`${this.base}/v1/${path}`, { cache: "no-store", method: body === undefined ? "GET" : "POST", redirect: "error",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body), signal });
      if (!response.ok) {
        let code: unknown;
        try { const errorBody = await response.json(); const replay = receiptError(errorBody, (body as ManagedInvocation | undefined)?.invocationKey); if (replay) throw replay; code = errorBody?.code; } catch (error) { if (error instanceof ManagedError) throw error; /* no raw errors */ }
        // An authoritative 401 means the stored credential is dead (expired
        // or revoked): drop it so the surface reports "needs a session"
        // instead of retrying a rejected token forever.
        if (response.status === 401) await this.sessions.clearSession?.(userId, token).catch(() => undefined);
        throw new ManagedError((MANAGED_ERROR_CODES as readonly unknown[]).includes(code) ? code as typeof MANAGED_ERROR_CODES[number] : "MANAGED_RUNTIME_UNAVAILABLE");
      }
      return response;
    } catch (error) { if (error instanceof ManagedError) throw error; throw new ManagedError(signal?.reason?.name === "TimeoutError" ? "GATEWAY_TIMEOUT" : "MANAGED_RUNTIME_UNAVAILABLE"); }
  }
  async identity(userId: string): Promise<string> {
    const body = await (await this.request(userId, "session", undefined, AbortSignal.timeout(5000))).json();
    if (typeof body?.hostedUserId !== "string" || !body.hostedUserId.trim()) throw new ManagedError("MANAGED_AUTH_REQUIRED");
    return body.hostedUserId;
  }
  async catalog(userId: string): Promise<{ revision: string; models: ManagedModelDTO[] }> {
    const body = await (await this.request(userId, "catalog", undefined, AbortSignal.timeout(5000))).json();
    if (!body || typeof body.revision !== "string" || !Array.isArray(body.models) || body.models.some((model: ManagedModelDTO) =>
      !model || typeof model.modelKey !== "string" || typeof model.displayName !== "string" || typeof model.enabled !== "boolean" || typeof model.available !== "boolean" ||
      !model.capabilities || ["text", "streaming", "structuredOutput", "tools"].some(key => typeof model.capabilities[key as keyof typeof model.capabilities] !== "boolean"))) throw new ManagedError("GATEWAY_RESPONSE");
    return { revision: body.revision, models: body.models.map((model: ManagedModelDTO) => ({ modelKey: model.modelKey, displayName: model.displayName, enabled: model.enabled, available: model.available, capabilities: { text: model.capabilities.text, streaming: model.capabilities.streaming, structuredOutput: model.capabilities.structuredOutput, tools: false } })) };
  }
  async bind(userId: string, input: { modelKey: string; business: string; resourceKey: string }, signal?: AbortSignal): Promise<ManagedAiProvenanceV1> {
    const body = await (await this.request(userId, "bindings", input, signal ?? AbortSignal.timeout(10000))).json();
    const parsed = managedAiProvenanceV1Schema.safeParse(body);
    if (!parsed.success || parsed.data.requestedModelKey !== input.modelKey) throw new ManagedError("GATEWAY_RESPONSE");
    return parsed.data;
  }
  async generateText(userId: string, input: ManagedInvocation, signal?: AbortSignal): Promise<ManagedTextResult> {
    const body = await (await this.request(userId, input.structuredOutput ? "structured" : "text", input, signal)).json();
    const replay = receiptError(body, input.invocationKey); if (replay) throw replay;
    if (!body || typeof body.text !== "string" || body.model !== input.modelKey) throw new ManagedError("GATEWAY_RESPONSE");
    const parsed = managedAiProvenanceV1Schema.safeParse(body.provenance);
    if (!parsed.success || parsed.data.managedBindingId !== input.bindingId || parsed.data.requestedModelKey !== input.modelKey ||
      body.structuredStrategy !== (input.structuredOutput ? "PROMPT_AND_VALIDATE" : null) || (body.stopReason !== null && typeof body.stopReason !== "string")) throw new ManagedError("GATEWAY_RESPONSE");
    return { executionState: "EXECUTED", text: body.text, model: body.model, provenance: parsed.data, structuredStrategy: body.structuredStrategy, stopReason: body.stopReason };
  }
  async *streamText(userId: string, input: ManagedInvocation, signal?: AbortSignal): AsyncGenerator<ManagedStreamEvent> {
    const controller = new AbortController();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.request(userId, "stream", input, combined);
      if (response.headers.get("content-type")?.includes("application/json")) {
        const replay = receiptError(await response.json(), input.invocationKey);
        throw replay ?? new ManagedError("GATEWAY_RESPONSE");
      }
      if (!response.body || !response.headers.get("content-type")?.includes("application/x-ndjson")) throw new ManagedError("GATEWAY_RESPONSE");
      reader = response.body.getReader(); const decoder = new TextDecoder("utf-8", { fatal: true }); let buffer = "", total = 0;
      while (true) {
        const chunk = await reader.read();
        if (combined.aborted) throw new ManagedError("GATEWAY_NETWORK");
        if (chunk.done) throw new ManagedError("GATEWAY_RESPONSE");
        total += chunk.value.byteLength; if (total > 4 * 1024 * 1024) throw new ManagedError("GATEWAY_RESPONSE");
        buffer += decoder.decode(chunk.value, { stream: true });
        while (buffer.includes("\n")) {
          if (combined.aborted) throw new ManagedError("GATEWAY_NETWORK");
          const index = buffer.indexOf("\n"); let event: ManagedStreamEvent;
          try { event = JSON.parse(buffer.slice(0, index)); } catch { throw new ManagedError("GATEWAY_RESPONSE"); }
          buffer = buffer.slice(index + 1);
          if (event?.type === "error") throw new ManagedError(MANAGED_ERROR_CODES.includes(event.code) ? event.code : "GATEWAY_RESPONSE");
          if (event?.type === "text-delta" && typeof event.delta === "string") yield { type: "text-delta", delta: event.delta };
          else if (event?.type === "completed") {
            const parsed = managedAiProvenanceV1Schema.safeParse(event.provenance);
            if (!parsed.success || event.model !== input.modelKey || parsed.data.managedBindingId !== input.bindingId || parsed.data.requestedModelKey !== input.modelKey || buffer.trim()) throw new ManagedError("GATEWAY_RESPONSE");
            yield { type: "completed", executionState: "EXECUTED", model: event.model, provenance: parsed.data }; return;
          } else throw new ManagedError("GATEWAY_RESPONSE");
        }
        if (buffer.length > 256 * 1024) throw new ManagedError("GATEWAY_RESPONSE");
      }
    } catch (error) { if (error instanceof ManagedError) throw error; throw new ManagedError("MANAGED_RUNTIME_UNAVAILABLE"); }
    finally { controller.abort(); await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
  }
  /**
   * GET /v1/me/entitlement — derived subscription/plan/quota authority. The
   * shape is the hosted EntitlementDto: a strict field-presence check, no
   * fields trusted beyond their declared type, nothing invented locally.
   */
  async entitlement(userId: string): Promise<ManagedEntitlement> {
    const body = await (await this.request(userId, "me/entitlement", undefined, AbortSignal.timeout(5000))).json();
    return parseEntitlementDto(body);
  }
  /**
   * GET /v1/me/usage — current-period quota summary only. The hosted
   * service deliberately returns no ledger rows, prompts, or credentials;
   * the client renders exactly what arrives.
   */
  async usage(userId: string): Promise<ManagedUsageSummary> {
    const body = await (await this.request(userId, "me/usage", undefined, AbortSignal.timeout(5000))).json();
    const dto = parseEntitlementDto(body, { usageSummary: true });
    const { subscriptionStatus, planKey, planRevision, quotaPlanRevision, periodStart, periodEnd, quotaLimitUnits, reservedUnits, committedUnits, remainingUnits } = dto;
    return { subscriptionStatus, planKey, planRevision, quotaPlanRevision, periodStart, periodEnd, quotaLimitUnits, reservedUnits, committedUnits, remainingUnits };
  }
}

export interface ManagedEntitlement {
  subscriptionStatus: string | null;
  planKey: string | null;
  planRevision: string | null;
  quotaPlanRevision: string | null;
  managedAiEnabled: boolean;
  allowedModels: string[];
  periodStart: number | null;
  periodEnd: number | null;
  quotaLimitUnits: number | null;
  reservedUnits: number;
  committedUnits: number;
  remainingUnits: number | null;
}

/** The /v1/me/usage payload — entitlement minus enablement/model fields. */
export type ManagedUsageSummary = Omit<ManagedEntitlement, "managedAiEnabled" | "allowedModels">;

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}
function intField(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseEntitlementDto(
  body: unknown,
  options?: { usageSummary?: boolean },
): ManagedEntitlement {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") throw new ManagedError("GATEWAY_RESPONSE");
  if (!nullableString(b.subscriptionStatus)) throw new ManagedError("GATEWAY_RESPONSE");
  if (!nullableString(b.planKey)) throw new ManagedError("GATEWAY_RESPONSE");
  if (!nullableString(b.planRevision)) throw new ManagedError("GATEWAY_RESPONSE");
  if (!nullableString(b.quotaPlanRevision)) throw new ManagedError("GATEWAY_RESPONSE");
  if (!nullableNumber(b.periodStart)) throw new ManagedError("GATEWAY_RESPONSE");
  if (!nullableNumber(b.periodEnd)) throw new ManagedError("GATEWAY_RESPONSE");
  if (!nullableNumber(b.quotaLimitUnits)) throw new ManagedError("GATEWAY_RESPONSE");
  if (!intField(b.reservedUnits)) throw new ManagedError("GATEWAY_RESPONSE");
  if (!intField(b.committedUnits)) throw new ManagedError("GATEWAY_RESPONSE");
  if (!nullableNumber(b.remainingUnits)) throw new ManagedError("GATEWAY_RESPONSE");
  // The usage summary omits these two entitlement-only fields entirely;
  // for the entitlement read they are mandatory.
  if (
    b.managedAiEnabled === undefined
      ? options?.usageSummary !== true
      : typeof b.managedAiEnabled !== "boolean"
  ) {
    throw new ManagedError("GATEWAY_RESPONSE");
  }
  const allowedModelsValid =
    b.allowedModels === undefined
      ? options?.usageSummary === true
      : Array.isArray(b.allowedModels) &&
        b.allowedModels.every((m) => typeof m === "string");
  if (!allowedModelsValid) throw new ManagedError("GATEWAY_RESPONSE");
  const allowedModels = Array.isArray(b.allowedModels) ? b.allowedModels : [];
  return {
    subscriptionStatus: b.subscriptionStatus,
    planKey: b.planKey,
    planRevision: b.planRevision,
    quotaPlanRevision: b.quotaPlanRevision,
    managedAiEnabled: b.managedAiEnabled === true,
    allowedModels,
    periodStart: b.periodStart,
    periodEnd: b.periodEnd,
    quotaLimitUnits: b.quotaLimitUnits,
    reservedUnits: b.reservedUnits,
    committedUnits: b.committedUnits,
    remainingUnits: b.remainingUnits,
  };
}

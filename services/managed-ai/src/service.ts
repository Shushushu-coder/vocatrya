import { createHash } from "node:crypto";
import { MANAGED_ADAPTER_REVISION, ManagedError, type ManagedInvocation, type ManagedStreamEvent } from "../../../src/lib/ai/managed-contract";
import { ModelCatalog, type ManagedModel } from "./catalog";
import { GatewayFailure, ManagedGatewayRuntime } from "./gateway";
import { HostedStore, provenance, type ManagedAiBinding } from "./store";
import { PlanAuthority } from "./plan";
import type { ManagedAiUsageRow, UsageReceipt } from "./types";

const DEFAULT_UNKNOWN_GRACE_MS = 60_000;
const MIN_UNKNOWN_GRACE_MS = 1_000;
const MAX_UNKNOWN_GRACE_MS = 3_600_000;

function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw new ManagedError("GATEWAY_RESPONSE");
  return raw as Record<string, unknown>;
}
function string(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new ManagedError("GATEWAY_RESPONSE");
  return value;
}
function identityString(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) throw new ManagedError("INVOCATION_ID_REQUIRED");
  return value;
}
function attemptIndex(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ManagedError("INVOCATION_ID_REQUIRED");
  return value;
}
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function requestHash(input: ManagedInvocation, mode: string, binding: ManagedAiBinding): string {
  // Include every semantic input and frozen option actually sent upstream.
  return createHash("sha256").update(canonicalJson({ ...input, executionMode: mode,
    business: binding.business, resourceKey: binding.resourceKey,
    upstreamModelId: binding.upstreamModelId, maxOutputTokens: binding.maxOutputTokens })).digest("hex");
}
function replayResponse(existing: UsageReceipt): Response {
  if (existing.status === "UNKNOWN") return Response.json({ code: "INVOCATION_STATUS_UNKNOWN", executionState: "UNKNOWN",
    invocationKey: existing.invocationKey, status: existing.status, settlement: existing.settlement }, { status: 409 });
  const receipt = existing.status === "SUCCEEDED" ? "completed" : existing.status === "FAILED" ? "failed" : "in-progress";
  return Response.json({ executionState: receipt === "in-progress" ? "IN_PROGRESS" : "REPLAYED", receipt, invocationKey: existing.invocationKey, status: existing.status, settlement: existing.settlement });
}
function dispositionOf(error: unknown): "RELEASED" | "COMMITTED" | "UNKNOWN" {
  return error instanceof GatewayFailure ? error.disposition : "UNKNOWN";
}
function errorCategoryOf(error: unknown): string | null {
  return error instanceof ManagedError ? error.code : "UNKNOWN";
}

export interface HostedManagedServiceOptions {
  now?: () => number;
  unknownSettlementGraceMs?: number;
}

type Admission =
  | { kind: "replay"; response: Response }
  | { kind: "execute"; usage: ManagedAiUsageRow; binding: ManagedAiBinding; input: ManagedInvocation };

export class HostedManagedService {
  private readonly now: () => number;
  private readonly unknownGraceMs: number;
  constructor(
    private readonly store: HostedStore,
    private readonly catalog: ModelCatalog,
    private readonly plans: PlanAuthority,
    private readonly gateway: ManagedGatewayRuntime,
    options: HostedManagedServiceOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    const grace = options.unknownSettlementGraceMs ?? DEFAULT_UNKNOWN_GRACE_MS;
    this.unknownGraceMs = Math.min(Math.max(grace, MIN_UNKNOWN_GRACE_MS), MAX_UNKNOWN_GRACE_MS);
  }
  async handle(request: Request): Promise<Response> {
    try {
      const user = this.store.authenticate(request.headers.get("authorization"));
      const path = new URL(request.url).pathname;
      if (request.method === "GET") {
        if (path === "/v1/session") return Response.json({ hostedUserId: user });
        if (path === "/v1/catalog") return Response.json(this.catalog.dto());
        if (path === "/v1/me/entitlement") return this.entitlement(user);
        if (path === "/v1/me/usage") return this.usageSummary(user);
        return new Response(null, { status: 404 });
      }
      if (request.method !== "POST") return new Response(null, { status: 404 });
      const body = await boundedBody(request);
      if (path === "/v1/bindings") {
        const data = record(body, ["modelKey", "business", "resourceKey"]);
        const model = this.catalog.resolve(string(data.modelKey));
        return Response.json(provenance(this.store.createBinding(user, string(data.business), string(data.resourceKey), model)));
      }
      if (path !== "/v1/text" && path !== "/v1/stream" && path !== "/v1/structured") return new Response(null, { status: 404 });
      return await this.invoke(user, path, body, request);
    } catch (error) {
      const code = error instanceof ManagedError ? error.code : "GATEWAY_RESPONSE";
      const status = code === "MANAGED_AUTH_REQUIRED" ? 401 : code === "INVOCATION_CONFLICT" || code === "INVOCATION_STATUS_UNKNOWN" ? 409 : 400;
      return Response.json({ code, message: code }, { status });
    }
  }
  private entitlement(user: string): Response {
    return Response.json(this.store.entitlementSummary(user, this.plans, this.now));
  }
  private usageSummary(user: string): Response {
    const dto = this.store.entitlementSummary(user, this.plans, this.now);
    return Response.json({
      subscriptionStatus: dto.subscriptionStatus, planKey: dto.planKey, planRevision: dto.planRevision,
      quotaPlanRevision: dto.quotaPlanRevision,
      periodStart: dto.periodStart, periodEnd: dto.periodEnd, quotaLimitUnits: dto.quotaLimitUnits,
      reservedUnits: dto.reservedUnits, committedUnits: dto.committedUnits, remainingUnits: dto.remainingUnits,
    });
  }
  private async invoke(user: string, path: string, body: unknown, request: Request): Promise<Response> {
    this.store.reconcileStaleUnknown(this.now(), this.unknownGraceMs);
    const admission = this.admit(user, path, body);
    if (admission.kind === "replay") return admission.response;
    if (path === "/v1/stream") return this.stream(admission.usage, admission.binding, admission.input, request);
    return this.complete(admission.usage, admission.binding, admission.input, path, request);
  }
  private admit(user: string, path: string, body: unknown): Admission {
    const data = record(body, ["bindingId", "modelKey", "prompt", "structuredOutput", "operationId", "invocationKey", "attemptIndex"]);
    const operationId = identityString(data.operationId);
    const invocationKey = identityString(data.invocationKey);
    const input: ManagedInvocation = {
      bindingId: string(data.bindingId), modelKey: string(data.modelKey), prompt: string(data.prompt, 256 * 1024),
      operationId, invocationKey, attemptIndex: attemptIndex(data.attemptIndex),
    };
    if (Buffer.byteLength(input.prompt) > 256 * 1024) throw new ManagedError("GATEWAY_RESPONSE");
    if (data.structuredOutput !== undefined) {
      const structured = record(data.structuredOutput, ["schema", "schemaName"]);
      if (!structured.schema || typeof structured.schema !== "object" || Array.isArray(structured.schema) || Buffer.byteLength(JSON.stringify(structured.schema)) > 64 * 1024) throw new ManagedError("GATEWAY_RESPONSE");
      input.structuredOutput = { schema: structured.schema as Record<string, unknown>, schemaName: string(structured.schemaName, 128) };
    }
    if ((path === "/v1/structured") !== !!input.structuredOutput || (path === "/v1/stream" && input.structuredOutput)) throw new ManagedError("GATEWAY_RESPONSE");
    const binding = this.store.binding(input.bindingId, user);
    if (binding.modelKey !== input.modelKey || binding.adapterContractRevision !== MANAGED_ADAPTER_REVISION) throw new ManagedError("MANAGED_BINDING_UNAVAILABLE");
    const model: ManagedModel = this.catalog.resolve(binding.modelKey, path === "/v1/stream" ? "streaming" : path === "/v1/structured" ? "structuredOutput" : "text");
    if (Buffer.byteLength(input.prompt) > Math.min(binding.maxInputTokens, model.maxInputTokens)) throw new ManagedError("GATEWAY_RESPONSE");

    const hash = requestHash(input, path, binding);
    const reservation = this.store.reserveInvocation({
      hostedUserId: user, business: binding.business, resourceKey: binding.resourceKey,
      operationId, invocationKey, attemptIndex: input.attemptIndex, requestHash: hash, binding,
      plans: this.plans, now: this.now,
    });
    if (!reservation.created) {
      if (reservation.existing.requestHash !== hash) throw new ManagedError("INVOCATION_CONFLICT");
      return { kind: "replay", response: replayResponse(this.store.usageReceipt(user, invocationKey)!) };
    }
    return { kind: "execute", usage: reservation.usage, binding, input };
  }
  private async complete(usage: ManagedAiUsageRow, binding: ManagedAiBinding, input: ManagedInvocation, path: string, request: Request): Promise<Response> {
    const startedAt = this.now();
    this.store.markRunning(usage.id);
    try {
      const result = path === "/v1/structured"
        ? await this.gateway.generateStructured(binding, input, request.signal)
        : await this.gateway.generateText(binding, input, request.signal);
      this.store.settleCommitted(usage.id, { inputTokens: result.inputTokens, outputTokens: result.outputTokens, latencyMs: this.now() - startedAt, completedAt: this.now() });
      return Response.json({ ...result, executionState: "EXECUTED" });
    } catch (error) {
      this.settleOnError(usage.id, error, startedAt);
      throw error;
    }
  }
  private settleOnError(usageId: string, error: unknown, startedAt: number): void {
    const disposition = dispositionOf(error);
    if (disposition === "RELEASED") this.store.settleReleased(usageId, errorCategoryOf(error), this.now());
    else if (disposition === "UNKNOWN") this.store.settleUnknown(usageId, errorCategoryOf(error), this.now());
    else this.store.settleCommitted(usageId, { status: "FAILED", errorCategory: errorCategoryOf(error), latencyMs: this.now() - startedAt, completedAt: this.now() });
  }
  private stream(usage: ManagedAiUsageRow, binding: ManagedAiBinding, input: ManagedInvocation, request: Request): Response {
    const startedAt = this.now();
    const now = this.now;
    const store = this.store;
    const controller = new AbortController();
    const iterator = this.gateway.streamText(binding, input, AbortSignal.any([request.signal, controller.signal]));
    const encoder = new TextEncoder();
    let dispatched = false;
    let settled = false;
    const settle = (fn: () => void) => { if (settled) return; settled = true; fn(); };
    const commit = (event?: Extract<ManagedStreamEvent, { type: "completed" }>) => store.settleCommitted(usage.id, { inputTokens: event?.inputTokens, outputTokens: event?.outputTokens, latencyMs: now() - startedAt, completedAt: now() });
    store.markRunning(usage.id);
    return new Response(new ReadableStream<Uint8Array>({
      async pull(stream) {
        if (request.signal.aborted) { settle(() => dispatched ? store.settleUnknown(usage.id, "CLIENT_ABORT", now()) : store.settleReleased(usage.id, "CLIENT_ABORT", now())); controller.abort(); try { stream.close(); } catch { /* closed */ } return; }
        dispatched = true;
        let event: IteratorResult<ManagedStreamEvent>;
        try { event = await iterator.next(); }
        catch (error) {
          const disposition = dispositionOf(error);
          if (disposition === "RELEASED") settle(() => store.settleReleased(usage.id, errorCategoryOf(error), now()));
          else if (disposition === "UNKNOWN") settle(() => store.settleUnknown(usage.id, errorCategoryOf(error), now()));
          else settle(() => store.settleCommitted(usage.id, { status: "FAILED", errorCategory: errorCategoryOf(error), completedAt: now() }));
          try { stream.enqueue(encoder.encode(`${JSON.stringify({ type: "error", code: error instanceof ManagedError ? error.code : "GATEWAY_RESPONSE" })}\n`)); } catch { /* cancelled */ }
          try { stream.close(); } catch { /* closed */ }
          return;
        }
        if (event.done) { try { stream.close(); } catch { /* closed */ } return; }
        try { stream.enqueue(encoder.encode(`${JSON.stringify(event.value.type === "completed" ? { ...event.value, executionState: "EXECUTED" } : event.value)}\n`)); } catch { return; }
        const value = event.value;
        if (value.type === "completed") settle(() => commit(value));
      },
      async cancel() {
        if (dispatched) settle(() => commit());
        else settle(() => store.settleReleased(usage.id, "CLIENT_ABORT", now()));
        controller.abort();
        await iterator.return(undefined);
      },
    }), { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  }
}
async function boundedBody(request: Request): Promise<unknown> {
  if (!request.body) throw new ManagedError("GATEWAY_RESPONSE");
  const reader = request.body.getReader(); let length = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) { const chunk = await reader.read(); if (chunk.done) break; length += chunk.value.byteLength; if (length > 384 * 1024) throw new ManagedError("GATEWAY_RESPONSE"); chunks.push(chunk.value); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new ManagedError("GATEWAY_RESPONSE"); }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

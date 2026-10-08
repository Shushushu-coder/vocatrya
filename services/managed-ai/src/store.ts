import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MANAGED_ADAPTER_REVISION, ManagedError, type ManagedProvenance } from "../../../src/lib/ai/managed-contract";
import { assertModelEntitled, deriveEntitlement, entitlementDto } from "./entitlement";
import type { PlanAuthority } from "./plan";
import { applyMigrations } from "./schema";
import type { ManagedModel } from "./catalog";
import {
  SUBSCRIPTION_STATUSES,
  type HostedSubscription, type ManagedAiQuotaPeriod, type ManagedAiUsageRow,
  type SettlementStatus, type SubscriptionStatus, type UsageReceipt, type UsageStatus,
} from "./types";

export interface ManagedAiBinding {
  id: string; hostedUserId: string; business: string; resourceKey: string;
  modelKey: string; upstreamModelId: string; mappingRevision: string;
  adapterContractRevision: string; createdAt: string;
  allowedModelAliases: string[]; maxInputTokens: number; maxOutputTokens: number;
}

export interface SetSubscriptionInput {
  planKey: string;
  status: SubscriptionStatus;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd?: boolean;
  source?: string;
  externalSubscriptionRef?: string | null;
  sourceRevision?: string | null;
}

export interface SettleSuccessInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  actualModel?: string | null;
  latencyMs?: number | null;
  gatewayRequestId?: string | null;
  completedAt: number;
  status?: "SUCCEEDED" | "FAILED";
  errorCategory?: string | null;
}

export type ReserveResult = { created: true; usage: ManagedAiUsageRow } | { created: false; existing: ManagedAiUsageRow };

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

function mapSubscription(row: Record<string, unknown> | undefined): HostedSubscription | null {
  if (!row) return null;
  return {
    id: String(row.id), hostedUserId: String(row.hostedUserId), planKey: String(row.planKey), status: row.status as SubscriptionStatus,
    periodStart: Number(row.periodStart), periodEnd: Number(row.periodEnd), cancelAtPeriodEnd: Number(row.cancelAtPeriodEnd) === 1,
    source: String(row.source), externalSubscriptionRef: row.externalSubscriptionRef == null ? null : String(row.externalSubscriptionRef),
    sourceRevision: row.sourceRevision == null ? null : String(row.sourceRevision), revision: Number(row.revision),
    createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
  };
}
function mapQuotaPeriod(row: Record<string, unknown> | undefined): ManagedAiQuotaPeriod | null {
  if (!row) return null;
  return {
    id: String(row.id), hostedUserId: String(row.hostedUserId), periodStart: Number(row.periodStart), periodEnd: Number(row.periodEnd),
    planKey: String(row.planKey), planRevision: String(row.planRevision), quotaLimitUnits: Number(row.quotaLimitUnits),
    reservedUnits: Number(row.reservedUnits), committedUnits: Number(row.committedUnits), createdAt: Number(row.createdAt), updatedAt: Number(row.updatedAt),
  };
}
function mapUsage(row: Record<string, unknown> | undefined): ManagedAiUsageRow | null {
  if (!row) return null;
  return {
    id: String(row.id), hostedUserId: String(row.hostedUserId), business: String(row.business), resourceKey: String(row.resourceKey),
    operationId: String(row.operationId), invocationKey: String(row.invocationKey), attemptIndex: Number(row.attemptIndex), requestHash: String(row.requestHash),
    managedBindingId: String(row.managedBindingId), modelKey: String(row.modelKey), upstreamModelId: String(row.upstreamModelId),
    actualModel: row.actualModel == null ? null : String(row.actualModel), status: row.status as UsageStatus, settlement: row.settlement as SettlementStatus,
    quotaPeriodId: String(row.quotaPeriodId), reservedUnits: Number(row.reservedUnits), chargedUnits: Number(row.chargedUnits),
    inputTokens: row.inputTokens == null ? null : Number(row.inputTokens), outputTokens: row.outputTokens == null ? null : Number(row.outputTokens),
    gatewayRequestId: row.gatewayRequestId == null ? null : String(row.gatewayRequestId), latencyMs: row.latencyMs == null ? null : Number(row.latencyMs),
    errorCategory: row.errorCategory == null ? null : String(row.errorCategory), createdAt: Number(row.createdAt), completedAt: row.completedAt == null ? null : Number(row.completedAt),
  };
}

export class HostedStore {
  private readonly db: DatabaseSync;
  constructor(filename: string, options: { readOnly?: boolean } = {}) {
    this.db = new DatabaseSync(filename, { readOnly: options.readOnly === true });
    if (options.readOnly) { this.db.exec("PRAGMA query_only=ON"); return; }
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;`);
    try { applyMigrations(this.db); } catch (error) { this.db.close(); throw error; }
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  issueSession(hostedUserId: string, expiresAt: number): string {
    if (!hostedUserId.trim() || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new Error("Invalid hosted session provisioning");
    const token = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT OR IGNORE INTO HostedUser(id) VALUES (?)").run(hostedUserId);
    this.db.prepare("INSERT INTO HostedSession VALUES (?,?,?)").run(digest(token), hostedUserId, expiresAt);
    return token;
  }
  authenticate(authorization: string | null): string {
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "");
    if (!match) throw new ManagedError("MANAGED_AUTH_REQUIRED");
    const row = this.db.prepare("SELECT hostedUserId, expiresAt FROM HostedSession WHERE tokenHash=?").get(digest(match[1]));
    if (!row || typeof row.hostedUserId !== "string" || Number(row.expiresAt) <= Date.now()) throw new ManagedError("MANAGED_AUTH_REQUIRED");
    return row.hostedUserId;
  }
  revokeSession(token: string): void { this.db.prepare("DELETE FROM HostedSession WHERE tokenHash=?").run(digest(token)); }
  createBinding(hostedUserId: string, business: string, resourceKey: string, model: ManagedModel): ManagedAiBinding {
    if (!/^[A-Z][A-Z_]{0,63}$/.test(business) || !resourceKey.trim() || resourceKey.length > 256) throw new ManagedError("MANAGED_BINDING_UNAVAILABLE");
    const existing = this.db.prepare("SELECT id FROM ManagedAiBinding WHERE hostedUserId=? AND business=? AND resourceKey=?").get(hostedUserId, business, resourceKey);
    if (existing) {
      const binding = this.binding(String(existing.id), hostedUserId);
      if (binding.modelKey !== model.modelKey) throw new ManagedError("MANAGED_BINDING_UNAVAILABLE");
      return binding;
    }
    const binding: ManagedAiBinding = {
      id: randomUUID(), hostedUserId, business, resourceKey, modelKey: model.modelKey,
      upstreamModelId: model.upstreamModelId, mappingRevision: model.mappingRevision,
      adapterContractRevision: MANAGED_ADAPTER_REVISION, createdAt: new Date().toISOString(),
      allowedModelAliases: model.allowedModelAliases ?? [], maxInputTokens: model.maxInputTokens, maxOutputTokens: model.maxOutputTokens,
    };
    this.db.prepare("INSERT OR IGNORE INTO ManagedAiBinding VALUES (?,?,?,?,?,?)").run(binding.id, hostedUserId, business, resourceKey, binding.modelKey, JSON.stringify(binding));
    const persisted = this.db.prepare("SELECT id FROM ManagedAiBinding WHERE hostedUserId=? AND business=? AND resourceKey=?").get(hostedUserId, business, resourceKey);
    if (!persisted) throw new ManagedError("MANAGED_BINDING_UNAVAILABLE");
    const authoritative = this.binding(String(persisted.id), hostedUserId);
    if (authoritative.modelKey !== model.modelKey) throw new ManagedError("MANAGED_BINDING_UNAVAILABLE");
    return authoritative;
  }
  binding(id: string, hostedUserId: string): ManagedAiBinding {
    const row = this.db.prepare("SELECT snapshot FROM ManagedAiBinding WHERE id=? AND hostedUserId=?").get(id, hostedUserId);
    if (!row || typeof row.snapshot !== "string") throw new ManagedError("MANAGED_BINDING_UNAVAILABLE");
    return JSON.parse(row.snapshot) as ManagedAiBinding;
  }
  private validateSubscriptionLocked(hostedUserId: string, input: SetSubscriptionInput): { existing: HostedSubscription | null; replay: boolean; normalized: Required<SetSubscriptionInput> } {
    const normalized = validateSubscriptionInput(hostedUserId, input);
    if (!this.db.prepare("SELECT id FROM HostedUser WHERE id=?").get(hostedUserId)) throw new Error("Hosted user does not exist");
    const existing = this.subscription(hostedUserId);
    if (existing && normalized.sourceRevision !== null && existing.source === normalized.source && existing.sourceRevision === normalized.sourceRevision) {
      const same = Object.entries(normalized).every(([key, value]) => existing[key as keyof HostedSubscription] === value);
      if (!same) throw new Error("SOURCE_REVISION_CONFLICT");
      return { existing, replay: true, normalized };
    }
    return { existing, replay: false, normalized };
  }
  previewSubscription(hostedUserId: string, input: SetSubscriptionInput): { mutation: Required<SetSubscriptionInput>; replay: boolean } {
    const { normalized, replay } = this.validateSubscriptionLocked(hostedUserId, input);
    return { mutation: normalized, replay };
  }
  setSubscription(hostedUserId: string, input: SetSubscriptionInput, now = Date.now()): HostedSubscription {
    return this.transaction(() => {
      const { existing, replay, normalized: value } = this.validateSubscriptionLocked(hostedUserId, input);
      if (replay) return existing!;
      const id = existing ? existing.id : randomUUID();
      const revision = existing ? existing.revision + 1 : 1;
      if (existing) {
        this.db.prepare(`UPDATE Subscription SET planKey=?, status=?, periodStart=?, periodEnd=?, cancelAtPeriodEnd=?, source=?, externalSubscriptionRef=?, sourceRevision=?, revision=?, updatedAt=? WHERE id=?`)
          .run(value.planKey, value.status, value.periodStart, value.periodEnd, value.cancelAtPeriodEnd ? 1 : 0, value.source, value.externalSubscriptionRef, value.sourceRevision, revision, now, id);
      } else {
        this.db.prepare(`INSERT INTO Subscription(id, hostedUserId, planKey, status, periodStart, periodEnd, cancelAtPeriodEnd, source, externalSubscriptionRef, sourceRevision, revision, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, hostedUserId, value.planKey, value.status, value.periodStart, value.periodEnd, value.cancelAtPeriodEnd ? 1 : 0, value.source, value.externalSubscriptionRef, value.sourceRevision, revision, now, now);
      }
      return this.subscription(hostedUserId)!;
    });
  }
  subscription(hostedUserId: string): HostedSubscription | null {
    return mapSubscription(this.db.prepare("SELECT * FROM Subscription WHERE hostedUserId=?").get(hostedUserId));
  }
  currentQuotaPeriod(hostedUserId: string, now: number): ManagedAiQuotaPeriod | null {
    return mapQuotaPeriod(this.db.prepare(`SELECT q.* FROM ManagedAiQuotaPeriod q JOIN Subscription s
      ON s.hostedUserId=q.hostedUserId AND s.periodStart=q.periodStart AND s.periodEnd=q.periodEnd
      WHERE s.hostedUserId=? AND s.periodStart<=? AND s.periodEnd>?`).get(hostedUserId, now, now));
  }
  entitlementSummary(hostedUserId: string, plans: PlanAuthority, clock: () => number) {
    return this.transaction(() => {
      const now = clock();
      const subscription = this.subscription(hostedUserId);
      const entitlement = deriveEntitlement(subscription, plans, now);
      const period = entitlement.entitled ? this.currentQuotaPeriod(hostedUserId, now) : null;
      return entitlementDto(entitlement, period, entitlement.entitled ? plans.plan(subscription!.planKey)!.periodQuotaUnits : null);
    });
  }
  reserveInvocation(args: {
    hostedUserId: string; business: string; resourceKey: string;
    operationId: string; invocationKey: string; attemptIndex: number; requestHash: string;
    binding: ManagedAiBinding; plans: PlanAuthority; now: () => number;
  }): ReserveResult {
    return this.transaction(() => {
      // The lock serializes both subscription mutation and unique-key admission.
      // Duplicates never consult quota or create another quota period.
      const existing = this.usage(args.hostedUserId, args.invocationKey);
      if (existing) {
        if (existing.requestHash !== args.requestHash) throw new ManagedError("INVOCATION_CONFLICT");
        return { created: false, existing };
      }
      const now = args.now();
      const subscription = this.subscription(args.hostedUserId);
      const entitlement = deriveEntitlement(subscription, args.plans, now);
      assertModelEntitled(entitlement, args.binding.modelKey);
      const plan = args.plans.plan(subscription!.planKey)!;
      const requestedUnits = args.plans.usageUnits(plan.planKey, args.binding.modelKey);
      const period = this.ensureQuotaPeriodLocked(args.hostedUserId, plan.planKey, args.plans.revision, plan.periodQuotaUnits, subscription!.periodStart, subscription!.periodEnd, now);
      if (period.committedUnits + period.reservedUnits + requestedUnits > period.quotaLimitUnits) throw new ManagedError("QUOTA_EXCEEDED");
      const usageId = randomUUID();
      const inserted = this.db.prepare(`INSERT OR IGNORE INTO ManagedAiUsage(id, hostedUserId, business, resourceKey, operationId, invocationKey, attemptIndex, requestHash, managedBindingId, modelKey, upstreamModelId, actualModel, status, settlement, quotaPeriodId, reservedUnits, chargedUnits, inputTokens, outputTokens, gatewayRequestId, latencyMs, errorCategory, createdAt, completedAt)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(usageId, args.hostedUserId, args.business, args.resourceKey, args.operationId, args.invocationKey, args.attemptIndex, args.requestHash,
          args.binding.id, args.binding.modelKey, args.binding.upstreamModelId, null, "RESERVED", "RESERVED", period.id, requestedUnits, 0,
          null, null, null, null, null, now, null);
      if (Number(inserted.changes) === 0) {
        const winner = this.usage(args.hostedUserId, args.invocationKey);
        if (!winner || winner.requestHash !== args.requestHash) throw new ManagedError("INVOCATION_CONFLICT");
        return { created: false, existing: winner };
      }
      this.db.prepare("UPDATE ManagedAiQuotaPeriod SET reservedUnits=reservedUnits+?, updatedAt=? WHERE id=?").run(requestedUnits, now, period.id);
      return { created: true, usage: mapUsage(this.db.prepare("SELECT * FROM ManagedAiUsage WHERE id=?").get(usageId))! };
    });
  }
  private ensureQuotaPeriodLocked(hostedUserId: string, planKey: string, planRevision: string, quotaLimitUnits: number, periodStart: number, periodEnd: number, now: number): ManagedAiQuotaPeriod {
    const existing = mapQuotaPeriod(this.db.prepare("SELECT * FROM ManagedAiQuotaPeriod WHERE hostedUserId=? AND periodStart=? AND periodEnd=?").get(hostedUserId, periodStart, periodEnd));
    if (existing) return existing;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO ManagedAiQuotaPeriod(id, hostedUserId, periodStart, periodEnd, planKey, planRevision, quotaLimitUnits, reservedUnits, committedUnits, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, hostedUserId, periodStart, periodEnd, planKey, planRevision, quotaLimitUnits, 0, 0, now, now);
    return mapQuotaPeriod(this.db.prepare("SELECT * FROM ManagedAiQuotaPeriod WHERE id=?").get(id))!;
  }
  usage(hostedUserId: string, invocationKey: string): ManagedAiUsageRow | null {
    return mapUsage(this.db.prepare("SELECT * FROM ManagedAiUsage WHERE hostedUserId=? AND invocationKey=?").get(hostedUserId, invocationKey));
  }
  usageReceipt(hostedUserId: string, invocationKey: string): UsageReceipt | null {
    const row = this.usage(hostedUserId, invocationKey);
    if (!row) return null;
    return { id: row.id, invocationKey: row.invocationKey, status: row.status, settlement: row.settlement, chargedUnits: row.chargedUnits, createdAt: row.createdAt, completedAt: row.completedAt };
  }
  markRunning(usageId: string): void {
    this.db.prepare("UPDATE ManagedAiUsage SET status='RUNNING' WHERE id=? AND status='RESERVED'").run(usageId);
  }
  /** The sole accounting transition: terminal truth and quota counters commit together. */
  private settleInvocation(usageId: string, target: "COMMITTED" | "RELEASED" | "UNKNOWN", input: SettleSuccessInput, expectedStatus?: UsageStatus): boolean {
    return this.transaction(() => {
      const row = mapUsage(this.db.prepare("SELECT * FROM ManagedAiUsage WHERE id=?").get(usageId));
      if (!row || row.settlement !== "RESERVED" || (expectedStatus && row.status !== expectedStatus)) return false;
      // Recovery makes dispatch ambiguous. A late rejection cannot prove no execution.
      if (target === "RELEASED" && row.status === "UNKNOWN") return false;
      if (target === "UNKNOWN" && row.status === "UNKNOWN") return false;
      const settlement = target === "UNKNOWN" ? "RESERVED" : target;
      const status = target === "UNKNOWN" ? "UNKNOWN" : target === "RELEASED" ? "FAILED" : expectedStatus === "UNKNOWN" ? "UNKNOWN" : input.status ?? "SUCCEEDED";
      const changed = this.db.prepare(`UPDATE ManagedAiUsage SET status=?, settlement=?, chargedUnits=?, actualModel=?, inputTokens=?, outputTokens=?, gatewayRequestId=?, latencyMs=?, errorCategory=?, completedAt=?
        WHERE id=? AND settlement='RESERVED' AND status=?`)
        .run(status, settlement, target === "COMMITTED" ? row.reservedUnits : 0,
          input.actualModel ?? null, input.inputTokens ?? null, input.outputTokens ?? null, input.gatewayRequestId ?? null,
          input.latencyMs ?? null, input.errorCategory ?? null, input.completedAt, usageId, row.status);
      if (Number(changed.changes) === 0) return false;
      if (target !== "UNKNOWN") {
        const quota = this.db.prepare(`UPDATE ManagedAiQuotaPeriod SET reservedUnits=reservedUnits-?, committedUnits=committedUnits+?, updatedAt=?
          WHERE id=? AND reservedUnits>=? AND committedUnits+reservedUnits<=quotaLimitUnits`)
          .run(row.reservedUnits, target === "COMMITTED" ? row.reservedUnits : 0, input.completedAt, row.quotaPeriodId, row.reservedUnits);
        if (Number(quota.changes) !== 1) throw new Error("Quota accounting invariant violated");
      }
      return true;
    });
  }
  settleCommitted(usageId: string, input: SettleSuccessInput): void {
    this.settleInvocation(usageId, "COMMITTED", input);
  }
  settleReleased(usageId: string, errorCategory: string | null, completedAt = Date.now()): void {
    this.settleInvocation(usageId, "RELEASED", { errorCategory, completedAt });
  }
  settleUnknown(usageId: string, errorCategory: string | null, completedAt = Date.now()): void {
    this.settleInvocation(usageId, "UNKNOWN", { errorCategory, completedAt });
  }
  reconcileStaleUnknown(now: number, graceMs: number): number {
    const rows = this.db.prepare("SELECT id FROM ManagedAiUsage WHERE status='UNKNOWN' AND settlement='RESERVED' AND COALESCE(completedAt,createdAt)<=?").all(now - graceMs) as { id: string }[];
    return rows.reduce((count, { id }) => count + Number(this.settleInvocation(id, "COMMITTED", { completedAt: now }, "UNKNOWN")), 0);
  }
  recoverRunning(now = Date.now(), staleMs = 0): number {
    // Production startup holds the exclusive service ownership lock before recovery.
    return Number(this.db.prepare(`UPDATE ManagedAiUsage SET status='UNKNOWN', completedAt=?
      WHERE settlement='RESERVED' AND status IN ('RUNNING','RESERVED') AND createdAt<=?`).run(now, now - staleMs).changes);
  }
  close(): void { this.db.close(); }
}
export function provenance(binding: ManagedAiBinding): ManagedProvenance {
  return { schemaVersion: 1, managedBindingId: binding.id, requestedModelKey: binding.modelKey,
    upstreamModelId: binding.upstreamModelId, mappingRevision: binding.mappingRevision, adapterContractRevision: binding.adapterContractRevision };
}

/** Shared validation for operator preview and transactional mutation. */
export function validateSubscriptionInput(hostedUserId: string, input: SetSubscriptionInput): Required<SetSubscriptionInput> {
  if (!hostedUserId.trim()) throw new Error("Invalid hosted user");
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(input.planKey)) throw new Error("Invalid plan key");
  if (!SUBSCRIPTION_STATUSES.includes(input.status)) throw new Error("Invalid subscription status");
  if (!Number.isSafeInteger(input.periodStart) || !Number.isSafeInteger(input.periodEnd) || input.periodStart < 0 || input.periodEnd <= input.periodStart) throw new Error("Invalid subscription period");
  if (input.cancelAtPeriodEnd !== undefined && typeof input.cancelAtPeriodEnd !== "boolean") throw new Error("Invalid subscription cancellation");
  const source = (input.source ?? "OPERATOR").trim();
  if (!source) throw new Error("Invalid subscription source");
  for (const value of [input.externalSubscriptionRef, input.sourceRevision]) {
    if (value != null && (typeof value !== "string" || !value.trim())) throw new Error("Invalid subscription source metadata");
  }
  return { ...input, cancelAtPeriodEnd: input.cancelAtPeriodEnd === true, source,
    externalSubscriptionRef: input.externalSubscriptionRef?.trim() ?? null, sourceRevision: input.sourceRevision?.trim() ?? null };
}

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ManagedError } from "../../../../src/lib/ai/managed-contract";

const digest = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Operator tokens deliberately use a distinct wire format. A hosted session
 * token never satisfies the `ops_` shape and an operator token never satisfies
 * the hosted `Bearer <43-char>` shape, so the two authorities are disjoint by
 * construction and additionally live in separate tables.
 */
export const OPERATOR_CREDENTIAL_PREFIX = "opc_";
export const OPERATOR_SESSION_PREFIX = "ops_";
export const OPERATOR_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface OperatorIdentity { credentialId: string; label: string; tokenHash: string }
export interface RuntimeState { disabled: boolean; reason: string | null; updatedAt: number; updatedBy: string | null }
export interface StagedCatalogRow {
  id: string; revision: string; status: "VALIDATED" | "INVALID";
  validationErrors: string[]; createdBy: string | null; createdAt: number;
}
export interface ProbeResult {
  probedAt: number; ok: boolean; httpStatus: number | null; latencyMs: number | null; error: string | null; updatedBy: string | null;
}
export interface AuditEntry {
  credentialId: string | null; action: string; target: string | null;
  detail: Record<string, unknown> | null; result: "OK" | "DENIED" | "FAILED";
}
export interface AuditRow extends AuditEntry { id: string; createdAt: number }

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => (value == null ? null : String(value));
const num = (value: unknown): number => Number(value ?? 0);
const bool = (value: unknown): boolean => Number(value) === 1;

function mapStaged(row: Row | undefined, withPayload: boolean): (StagedCatalogRow & { payload?: unknown }) | null {
  if (!row) return null;
  const errors = text(row.validationErrors);
  const result: StagedCatalogRow & { payload?: unknown } = {
    id: String(row.id), revision: String(row.revision), status: row.status === "VALIDATED" ? "VALIDATED" : "INVALID",
    validationErrors: errors ? (JSON.parse(errors) as string[]) : [], createdBy: text(row.createdBy), createdAt: num(row.createdAt),
  };
  if (withPayload) result.payload = JSON.parse(String(row.payload));
  return result;
}

/**
 * Operator authority bound to the same authority database as HostedStore via
 * the internal handle. It never mutates the usage ledger, binding snapshots or
 * plan policy; hosted-table writes go through HostedStore's authoritative
 * methods with an audit callback committed in the same transaction.
 */
export class OperatorStore {
  constructor(private readonly db: DatabaseSync, private readonly now: () => number = () => Date.now()) {}
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  // ---- Operator credentials (trusted CLI issuance only, never over HTTP) ----
  createCredential(label: string, actor: { credentialId: string }): { id: string; secret: string } {
    if (!label.trim() || label.length > 128) throw new Error("Invalid operator credential label");
    const id = randomUUID();
    const secret = OPERATOR_CREDENTIAL_PREFIX + randomBytes(32).toString("base64url");
    return this.transaction(() => {
      this.db.prepare("INSERT INTO OperatorCredential(id, label, secretHash, createdAt, revokedAt) VALUES (?,?,?,?,NULL)")
        .run(id, label.trim(), digest(secret), this.now());
      this.audit({ credentialId: actor.credentialId, action: "credential.create", target: id, detail: { label: label.trim() }, result: "OK" });
      return { id, secret };
    });
  }
  listCredentials(): { id: string; label: string; createdAt: number; revokedAt: number | null }[] {
    return (this.db.prepare("SELECT id, label, createdAt, revokedAt FROM OperatorCredential ORDER BY createdAt, id").all() as Row[])
      .map(row => ({ id: String(row.id), label: String(row.label), createdAt: num(row.createdAt), revokedAt: row.revokedAt == null ? null : num(row.revokedAt) }));
  }
  /** Revoking a credential immediately invalidates every session it issued. */
  revokeCredential(id: string, actor: { credentialId: string }): boolean {
    return this.transaction(() => {
      const changed = this.db.prepare("UPDATE OperatorCredential SET revokedAt=? WHERE id=? AND revokedAt IS NULL").run(this.now(), id);
      this.db.prepare("DELETE FROM OperatorSession WHERE credentialId=?").run(id);
      this.audit({ credentialId: actor.credentialId, action: "credential.revoke", target: id, detail: null, result: Number(changed.changes) === 1 ? "OK" : "FAILED" });
      return Number(changed.changes) === 1;
    });
  }

  // ---- Operator sessions ----
  /** `credentialId` is still reported on failure so the caller can audit precisely. */
  login(secret: string, ttlMs = OPERATOR_SESSION_TTL_MS):
    { ok: true; token: string; expiresAt: number; credentialId: string; label: string } | { ok: false; credentialId: string | null } {
    if (!new RegExp(`^${OPERATOR_CREDENTIAL_PREFIX}[A-Za-z0-9_-]{43}$`).test(secret)) return { ok: false, credentialId: null };
    const credential = this.db.prepare("SELECT id, label, revokedAt FROM OperatorCredential WHERE secretHash=?").get(digest(secret)) as Row | undefined;
    if (!credential) return { ok: false, credentialId: null };
    if (credential.revokedAt != null) return { ok: false, credentialId: String(credential.id) };
    const now = this.now();
    const token = OPERATOR_SESSION_PREFIX + randomBytes(32).toString("base64url");
    const expiresAt = now + Math.min(Math.max(ttlMs, 60_000), 7 * 24 * 60 * 60 * 1000);
    return this.transaction(() => {
      this.db.prepare("DELETE FROM OperatorSession WHERE expiresAt<=?").run(now);
      this.db.prepare("INSERT INTO OperatorSession(tokenHash, credentialId, expiresAt, createdAt) VALUES (?,?,?,?)")
        .run(digest(token), String(credential.id), expiresAt, now);
      return { ok: true as const, token, expiresAt, credentialId: String(credential.id), label: String(credential.label) };
    });
  }
  authenticate(authorization: string | null): OperatorIdentity {
    const match = new RegExp(`^Bearer (${OPERATOR_SESSION_PREFIX}[A-Za-z0-9_-]{43})$`).exec(authorization ?? "");
    if (!match) throw new ManagedError("MANAGED_AUTH_REQUIRED");
    const tokenHash = digest(match[1]);
    const row = this.db.prepare(`SELECT s.tokenHash, s.expiresAt, c.id AS credentialId, c.label, c.revokedAt
      FROM OperatorSession s JOIN OperatorCredential c ON c.id=s.credentialId WHERE s.tokenHash=?`).get(tokenHash) as Row | undefined;
    if (!row || num(row.expiresAt) <= this.now() || row.revokedAt != null) throw new ManagedError("MANAGED_AUTH_REQUIRED");
    return { credentialId: String(row.credentialId), label: String(row.label), tokenHash };
  }
  logout(tokenHash: string): void { this.db.prepare("DELETE FROM OperatorSession WHERE tokenHash=?").run(tokenHash); }

  // ---- Audit ----
  /** Audit detail is a caller-whitelisted object; secrets and tokens are never passed in. */
  audit(entry: AuditEntry): void {
    this.db.prepare("INSERT INTO OperatorAudit(id, credentialId, action, target, detail, result, createdAt) VALUES (?,?,?,?,?,?,?)")
      .run(randomUUID(), entry.credentialId, entry.action, entry.target, entry.detail == null ? null : JSON.stringify(entry.detail), entry.result, this.now());
  }
  /** Audit closure for HostedStore write methods; commits in the same transaction. */
  auditFor(identity: OperatorIdentity, action: string, target: string | null, detail: Record<string, unknown> | null): (db: DatabaseSync) => void {
    return () => this.audit({ credentialId: identity.credentialId, action, target, detail, result: "OK" });
  }
  /** Composite createdAt:id keyset cursor — rows sharing a millisecond are never skipped. */
  listAudit(cursor: string | null, limit: number): { items: AuditRow[]; nextCursor: string | null } {
    const marker = cursor ? cursor.split(":") : null;
    const rows = (!marker || !Number.isSafeInteger(Number(marker[0]))
      ? this.db.prepare("SELECT * FROM OperatorAudit ORDER BY createdAt DESC, id DESC LIMIT ?").all(limit)
      : this.db.prepare("SELECT * FROM OperatorAudit WHERE createdAt<? OR (createdAt=? AND id<?) ORDER BY createdAt DESC, id DESC LIMIT ?")
        .all(Number(marker[0]), Number(marker[0]), marker.slice(1).join(":"), limit)) as Row[];
    const last = rows.at(-1);
    return {
      items: rows.map(row => ({
        id: String(row.id), credentialId: text(row.credentialId), action: String(row.action), target: text(row.target),
        detail: row.detail == null ? null : (JSON.parse(String(row.detail)) as Record<string, unknown>),
        result: row.result as AuditRow["result"], createdAt: num(row.createdAt),
      })),
      nextCursor: rows.length === limit && last ? `${num(last.createdAt)}:${String(last.id)}` : null,
    };
  }

  // ---- Runtime kill switch (durable; enforced inside reserveInvocation) ----
  runtimeState(): RuntimeState {
    const row = this.db.prepare("SELECT disabled, reason, updatedAt, updatedBy FROM ManagedAiRuntimeState WHERE id=1").get() as Row | undefined;
    if (!row) return { disabled: true, reason: "runtime state missing", updatedAt: 0, updatedBy: null };
    return { disabled: bool(row.disabled), reason: text(row.reason), updatedAt: num(row.updatedAt), updatedBy: text(row.updatedBy) };
  }
  setRuntimeDisabled(disabled: boolean, actor: OperatorIdentity, reason: string | null): RuntimeState {
    return this.transaction(() => {
      this.db.prepare("INSERT OR IGNORE INTO ManagedAiRuntimeState(id, disabled, updatedAt) VALUES (1, 0, 0)").run();
      this.db.prepare("UPDATE ManagedAiRuntimeState SET disabled=?, reason=?, updatedAt=?, updatedBy=? WHERE id=1")
        .run(disabled ? 1 : 0, reason, this.now(), actor.credentialId);
      this.audit({ credentialId: actor.credentialId, action: disabled ? "runtime.disable" : "runtime.enable", target: "runtime", detail: reason ? { reason } : null, result: "OK" });
      return this.runtimeState();
    });
  }

  // ---- Staged catalog (review-only; no activation path exists) ----
  /** Returns null when the revision is already staged — one row per revision. */
  createStagedCatalog(payload: unknown, revision: string, errors: string[], createdBy: OperatorIdentity): StagedCatalogRow | null {
    const id = randomUUID();
    return this.transaction(() => {
      if (this.db.prepare("SELECT id FROM ManagedAiStagedCatalog WHERE revision=?").get(revision)) {
        this.audit({ credentialId: createdBy.credentialId, action: "catalog.stage", target: revision, detail: { error: "STAGED_REVISION_EXISTS" }, result: "DENIED" });
        return null;
      }
      this.db.prepare("INSERT INTO ManagedAiStagedCatalog(id, revision, payload, status, validationErrors, createdBy, createdAt) VALUES (?,?,?,?,?,?,?)")
        .run(id, revision, JSON.stringify(payload), errors.length ? "INVALID" : "VALIDATED", errors.length ? JSON.stringify(errors) : null, createdBy.credentialId, this.now());
      this.audit({ credentialId: createdBy.credentialId, action: "catalog.stage", target: revision, detail: { status: errors.length ? "INVALID" : "VALIDATED", errors }, result: "OK" });
      return mapStaged(this.db.prepare("SELECT * FROM ManagedAiStagedCatalog WHERE id=?").get(id) as Row, false)!;
    });
  }
  listStagedCatalogs(limit: number): StagedCatalogRow[] {
    return (this.db.prepare("SELECT * FROM ManagedAiStagedCatalog ORDER BY createdAt DESC, id DESC LIMIT ?").all(limit) as Row[])
      .map(row => mapStaged(row, false)!);
  }
  stagedCatalog(id: string): (StagedCatalogRow & { payload?: unknown }) | null {
    return mapStaged(this.db.prepare("SELECT * FROM ManagedAiStagedCatalog WHERE id=?").get(id) as Row | undefined, true);
  }

  // ---- Provider probe (connectivity only; never sends credentials upstream) ----
  recordProbe(probe: { ok: boolean; httpStatus: number | null; latencyMs: number; error: string | null }, actor: OperatorIdentity): ProbeResult {
    const probedAt = this.now();
    this.transaction(() => {
      this.db.prepare(`INSERT INTO ManagedAiProviderProbe(id, probedAt, ok, httpStatus, latencyMs, error, updatedBy) VALUES (1,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET probedAt=excluded.probedAt, ok=excluded.ok, httpStatus=excluded.httpStatus, latencyMs=excluded.latencyMs, error=excluded.error, updatedBy=excluded.updatedBy`)
        .run(probedAt, probe.ok ? 1 : 0, probe.httpStatus, probe.latencyMs, probe.error, actor.credentialId);
      this.audit({ credentialId: actor.credentialId, action: "provider.probe", target: "provider", detail: { ok: probe.ok, httpStatus: probe.httpStatus, latencyMs: probe.latencyMs, error: probe.error }, result: "OK" });
    });
    return this.lastProbe()!;
  }
  lastProbe(): ProbeResult | null {
    const row = this.db.prepare("SELECT * FROM ManagedAiProviderProbe WHERE id=1").get() as Row | undefined;
    if (!row) return null;
    return { probedAt: num(row.probedAt), ok: bool(row.ok), httpStatus: row.httpStatus == null ? null : num(row.httpStatus),
      latencyMs: row.latencyMs == null ? null : num(row.latencyMs), error: text(row.error), updatedBy: text(row.updatedBy) };
  }

  // ---- Hosted read surface (queries only; writes stay in HostedStore) ----
  overview(now: number): Record<string, unknown> {
    const one = (sql: string, ...args: number[]) => num((this.db.prepare(sql).get(...args) as Row | undefined)?.n);
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const byStatus = (this.db.prepare("SELECT status, COUNT(*) AS n FROM ManagedAiUsage WHERE createdAt>=? GROUP BY status").all(dayAgo) as Row[])
      .map(row => ({ status: String(row.status), count: num(row.n) }));
    return {
      users: { total: one("SELECT COUNT(*) AS n FROM HostedUser"), activeSubscriptions: one("SELECT COUNT(*) AS n FROM Subscription WHERE status='ACTIVE' AND periodStart<=? AND periodEnd>?", now, now) },
      sessions: { activeHosted: one("SELECT COUNT(*) AS n FROM HostedSession WHERE expiresAt>?", now), activeOperator: one("SELECT COUNT(*) AS n FROM OperatorSession WHERE expiresAt>?", now) },
      usage: {
        last24hByStatus: byStatus,
        committedUnits24h: one("SELECT COALESCE(SUM(chargedUnits),0) AS n FROM ManagedAiUsage WHERE settlement='COMMITTED' AND createdAt>=?", dayAgo),
        openUnknown: one("SELECT COUNT(*) AS n FROM ManagedAiUsage WHERE status='UNKNOWN' AND settlement='RESERVED'"),
      },
      runtime: this.runtimeState(),
    };
  }
  listUsers(filter: { search: string | null; cursor: string | null; limit: number }): { items: Row[]; nextCursor: string | null } {
    const clauses: string[] = []; const args: (string | number)[] = [];
    if (filter.search) { clauses.push("u.id LIKE ? ESCAPE '\\'"); args.push(`%${filter.search.replace(/[\\%_]/g, c => `\\${c}`)}%`); }
    if (filter.cursor) { clauses.push("u.id > ?"); args.push(filter.cursor); }
    // The expiresAt placeholder sits in the SELECT subquery, so `now` binds first.
    const rows = this.db.prepare(`SELECT u.id, s.planKey, s.status, s.periodStart, s.periodEnd, s.revision,
        (SELECT COUNT(*) FROM HostedSession hs WHERE hs.hostedUserId=u.id AND hs.expiresAt>?) AS activeSessions,
        (SELECT COUNT(*) FROM ManagedAiUsage mu WHERE mu.hostedUserId=u.id) AS invocations,
        (SELECT COALESCE(SUM(chargedUnits),0) FROM ManagedAiUsage cu WHERE cu.hostedUserId=u.id AND cu.settlement='COMMITTED') AS committedUnits
      FROM HostedUser u LEFT JOIN Subscription s ON s.hostedUserId=u.id
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""} ORDER BY u.id LIMIT ?`)
      .all(this.now(), ...args, filter.limit) as Row[];
    return { items: rows, nextCursor: rows.length === filter.limit ? String(rows.at(-1)!.id) : null };
  }
  userExists(hostedUserId: string): boolean {
    return !!this.db.prepare("SELECT id FROM HostedUser WHERE id=?").get(hostedUserId);
  }
  userDetail(hostedUserId: string): {
    subscription: Row | null; quotaPeriods: Row[]; sessions: { prefix: string; expiresAt: number }[];
    bindings: Row[]; usage: { total: number; committedUnits: number; byStatus: { status: string; count: number }[] }; recentUsage: Row[];
  } | null {
    if (!this.userExists(hostedUserId)) return null;
    return {
      subscription: (this.db.prepare("SELECT * FROM Subscription WHERE hostedUserId=?").get(hostedUserId) as Row | undefined) ?? null,
      quotaPeriods: this.db.prepare("SELECT * FROM ManagedAiQuotaPeriod WHERE hostedUserId=? ORDER BY periodStart DESC").all(hostedUserId) as Row[],
      sessions: (this.db.prepare("SELECT tokenHash, expiresAt FROM HostedSession WHERE hostedUserId=? AND expiresAt>? ORDER BY expiresAt").all(hostedUserId, this.now()) as Row[])
        .map(row => ({ prefix: String(row.tokenHash).slice(0, 12), expiresAt: num(row.expiresAt) })),
      bindings: (this.db.prepare("SELECT snapshot FROM ManagedAiBinding WHERE hostedUserId=?").all(hostedUserId) as Row[])
        .map(row => JSON.parse(String(row.snapshot)) as Row),
      usage: {
        total: num((this.db.prepare("SELECT COUNT(*) AS n FROM ManagedAiUsage WHERE hostedUserId=?").get(hostedUserId) as Row)?.n),
        committedUnits: num((this.db.prepare("SELECT COALESCE(SUM(chargedUnits),0) FROM ManagedAiUsage WHERE hostedUserId=? AND settlement='COMMITTED'").get(hostedUserId) as Row)?.n),
        byStatus: (this.db.prepare("SELECT status, COUNT(*) AS n FROM ManagedAiUsage WHERE hostedUserId=? GROUP BY status").all(hostedUserId) as Row[])
          .map(row => ({ status: String(row.status), count: num(row.n) })),
      },
      recentUsage: this.db.prepare("SELECT * FROM ManagedAiUsage WHERE hostedUserId=? ORDER BY createdAt DESC, id DESC LIMIT 20").all(hostedUserId) as Row[],
    };
  }
  /** Revokes hosted sessions by hash prefix, or all of a user's sessions when no prefix is given. */
  revokeUserSessions(hostedUserId: string, prefix: string | null, actor: OperatorIdentity): number {
    return this.transaction(() => {
      const result = prefix
        ? this.db.prepare("DELETE FROM HostedSession WHERE hostedUserId=? AND substr(tokenHash,1,?)=?").run(hostedUserId, prefix.length, prefix)
        : this.db.prepare("DELETE FROM HostedSession WHERE hostedUserId=?").run(hostedUserId);
      this.audit({ credentialId: actor.credentialId, action: "hostedsession.revoke", target: hostedUserId, detail: { prefix, revoked: Number(result.changes) }, result: "OK" });
      return Number(result.changes);
    });
  }
  listUsage(filter: { hostedUserId: string | null; status: string | null; business: string | null; cursor: string | null; limit: number }): { items: Row[]; nextCursor: string | null } {
    const clauses: string[] = []; const args: (string | number)[] = [];
    if (filter.hostedUserId) { clauses.push("hostedUserId=?"); args.push(filter.hostedUserId); }
    if (filter.status) { clauses.push("status=?"); args.push(filter.status); }
    if (filter.business) { clauses.push("business=?"); args.push(filter.business); }
    if (filter.cursor) {
      const [createdAt, id] = filter.cursor.split(":");
      clauses.push("(createdAt<? OR (createdAt=? AND id<?))"); args.push(Number(createdAt), Number(createdAt), id ?? "");
    }
    const rows = this.db.prepare(`SELECT * FROM ManagedAiUsage ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY createdAt DESC, id DESC LIMIT ?`).all(...args, filter.limit) as Row[];
    const last = rows.at(-1);
    return { items: rows, nextCursor: rows.length === filter.limit && last ? `${num(last.createdAt)}:${String(last.id)}` : null };
  }
}

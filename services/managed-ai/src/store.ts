import { createHash, randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { MANAGED_ADAPTER_REVISION, ManagedError, type ManagedProvenance } from "../../../src/lib/ai/managed-contract";
import type { ManagedModel } from "./catalog";

export interface ManagedAiBinding {
  id: string; hostedUserId: string; business: string; resourceKey: string;
  modelKey: string; upstreamModelId: string; mappingRevision: string;
  adapterContractRevision: string; createdAt: string;
  allowedModelAliases: string[]; maxInputTokens: number; maxOutputTokens: number;
}
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
export class HostedStore {
  private readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS HostedUser(id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS HostedSession(tokenHash TEXT PRIMARY KEY, hostedUserId TEXT NOT NULL REFERENCES HostedUser(id), expiresAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS ManagedAiBinding(id TEXT PRIMARY KEY, hostedUserId TEXT NOT NULL REFERENCES HostedUser(id), business TEXT NOT NULL, resourceKey TEXT NOT NULL, modelKey TEXT NOT NULL, snapshot TEXT NOT NULL, UNIQUE(hostedUserId,business,resourceKey));
      CREATE TRIGGER IF NOT EXISTS ImmutableManagedBinding BEFORE UPDATE ON ManagedAiBinding BEGIN SELECT RAISE(ABORT,'immutable binding'); END;`);
  }
  /** Operator/identity-issuer only. Never exposed through the request router. */
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
  close(): void { this.db.close(); }
}
export function provenance(binding: ManagedAiBinding): ManagedProvenance {
  return { schemaVersion: 1, managedBindingId: binding.id, requestedModelKey: binding.modelKey,
    upstreamModelId: binding.upstreamModelId, mappingRevision: binding.mappingRevision, adapterContractRevision: binding.adapterContractRevision };
}

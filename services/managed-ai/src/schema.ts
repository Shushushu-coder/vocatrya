import { DatabaseSync } from "node:sqlite";

export interface SchemaMigration {
  version: number;
  name: string;
  up(db: DatabaseSync): void;
}

/**
 * Ordered, versioned Hosted schema migrations. Each migration runs inside
 * its own write transaction and is recorded in HostedSchemaMigration, so
 * re-running against a fresh or an already-upgraded database is idempotent.
 * An existing M2 database already contains the v1 baseline tables; those
 * statements are `IF NOT EXISTS` on purpose and upgrade it in place without
 * a destructive reset.
 */
export const MIGRATIONS: SchemaMigration[] = [
  {
    version: 1,
    name: "m2-hosted-baseline",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS HostedUser(id TEXT PRIMARY KEY);
        CREATE TABLE IF NOT EXISTS HostedSession(tokenHash TEXT PRIMARY KEY, hostedUserId TEXT NOT NULL REFERENCES HostedUser(id), expiresAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ManagedAiBinding(id TEXT PRIMARY KEY, hostedUserId TEXT NOT NULL REFERENCES HostedUser(id), business TEXT NOT NULL, resourceKey TEXT NOT NULL, modelKey TEXT NOT NULL, snapshot TEXT NOT NULL, UNIQUE(hostedUserId,business,resourceKey));
        CREATE TRIGGER IF NOT EXISTS ImmutableManagedBinding BEFORE UPDATE ON ManagedAiBinding BEGIN SELECT RAISE(ABORT,'immutable binding'); END;`);
    },
  },
  {
    version: 2,
    name: "m3-commercial-authority",
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS Subscription(
          id TEXT PRIMARY KEY,
          hostedUserId TEXT NOT NULL UNIQUE REFERENCES HostedUser(id),
          planKey TEXT NOT NULL,
          status TEXT NOT NULL,
          periodStart INTEGER NOT NULL,
          periodEnd INTEGER NOT NULL,
          cancelAtPeriodEnd INTEGER NOT NULL DEFAULT 0,
          source TEXT NOT NULL,
          externalSubscriptionRef TEXT,
          sourceRevision TEXT,
          revision INTEGER NOT NULL DEFAULT 1,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ManagedAiQuotaPeriod(
          id TEXT PRIMARY KEY,
          hostedUserId TEXT NOT NULL REFERENCES HostedUser(id),
          periodStart INTEGER NOT NULL,
          periodEnd INTEGER NOT NULL,
          planKey TEXT NOT NULL,
          planRevision TEXT NOT NULL,
          quotaLimitUnits INTEGER NOT NULL,
          reservedUnits INTEGER NOT NULL DEFAULT 0,
          committedUnits INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL,
          UNIQUE(hostedUserId, periodStart, periodEnd));
        CREATE INDEX IF NOT EXISTS ManagedAiQuotaPeriodHostedUser ON ManagedAiQuotaPeriod(hostedUserId);
        CREATE TABLE IF NOT EXISTS ManagedAiUsage(
          id TEXT PRIMARY KEY,
          hostedUserId TEXT NOT NULL REFERENCES HostedUser(id),
          business TEXT NOT NULL,
          resourceKey TEXT NOT NULL,
          operationId TEXT NOT NULL,
          invocationKey TEXT NOT NULL,
          attemptIndex INTEGER NOT NULL,
          requestHash TEXT NOT NULL,
          managedBindingId TEXT NOT NULL,
          modelKey TEXT NOT NULL,
          upstreamModelId TEXT NOT NULL,
          actualModel TEXT,
          status TEXT NOT NULL,
          settlement TEXT NOT NULL,
          quotaPeriodId TEXT NOT NULL,
          reservedUnits INTEGER NOT NULL,
          chargedUnits INTEGER NOT NULL,
          inputTokens INTEGER,
          outputTokens INTEGER,
          gatewayRequestId TEXT,
          latencyMs INTEGER,
          errorCategory TEXT,
          createdAt INTEGER NOT NULL,
          completedAt INTEGER,
          UNIQUE(hostedUserId, invocationKey));
        CREATE INDEX IF NOT EXISTS ManagedAiUsageQuotaPeriod ON ManagedAiUsage(quotaPeriodId);
        CREATE INDEX IF NOT EXISTS ManagedAiUsageStatus ON ManagedAiUsage(status);`);
    },
  },
  {
    version: 3,
    name: "operator-surface",
    up(db) {
      // Operator identity is a separate authority from HostedSession. Operator
      // secrets are stored only as SHA-256 digests; sessions are short-lived
      // bearer tokens. The runtime row is the durable kill-switch state read by
      // admission inside the reservation transaction. Staged catalogs are
      // review payloads only — this schema has no activation path.
      db.exec(`
        CREATE TABLE IF NOT EXISTS OperatorCredential(
          id TEXT PRIMARY KEY,
          label TEXT NOT NULL,
          secretHash TEXT NOT NULL UNIQUE,
          createdAt INTEGER NOT NULL,
          revokedAt INTEGER);
        CREATE TABLE IF NOT EXISTS OperatorSession(
          tokenHash TEXT PRIMARY KEY,
          credentialId TEXT NOT NULL REFERENCES OperatorCredential(id),
          expiresAt INTEGER NOT NULL,
          createdAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS OperatorSessionCredential ON OperatorSession(credentialId);
        CREATE TABLE IF NOT EXISTS OperatorAudit(
          id TEXT PRIMARY KEY,
          credentialId TEXT,
          action TEXT NOT NULL,
          target TEXT,
          detail TEXT,
          result TEXT NOT NULL,
          createdAt INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS OperatorAuditCreatedAt ON OperatorAudit(createdAt, id);
        CREATE TABLE IF NOT EXISTS ManagedAiRuntimeState(
          id INTEGER PRIMARY KEY CHECK(id=1),
          disabled INTEGER NOT NULL DEFAULT 0,
          reason TEXT,
          updatedAt INTEGER NOT NULL,
          updatedBy TEXT);
        INSERT OR IGNORE INTO ManagedAiRuntimeState(id, disabled, updatedAt) VALUES (1, 0, 0);
        CREATE TABLE IF NOT EXISTS ManagedAiStagedCatalog(
          id TEXT PRIMARY KEY,
          revision TEXT NOT NULL UNIQUE,
          payload TEXT NOT NULL,
          status TEXT NOT NULL,
          validationErrors TEXT,
          createdBy TEXT,
          createdAt INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS ManagedAiProviderProbe(
          id INTEGER PRIMARY KEY CHECK(id=1),
          probedAt INTEGER NOT NULL,
          ok INTEGER NOT NULL,
          httpStatus INTEGER,
          latencyMs INTEGER,
          error TEXT,
          updatedBy TEXT);`);
    },
  },
];

/** Compare the actual baseline contract before allowing IF NOT EXISTS to adopt it. */
export function validateHostedSchema(db: DatabaseSync, version: number): void {
  const expected = new DatabaseSync(":memory:");
  try {
    for (const migration of MIGRATIONS.filter(item => item.version <= version)) migration.up(expected);
    const tables = expected.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    const quote = (name: string) => `'${name.replaceAll("'", "''")}'`;
    for (const { name } of tables) {
      const columns = (database: DatabaseSync) => database.prepare(`PRAGMA table_info(${quote(name)})`).all();
      if (JSON.stringify(columns(db)) !== JSON.stringify(columns(expected))) throw new Error(`Invalid Hosted schema: ${name} columns`);
      const foreignKeys = (database: DatabaseSync) => database.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all();
      if (JSON.stringify(foreignKeys(db)) !== JSON.stringify(foreignKeys(expected))) throw new Error(`Invalid Hosted schema: ${name} foreign keys`);
      const indexes = (database: DatabaseSync) => (database.prepare(`PRAGMA index_list(${quote(name)})`).all() as { name: string; unique: number; partial: number }[]).map(index => ({
        unique: index.unique, partial: index.partial,
        columns: database.prepare(`PRAGMA index_info(${quote(index.name)})`).all().map(column => column.name),
      }));
      const actualIndexes = indexes(db).map(index => JSON.stringify(index));
      if (indexes(expected).some(index => !actualIndexes.includes(JSON.stringify(index)))) throw new Error(`Invalid Hosted schema: ${name} indexes`);
    }
    const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='ImmutableManagedBinding'").get();
    const canonical = (sql: unknown) => String(sql).replace(/\s+/g, " ").replace(/IF NOT EXISTS /ig, "").trim().toLowerCase();
    const expectedTrigger = expected.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='ImmutableManagedBinding'").get();
    if (!trigger || canonical(trigger.sql) !== canonical(expectedTrigger!.sql)) throw new Error("Invalid Hosted schema: binding immutability trigger");
  } finally { expected.close(); }
}

export function applyMigrations(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const baselineExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('HostedUser','HostedSession','ManagedAiBinding')").all().length > 0;
    if (baselineExists) validateHostedSchema(db, 1);
    db.exec(`CREATE TABLE IF NOT EXISTS HostedSchemaMigration(version INTEGER PRIMARY KEY, name TEXT NOT NULL, appliedAt INTEGER NOT NULL)`);
    const rows = db.prepare("SELECT version, name FROM HostedSchemaMigration ORDER BY version").all() as { version: number; name: string }[];
    if (rows.some((row, index) => row.version !== index + 1 || !MIGRATIONS.some(migration => migration.version === row.version && migration.name === row.name))) throw new Error("Invalid Hosted migration history");
    const applied = new Set(rows.map(row => row.version));
    if (rows.length) validateHostedSchema(db, rows.at(-1)!.version);
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      migration.up(db);
      validateHostedSchema(db, migration.version);
      db.prepare("INSERT INTO HostedSchemaMigration(version, name, appliedAt) VALUES (?, ?, ?)").run(migration.version, migration.name, Date.now());
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("SELECT MAX(version) AS version FROM HostedSchemaMigration").get() as { version: number | null };
  return row?.version ?? 0;
}

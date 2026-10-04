import type { PrismaClient } from "@prisma/client";
import {
  AB_INSTANCE_SCOPE_KEY,
  AB_MIGRATION_KEY,
  AB_MIGRATION_STATUS,
  type AbMigrationStatus,
} from "./identities";

export type MigrationStateDb = Pick<PrismaClient, "abMigrationState">;

export type InstanceMigrationState = {
  id: string;
  scopeKey: string;
  migrationKey: string;
  status: AbMigrationStatus;
  completedAt: Date | null;
  verifiedAt: Date | null;
  errorCode: string | null;
};

const DEFAULT_STATE: InstanceMigrationState = {
  id: "",
  scopeKey: AB_INSTANCE_SCOPE_KEY,
  migrationKey: AB_MIGRATION_KEY,
  status: AB_MIGRATION_STATUS.NOT_STARTED,
  completedAt: null,
  verifiedAt: null,
  errorCode: null,
};

export function hasMigrationStateDelegate(client: object): client is MigrationStateDb {
  return (
    typeof (client as { abMigrationState?: { findUnique?: unknown } })
      .abMigrationState?.findUnique === "function"
  );
}

/**
 * Row count for the migration-state table. Null means the client cannot
 * count, which is not proof that cardinality is 1.
 */
export async function countMigrationStateRows(db: object): Promise<number | null> {
  const count = (
    db as { abMigrationState?: { count?: () => Promise<number> } }
  ).abMigrationState?.count;
  if (typeof count !== "function") return null;
  return count();
}

const KNOWN_STATUS = new Set<string>(Object.values(AB_MIGRATION_STATUS));

export function isKnownAbMigrationStatus(
  value: string,
): value is AbMigrationStatus {
  return KNOWN_STATUS.has(value);
}

function asStatus(value: string): AbMigrationStatus {
  if (isKnownAbMigrationStatus(value)) {
    return value;
  }
  // Preserve the raw token so the resolver can fail closed instead of
  // pretending the instance is still NOT_STARTED.
  return value as AbMigrationStatus;
}

export async function readInstanceMigrationState(
  db: object,
): Promise<InstanceMigrationState> {
  if (!hasMigrationStateDelegate(db)) {
    return DEFAULT_STATE;
  }
  const row = await db.abMigrationState.findUnique({
    where: { scopeKey: AB_INSTANCE_SCOPE_KEY },
  });
  if (!row) return DEFAULT_STATE;
  return {
    id: row.id,
    scopeKey: row.scopeKey,
    migrationKey: row.migrationKey,
    status: asStatus(row.status),
    completedAt: row.completedAt,
    verifiedAt: row.verifiedAt,
    errorCode: row.errorCode,
  };
}

export async function writeInstanceMigrationState(
  db: MigrationStateDb,
  input: {
    status: AbMigrationStatus;
    errorCode?: string | null;
    completedAt?: Date | null;
    verifiedAt?: Date | null;
    migrationKey?: string;
  },
): Promise<InstanceMigrationState> {
  const data = {
    migrationKey: input.migrationKey ?? AB_MIGRATION_KEY,
    status: input.status,
    errorCode: input.errorCode ?? null,
    completedAt: input.completedAt ?? null,
    verifiedAt: input.verifiedAt ?? null,
  };
  const row = await db.abMigrationState.upsert({
    where: { scopeKey: AB_INSTANCE_SCOPE_KEY },
    create: {
      scopeKey: AB_INSTANCE_SCOPE_KEY,
      ...data,
    },
    update: data,
  });
  return {
    id: row.id,
    scopeKey: row.scopeKey,
    migrationKey: row.migrationKey,
    status: asStatus(row.status),
    completedAt: row.completedAt,
    verifiedAt: row.verifiedAt,
    errorCode: row.errorCode,
  };
}

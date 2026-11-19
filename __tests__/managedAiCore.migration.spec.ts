// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { makeAbTestDbUrl, preparePrismaProject, preparePrismaProjectThrough, migrateDeploy, copyMigrationBySuffix, copyRemainingMigrations } from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

import { assertRequiredMigrationInvariants, verifyActiveManagedConstraint } from "./helpers/managedMigrationInvariant";

const suffix = "add_managed_ai_core_contracts";
// "prior" = DB as of the last migration before the chat_conversation_multi
// rebuild, i.e. everything that predates the managed contracts and the later
// ChatConversation rebuilds. All newer migrations are applied afterwards.
const PRIOR_CUTOFF_MIGRATION = "add_chat_conversation_ai_lock";
const owners = ["InterviewSession", "ChatConversation", "AutomationRun", "ResumeVariantVersion", "MatchAnalysis", "JobDescriptionParse"];
const sql = fs.readFileSync(path.resolve(__dirname, "../prisma/migrations/20261008000000_add_managed_ai_core_contracts/migration.sql"), "utf8");

describe("Managed M1 official migrations", () => {
  it("adds exactly six nullable columns and one partial index, with no rewrite/backfill/hosted tables", () => {
    expect(sql.match(/ADD COLUMN/g)).toHaveLength(6);
    expect(sql.match(/CREATE UNIQUE INDEX/g)).toHaveLength(1);
    expect(sql).not.toMatch(/\b(UPDATE|DELETE|DROP|RENAME|DEFAULT|CREATE TABLE)\b/i);
    for (const owner of owners) expect(sql).toContain(`ALTER TABLE "${owner}" ADD COLUMN "managedAiProvenance" TEXT`);
  });

  it.each(["fresh", "current", "prior"])("migrate deploy upgrades %s DB and preserves old rows semantically", async (baseline) => {
    const ctx = makeAbTestDbUrl();
    const schema = baseline === "prior"
      ? preparePrismaProjectThrough(ctx.dir, PRIOR_CUTOFF_MIGRATION)
      : preparePrismaProject(ctx.dir, { excludeSuffix: baseline === "fresh" ? [] : [suffix] });
    const client = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schema);
      if (baseline !== "fresh") {
        // The prior DB is seeded with raw SQL (cutoff-era columns only); the
        // generated client targets the latest schema.
        let userId: string;
        if (baseline === "prior") {
          userId = `${baseline}-user`;
          await client.$executeRaw`INSERT INTO User (id, name, email, password) VALUES (${userId}, 'Test User', ${`${baseline}@example.com`}, 'x')`;
        } else {
          userId = await seedAccount(client, `${baseline}@example.com`);
        }
        const stamp = new Date().toISOString();
        await client.$executeRaw`INSERT INTO AIConnection (id, userId, provider, backendKind, displayName, status, updatedAt)
          VALUES ('account', ${userId}, 'OPENAI', 'CODEX_RUNTIME', 'Own account', 'CONNECTED', ${stamp})`;
        await client.$executeRaw`INSERT INTO ChatConversation (id, userId, messages, resolvedConnectionId, resolvedModel, updatedAt)
          VALUES ('conversation', ${userId}, '[{"historical":"unchanged"}]', 'account', 'own-model', ${stamp})`;
        await client.$executeRaw`INSERT INTO InterviewSession (id, userId, coachingMode, feedbackReleasePolicy, knowledgeBaseVersion, resolvedModel, updatedAt)
          VALUES ('interview', ${userId}, 'PRACTICE', 'IMMEDIATE', 'old-kb', '{"kind":"LEGACY_INTERVIEW_CONFIG","provider":"openrouter","model":"old-model"}', ${stamp})`;
        // Capture the original columns, so unrelated later additive migrations
        // can also be applied to the representative prior database.
        const snapshots = await Promise.all(["AIConnection", "InterviewSession", "ChatConversation"].map(async (table) => ({
          table, rows: await client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${table}" ORDER BY id`),
        })));
        if (baseline === "prior") copyRemainingMigrations(ctx.dir);
        else copyMigrationBySuffix(ctx.dir, suffix);
        migrateDeploy(ctx.url, schema);
        await client.$disconnect(); // refresh SQLite prepared SELECT * column metadata after ALTER
        for (const { table, rows } of snapshots) {
          const restored = await client.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${table}" ORDER BY id`);
          expect(restored.map((row) => Object.fromEntries(Object.keys(rows[0]).map((key) => [key, row[key]])))).toEqual(rows);
          if (table !== "AIConnection") expect(restored[0].managedAiProvenance).toBeNull();
        }
      }
      for (const owner of owners) {
        const columns = await client.$queryRawUnsafe<{ name: string; notnull: bigint; dflt_value: unknown }[]>(`PRAGMA table_info("${owner}")`);
        expect(columns.find((column) => column.name === "managedAiProvenance")).toMatchObject({ notnull: BigInt(0), dflt_value: null });
      }
      await assertRequiredMigrationInvariants(client);
      migrateDeploy(ctx.url, schema); // repeat deploy is a no-op
    } finally { await client.$disconnect(); }
  }, 120_000);

  it("enforces active per-user uniqueness across independent concurrent clients, including updates", async () => {
    const ctx = makeAbTestDbUrl();
    const schema = preparePrismaProject(ctx.dir);
    migrateDeploy(ctx.url, schema);
    const first = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    const second = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      const u = await seedAccount(first, "singleton@example.com");
      const v = await seedAccount(first, "other-singleton@example.com");
      const data = { userId: u, provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", displayName: "Managed", status: "DISCONNECTED" };
      const attempts = await Promise.allSettled([first.aIConnection.create({ data }), second.aIConnection.create({ data })]);
      expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      expect(rejected).toMatchObject({ reason: { code: "P2002" } });
      await expect(second.aIConnection.create({ data: { ...data, userId: v } })).resolves.toMatchObject({ userId: v });
      const active = await first.aIConnection.findFirstOrThrow({ where: { userId: u } });
      await first.aIConnection.update({ where: { id: active.id }, data: { archivedAt: new Date() } });
      await expect(second.aIConnection.create({ data })).resolves.toMatchObject({ userId: u });
      await expect(first.aIConnection.update({ where: { id: active.id }, data: { archivedAt: null } })).rejects.toMatchObject({ code: "P2002" });
      expect(await first.aIConnection.count({ where: { userId: u, archivedAt: null } })).toBe(1);
    } finally { await Promise.all([first.$disconnect(), second.$disconnect()]); }
  }, 120_000);
});


describe("Required raw migration invariants after later RedefineTables", () => {
  it.each([true, false])("full chain gates a future AIConnection rebuild (restores index: %s)", async (restoreIndex) => {
    const ctx = makeAbTestDbUrl();
    const schema = preparePrismaProject(ctx.dir);
    const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schema);
      await assertRequiredMigrationInvariants(db);
      await verifyActiveManagedConstraint(db);
      const before = await db.aIConnection.findMany({ orderBy: { id: "asc" } });
      const migrationDir = path.join(ctx.dir, "migrations", "20990101000000_future_connection_rebuild");
      fs.mkdirSync(migrationDir);
      const fixture = fs.readFileSync(path.resolve(__dirname, "fixtures/migrations/AIConnection-rebuild.sql"), "utf8");
      fs.writeFileSync(path.join(migrationDir, "migration.sql"), restoreIndex ? fixture : fixture.replace(/CREATE UNIQUE INDEX[\s\S]*?;/, ""));
      await db.$disconnect();
      migrateDeploy(ctx.url, schema);
      expect(await db.aIConnection.findMany({ orderBy: { id: "asc" } })).toEqual(before);
      if (!restoreIndex) {
        await expect(assertRequiredMigrationInvariants(db)).rejects.toThrow("Required raw migration invariant missing or changed");
        return;
      }
      await assertRequiredMigrationInvariants(db);
      await verifyActiveManagedConstraint(db);
      // Also deploy the entire history plus fixture onto an empty database.
      const fresh = makeAbTestDbUrl();
      migrateDeploy(fresh.url, schema);
      const freshDb = new PrismaClient({ datasources: { db: { url: fresh.url } } });
      try {
        await assertRequiredMigrationInvariants(freshDb);
        await verifyActiveManagedConstraint(freshDb);
      } finally { await freshDb.$disconnect(); }
    } finally { await db.$disconnect(); }
  }, 120_000);
});


it("raw invariant gate rejects a case-changed predicate that no longer constrains Managed rows", async () => {
  const ctx = makeAbTestDbUrl();
  const schema = preparePrismaProject(ctx.dir);
  migrateDeploy(ctx.url, schema);
  const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
  try {
    await db.$executeRawUnsafe('DROP INDEX "AIConnection_userId_active_managed_key"');
    await db.$executeRawUnsafe("CREATE UNIQUE INDEX AIConnection_userId_active_managed_key ON AIConnection(userId) WHERE provider = 'vocatrya' AND backendKind = 'MANAGED_GATEWAY' AND authType = 'MANAGED' AND archivedAt IS NULL");
    await expect(assertRequiredMigrationInvariants(db)).rejects.toThrow("Required raw migration invariant missing or changed");
  } finally { await db.$disconnect(); }
}, 120_000);

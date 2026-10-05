// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const migrationName = "20261005000000_resume_material_title_snapshot";
const repositoryPrisma = path.resolve(__dirname, "../prisma");
const prismaCli = path.resolve(__dirname, "../node_modules/prisma/build/index.js");
const temporaryRoots: string[] = [];

function disposablePrisma(includeSnapshot: boolean) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-history-migration-"));
  temporaryRoots.push(root);
  const schema = path.join(root, "schema.prisma");
  let source = fs.readFileSync(path.join(repositoryPrisma, "schema.prisma"), "utf8");
  if (!includeSnapshot) source = source.replace(/^\s*materialTitleSnapshot\s+String\?\r?\n/m, "");
  fs.writeFileSync(schema, source);
  const migrations = path.join(root, "migrations");
  fs.mkdirSync(migrations);
  for (const entry of fs.readdirSync(path.join(repositoryPrisma, "migrations"))) {
    if (!includeSnapshot && entry === migrationName) continue;
    fs.cpSync(path.join(repositoryPrisma, "migrations", entry), path.join(migrations, entry), { recursive: true });
  }
  return { root, schema, dbPath: path.join(root, "test.db") };
}
function deploy(schema: string, dbPath: string) {
  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy", "--schema", schema], {
    cwd: path.dirname(schema), env: { ...process.env, RUST_LOG: "info", DATABASE_URL: `file:${dbPath.replace(/\\/g, "/")}` },
    encoding: "utf8", timeout: 60_000,
  });
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
}
afterAll(() => {
  for (const root of temporaryRoots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows file handles may close late. */ }
  }
});

it("deploys all migrations into a fresh disposable database", () => {
  const ctx = disposablePrisma(true); deploy(ctx.schema, ctx.dbPath);
  const db = new DatabaseSync(ctx.dbPath);
  try {
    expect(db.prepare('PRAGMA table_info("ResumeVariantSectionItem")').all()).toContainEqual(expect.objectContaining({ name: "materialTitleSnapshot", type: "TEXT", notnull: 0 }));
  } finally { db.close(); }
}, 120_000);

it("upgrades a pre-change database using observable titles, leaving manual/orphan items and historical JD unknown", () => {
  const ctx = disposablePrisma(false); deploy(ctx.schema, ctx.dbPath);
  const before = new DatabaseSync(ctx.dbPath);
  try {
    // Orphan relation covers legacy corruption without inventing a title.
    before.exec(`PRAGMA foreign_keys = OFF;
      INSERT INTO "CareerMaterialItem" (id, userId, type, title, updatedAt) VALUES ('material', 'owner', 'PROJECT', 'Observable at migration', CURRENT_TIMESTAMP);
      INSERT INTO "ResumeVariantSectionItem" (id, resumeVariantSectionId, careerMaterialItemId, itemKind) VALUES ('linked', 'section', 'material', 'PROJECT'), ('manual', 'section', NULL, 'MANUAL'), ('orphan', 'section', 'missing', 'PROJECT');
      INSERT INTO "ApplicationAttempt" (id, userId, jobOpportunityId, channelLabel, currentStageCategory, submittedAgainstJdVersionId, updatedAt) VALUES ('history', 'owner', 'job', 'Unknown', 'INTERVIEW', NULL, CURRENT_TIMESTAMP);
    `);
  } finally { before.close(); }
  fs.cpSync(path.join(repositoryPrisma, "migrations", migrationName), path.join(ctx.root, "migrations", migrationName), { recursive: true });
  deploy(ctx.schema, ctx.dbPath);
  const after = new DatabaseSync(ctx.dbPath);
  try {
    expect(after.prepare('SELECT id, materialTitleSnapshot FROM "ResumeVariantSectionItem" ORDER BY id').all()).toEqual([
      { id: "linked", materialTitleSnapshot: "Observable at migration" },
      { id: "manual", materialTitleSnapshot: null },
      { id: "orphan", materialTitleSnapshot: null },
    ]);
    expect(after.prepare('SELECT submittedAgainstJdVersionId, currentStageCategory, submittedAt FROM "ApplicationAttempt" WHERE id = ?').get("history"))
      .toEqual({ submittedAgainstJdVersionId: null, currentStageCategory: "INTERVIEW", submittedAt: null });
  } finally { after.close(); }
}, 120_000);

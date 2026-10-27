// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261027190000_career_skill_detail_tag_link/migration.sql"), "utf8");
const dir = path.join(process.cwd(), ".tmp", "career-skill-migration", randomUUID());
fs.mkdirSync(dir, { recursive: true });
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows may still hold the test file. */ } });
function fixture(name: string) {
  const file = path.join(dir, name + ".db");
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE CareerMaterialItem (id TEXT PRIMARY KEY);
    CREATE TABLE Tag (id TEXT PRIMARY KEY);
    CREATE TABLE CareerSkillDetail (
      id TEXT PRIMARY KEY, materialItemId TEXT NOT NULL UNIQUE,
      skillName TEXT, proficiency TEXT, structuredData TEXT NOT NULL DEFAULT '{}',
      createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL,
      FOREIGN KEY(materialItemId) REFERENCES CareerMaterialItem(id) ON DELETE CASCADE ON UPDATE CASCADE);
    INSERT INTO CareerMaterialItem VALUES ('material');
    INSERT INTO Tag VALUES ('tag');
    INSERT INTO CareerSkillDetail VALUES ('detail','material','Original','advanced','{"source":"legacy"}','2026-10-01','2026-10-02');`);
  return { db, file };
}

it("preserves all old columns and constraints while adding a null SetNull reference", () => {
  const { db } = fixture("upgrade");
  try {
    const before = db.prepare("SELECT * FROM CareerSkillDetail").get();
    db.exec(sql);
    expect(db.prepare("SELECT * FROM CareerSkillDetail").get()).toEqual({ ...before, tagId: null });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    const indexes = db.prepare("PRAGMA index_list(CareerSkillDetail)").all();
    expect(indexes.some((r) => r.name === "CareerSkillDetail_tagId_idx")).toBe(true);
    expect(() => db.exec("INSERT INTO CareerSkillDetail(id,materialItemId,updatedAt) VALUES ('duplicate','material','2026-10-02')")).toThrow();
    db.exec("UPDATE CareerSkillDetail SET tagId='tag'; DELETE FROM Tag WHERE id='tag';");
    expect(db.prepare("SELECT tagId,skillName FROM CareerSkillDetail").get()).toEqual({ tagId: null, skillName: "Original" });
  } finally { db.close(); }
});

it("rolls back a failure after dropping the old table, including its data and unique constraint", () => {
  const { db, file } = fixture("failed-upgrade");
  const before = db.prepare("SELECT * FROM CareerSkillDetail").get();
  const failed = sql.replace('DROP TABLE "CareerSkillDetail";', 'DROP TABLE "CareerSkillDetail"; SELECT deliberate_migration_failure();');
  expect(() => db.exec(failed)).toThrow();
  db.close(); // An aborted migration connection must leave the prior schema usable.
  const reopened = new DatabaseSync(file);
  try {
    expect(reopened.prepare("SELECT * FROM CareerSkillDetail").get()).toEqual(before);
    expect(reopened.prepare("PRAGMA table_info(CareerSkillDetail)").all().some((r) => r.name === "tagId")).toBe(false);
    expect(() => reopened.exec("INSERT INTO CareerSkillDetail(id,materialItemId,updatedAt) VALUES ('duplicate','material','2026-10-02')")).toThrow();
  } finally { reopened.close(); }
});

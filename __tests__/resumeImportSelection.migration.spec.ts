// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

it("upgrades existing attempts without changing cached results or lifecycle state", () => {
  const db = new DatabaseSync(":memory:");
  const migrations = path.resolve(__dirname, "../prisma/migrations");
  const addition = "20261029010000_resume_import_selection_signature";
  try {
    for (const name of fs.readdirSync(migrations).sort()) {
      if (name !== addition && fs.statSync(path.join(migrations, name)).isDirectory()) {
        db.exec(fs.readFileSync(path.join(migrations, name, "migration.sql"), "utf8"));
      }
    }
    db.exec(`INSERT INTO "User" (id, name, email, password)
      VALUES ('selection-owner', 'Synthetic', 'synthetic@example.com', 'synthetic')`);
    const insert = db.prepare(`INSERT INTO "ResumeImportAttempt"
      (id, userId, state, requestSha, resultJson, updatedAt)
      VALUES (?, 'selection-owner', ?, 'synthetic-sha', ?, CURRENT_TIMESTAMP)`);
    insert.run("confirmed", "CONFIRMED", '{"sections":[],"original":"unchanged"}');
    insert.run("pending", "PENDING", null);
    const before = db.prepare('SELECT * FROM "ResumeImportAttempt" ORDER BY id').all();

    db.exec(fs.readFileSync(path.join(migrations, addition, "migration.sql"), "utf8"));

    const after = db.prepare('SELECT * FROM "ResumeImportAttempt" ORDER BY id').all();
    expect(after).toEqual(before.map((row) => ({ ...row, confirmedSelectionSha: null })));
    expect(db.prepare('PRAGMA table_info("ResumeImportAttempt")').all()).toContainEqual(
      expect.objectContaining({ name: "confirmedSelectionSha", type: "TEXT", notnull: 0 }),
    );
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

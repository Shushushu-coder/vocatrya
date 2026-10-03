import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Apply checked-in SQL only to a verified disposable file. No Prisma CLI. */
export function initializeResumeExportTestDb(url: string) {
  if (!url.startsWith("file:")) throw new Error("Test database must be a file URL");
  const target = path.resolve(url.slice(5));
  const relative = path.relative(os.tmpdir(), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
      !/^(jobsync-backup-|vocatrya-resume-export-)/.test(path.basename(path.dirname(target))) ||
      path.basename(target) !== "test.db" || fs.existsSync(target)) {
    throw new Error("Refusing to initialize a non-disposable database");
  }
  const db = new DatabaseSync(target);
  try {
    const migrations = path.resolve(__dirname, "../../prisma/migrations");
    for (const entry of fs.readdirSync(migrations, { withFileTypes: true }).filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      db.exec(fs.readFileSync(path.join(migrations, entry.name, "migration.sql"), "utf8"));
    }
  } finally { db.close(); }
}

export function makeResumeExportTestContext() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-resume-export-"));
  const url = `file:${path.join(dir, "test.db").replace(/\\/g, "/")}`;
  const uploadsRoot = path.join(dir, "uploads");
  initializeResumeExportTestDb(url);
  return { dir, url, uploadsRoot };
}

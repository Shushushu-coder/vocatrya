import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BACKUP_MANIFEST_VERSION,
  BACKUP_METHOD,
  buildBackupFilename,
  createBackup,
  sanitizeVersionForFilename,
} from "./database-backup.js";

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("backup filename safety", () => {
  it("builds UTC timestamped filenames without Windows-hostile characters", () => {
    const name = buildBackupFilename({ appVersion: "1.1.20", now: new Date("2026-09-20T12:34:56.789Z") });
    expect(name).toBe("pre-migration-1.1.20-20260920-123456.db");
    expect(name).not.toMatch(/[:/\\]/);
  });

  it("sanitizes traversal and hostile version strings", () => {
    expect(sanitizeVersionForFilename("../../evil")).toBe("evil");
    expect(sanitizeVersionForFilename("1.1.20:beta/x")).toBe("1.1.20_beta_x");
    expect(sanitizeVersionForFilename("")).toBe("unknown");
    const name = buildBackupFilename({ appVersion: "..\\..\\evil:1" });
    expect(name).not.toContain("..");
    expect(name).not.toMatch(/[:/\\]/);
    expect(path.basename(path.join("C:\\backups", name))).toBe(name);
  });
});

describe("createBackup failure behavior", () => {
  it("refuses a missing source database", async () => {
    const dir = makeTempDir("voc-bakfail-");
    await expect(
      createBackup({
        databasePath: path.join(dir, "missing.db"),
        backupsDir: path.join(dir, "backups"),
        appVersion: "1.1.20",
        nodeExecutable: process.execPath,
        dbToolPath: "db-tool.cjs",
        databaseUrl: "file:C:/missing.db",
        tmpDir: dir,
        baseEnv: {},
      }),
    ).rejects.toThrow(/missing/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an empty source database", async () => {
    const dir = makeTempDir("voc-bakfail-");
    const db = path.join(dir, "vocatrya.db");
    fs.writeFileSync(db, Buffer.alloc(0));
    await expect(
      createBackup({
        databasePath: db,
        backupsDir: path.join(dir, "backups"),
        appVersion: "1.1.20",
        nodeExecutable: process.execPath,
        dbToolPath: "db-tool.cjs",
        databaseUrl: "file:C:/empty.db",
        tmpDir: dir,
        baseEnv: {},
      }),
    ).rejects.toThrow(/empty/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("leaves no valid-looking backup behind when the helper cannot start", async () => {
    const dir = makeTempDir("voc-bakfail-");
    const db = path.join(dir, "vocatrya.db");
    fs.writeFileSync(db, Buffer.from("source-bytes"));
    const backupsDir = path.join(dir, "backups");
    await expect(
      createBackup({
        databasePath: db,
        backupsDir,
        appVersion: "1.1.20",
        nodeExecutable: path.join(dir, "no-such-node.exe"),
        dbToolPath: path.join(dir, "db-tool.cjs"),
        databaseUrl: "file:C:/src.db",
        tmpDir: dir,
        baseEnv: {},
      }),
    ).rejects.toThrow(/backup failed/);
    expect(fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir) : []).toEqual([]);
    expect(fs.readFileSync(db, "utf8")).toBe("source-bytes");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("never overwrites an existing backup file", async () => {
    const dir = makeTempDir("voc-bakfail-");
    const db = path.join(dir, "vocatrya.db");
    fs.writeFileSync(db, Buffer.from("source-bytes"));
    const backupsDir = path.join(dir, "backups");
    fs.mkdirSync(backupsDir, { recursive: true });
    const fixed = new Date("2026-09-20T12:34:56.000Z");
    const existing = path.join(backupsDir, buildBackupFilename({ appVersion: "1.1.20", now: fixed }));
    fs.writeFileSync(existing, Buffer.from("previous-backup"));
    await expect(
      createBackup({
        databasePath: db,
        backupsDir,
        appVersion: "1.1.20",
        nodeExecutable: process.execPath,
        dbToolPath: "db-tool.cjs",
        databaseUrl: "file:C:/src.db",
        tmpDir: dir,
        baseEnv: {},
        now: fixed,
      }),
    ).rejects.toThrow(/already exists/);
    expect(fs.readFileSync(existing, "utf8")).toBe("previous-backup");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("backup manifest contract", () => {
  it("exposes the documented manifest shape", () => {
    expect(BACKUP_MANIFEST_VERSION).toBe(1);
    expect(BACKUP_METHOD).toBe("vacuum-into");
  });
});

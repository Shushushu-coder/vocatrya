import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedStore } from "../src/store";
import { schemaVersion } from "../src/schema";

const cleanup: (() => void)[] = [];
afterEach(() => { while (cleanup.length) cleanup.pop()!(); });
function directory() { const dir = mkdtempSync(join(tmpdir(), "m3-migration-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }

describe("Hosted schema migration", () => {
  it("creates the latest schema on a fresh database", () => {
    const dir = directory();
    const store = new HostedStore(join(dir, "hosted.db"));
    const db = new DatabaseSync(join(dir, "hosted.db"));
    expect(schemaVersion(db)).toBe(2);
    for (const table of ["HostedUser", "HostedSession", "ManagedAiBinding", "Subscription", "ManagedAiQuotaPeriod", "ManagedAiUsage"]) {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeTruthy();
    }
    db.close(); store.close();
  });
  it("upgrades an existing M2 database in place, preserving data", () => {
    const dir = directory();
    const file = join(dir, "hosted.db");
    const m2 = new DatabaseSync(file);
    m2.exec(`CREATE TABLE HostedUser(id TEXT PRIMARY KEY);
      CREATE TABLE HostedSession(tokenHash TEXT PRIMARY KEY, hostedUserId TEXT NOT NULL REFERENCES HostedUser(id), expiresAt INTEGER NOT NULL);
      CREATE TABLE ManagedAiBinding(id TEXT PRIMARY KEY, hostedUserId TEXT NOT NULL REFERENCES HostedUser(id), business TEXT NOT NULL, resourceKey TEXT NOT NULL, modelKey TEXT NOT NULL, snapshot TEXT NOT NULL, UNIQUE(hostedUserId,business,resourceKey));
      CREATE TRIGGER ImmutableManagedBinding BEFORE UPDATE ON ManagedAiBinding BEGIN SELECT RAISE(ABORT,'immutable binding'); END;`);
    m2.prepare("INSERT INTO HostedUser(id) VALUES (?)").run("hosted-legacy");
    m2.prepare("INSERT INTO HostedSession VALUES (?,?,?)").run("hash", "hosted-legacy", Date.now() + 100000);
    m2.close();
    const store = new HostedStore(file);
    const db = new DatabaseSync(file);
    expect(schemaVersion(db)).toBe(2);
    expect(db.prepare("SELECT hostedUserId FROM HostedSession WHERE tokenHash=?").get("hash")).toEqual({ hostedUserId: "hosted-legacy" });
    db.close(); store.close();
  });
  it("preserves data across restarts", () => {
    const dir = directory();
    const file = join(dir, "hosted.db");
    const first = new HostedStore(file);
    const token = first.issueSession("hosted-a", Date.now() + 60_000);
    first.setSubscription("hosted-a", { planKey: "starter", status: "ACTIVE", periodStart: Date.now() - 1000, periodEnd: Date.now() + 60_000 });
    first.close();
    const second = new HostedStore(file);
    expect(second.subscription("hosted-a")?.planKey).toBe("starter");
    expect(second.authenticate(`Bearer ${token}`)).toBe("hosted-a");
    second.close();
  });
  it("reapplying migrations is idempotent", () => {
    const dir = directory();
    const file = join(dir, "hosted.db");
    const store = new HostedStore(file);
    store.close();
    const reopened = new HostedStore(file);
    const raw = new DatabaseSync(file);
    expect(schemaVersion(raw)).toBe(2);
    raw.close();
    reopened.close();
  });
});

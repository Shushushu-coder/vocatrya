// @vitest-environment node
import { afterAll, beforeAll, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import path from "node:path";
import {
  authenticateConnection, createPairingRequest, exchangePairingCode,
  revokeConnection,
} from "@/lib/extensions/autoApply/connect";

let db: PrismaClient;
let url: string;
beforeAll(async () => {
  const root = path.resolve(".tmp/auto-apply-connect");
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(path.join(root, "sqlite-"));
  const filename = path.join(directory, "test.db");
  // Replay the pre-change schema, retain a synthetic user, then upgrade.
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import { DatabaseSync } from 'node:sqlite';
    import fs from 'node:fs';
    import path from 'node:path';
    const db = new DatabaseSync(process.argv[1]);
    const root = path.resolve('prisma/migrations');
    const migrations = fs.readdirSync(root).filter(n => fs.existsSync(path.join(root,n,'migration.sql'))).sort();
    const latest = migrations.pop();
    for (const name of migrations) db.exec(fs.readFileSync(path.join(root,name,'migration.sql'),'utf8'));
    db.prepare('INSERT INTO User (id,name,email,password) VALUES (?,?,?,?)').run('synthetic-user','Synthetic','synthetic@example.invalid','synthetic-unused');
    db.exec(fs.readFileSync(path.join(root,latest,'migration.sql'),'utf8'));
    if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('foreign keys');
    db.close();
  `, filename], { stdio: "pipe" });
  url = `file:${filename.replaceAll("\\", "/")}`;
  db = new PrismaClient({ datasourceUrl: url });
}, 30000);
afterAll(async () => { await db?.$disconnect(); });

it("preserves old data and enforces the ceiling atomically, including rollback and reopen", async () => {
  expect((await db.user.findUniqueOrThrow({ where: { id: "synthetic-user" } })).name).toBe("Synthetic");
  async function code() {
    const pairing = await createPairingRequest("synthetic-user", "http://127.0.0.1:3737", ["basic"], { db });
    return new URL(pairing.pairingString).searchParams.get("code")!;
  }
  for (let index = 0; index < 9; index++) await exchangePairingCode(await code(), {}, { db });
  const codes = [await code(), await code()];
  const results = await Promise.allSettled(codes.map(value => exchangePairingCode(value, {}, { db })));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const rejectedIndex = results.findIndex(result => result.status === "rejected");
  expect(results[rejectedIndex]).toMatchObject({ reason: { code: "CONNECTION_LIMIT" } });
  expect(await db.autoApplyExtensionConnection.count({ where: { revokedAt: null } })).toBe(10);
  const winner = results.find(result => result.status === "fulfilled")!;
  if (winner.status !== "fulfilled") throw new Error("missing winner");
  await revokeConnection("synthetic-user", winner.value.connectionId, { db });
  // The rejected transaction must not have consumed its pairing code.
  const retry = await exchangePairingCode(codes[rejectedIndex], {}, { db });
  await db.$disconnect();
  db = new PrismaClient({ datasourceUrl: url });
  expect((await authenticateConnection(retry.accessToken, { db })).userId).toBe("synthetic-user");
  await expect(authenticateConnection(winner.value.accessToken, { db })).rejects.toMatchObject({ code: "CONNECTION_REVOKED" });
  await expect(exchangePairingCode(codes[rejectedIndex], {}, { db })).rejects.toMatchObject({ code: "PAIRING_CONSUMED" });
}, 30000);

// @vitest-environment node
import { PrismaClient } from "@prisma/client";
import JSZip from "jszip";
import { buildBackupZip, collectBackupData } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { seedAccount } from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const ctx = helpers.makeTestDbUrl();
  helpers.pushSchema(ctx.url);
  return ctx;
});
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
afterAll(async () => {
  await db.$disconnect();
});

it("excludes Feishu credentials from every ZIP entry and restores user data without a connection", async () => {
  const source = await seedAccount(db, "feishu-backup-source@example.com");
  const target = await seedAccount(db, "feishu-backup-target@example.com");
  const markers = ["synthetic-feishu-app-identity", "synthetic-feishu-ciphertext", "synthetic-feishu-iv"];
  await db.feishuConnection.create({
    data: {
      userId: source,
      status: "CONNECTED",
      appId: markers[0],
      encryptedCredential: markers[1],
      credentialIv: markers[2],
      availableCapabilities: '["docx.read"]',
    },
  });
  await db.task.create({ data: { userId: source, title: "Retained ordinary task" } });
  const data = await collectBackupData(source);
  expect(data).not.toHaveProperty("FeishuConnection");
  const { buffer } = await buildBackupZip(source, "feishu-backup-source@example.com");
  const zip = await JSZip.loadAsync(buffer);
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const contents = await entry.async("string");
    for (const marker of markers) expect(contents).not.toContain(marker);
  }
  const restored = await importBackup(buffer, target, "feishu-backup-target@example.com", true);
  expect(restored.counts.Task).toBe(1);
  expect(await db.feishuConnection.count({ where: { userId: target } })).toBe(0);
  expect(await db.task.findFirst({ where: { userId: target } })).toMatchObject({ title: "Retained ordinary task" });
  expect(await db.feishuConnection.count({ where: { userId: source } })).toBe(1);
});

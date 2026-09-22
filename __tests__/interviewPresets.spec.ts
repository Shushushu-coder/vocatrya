// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { makeTestDbUrl, resetDisposableDb, seedAccount } from "./helpers/backupTestDb";
import { ensureCanonicalPreset } from "@/lib/interview/presets/install";
import { SAMPLE_PRESET } from "@/lib/interview/presets/sample";
import { QUESTION_BANK_VERSION_CONFLICT } from "@/lib/interview/presets/install";

const REPO_ROOT = path.resolve(__dirname, "..");

function deployMigrations(url: string): void {
  const prismaCli = path.join(REPO_ROOT, "node_modules", "prisma", "build", "index.js");
  const result = spawnSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    timeout: 240_000,
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "migrate failed");
  }
}

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;

beforeAll(() => deployMigrations(ctx.url), 300_000);
afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});
beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `preset-${Date.now()}@example.com`);
}, 60_000);

describe("preset installer", () => {
  it("creates, reuses, and rejects metadata conflicts without wiping user questions", async () => {
    const first = await ensureCanonicalPreset(prisma, userId);
    expect(first.created).toBe(true);
    const owned = await prisma.question.findUnique({
      where: { id: first.questionIds[0] },
    });
    expect(owned?.createdBy).toBe(userId);
    expect(owned?.createdVia).toBe(`PRESET:${SAMPLE_PRESET.bankKey}`);

    const userQuestion = await prisma.question.create({
      data: { question: "My private question", createdBy: userId },
    });
    const second = await ensureCanonicalPreset(prisma, userId);
    expect(second.created).toBe(false);
    expect(second.bankId).toBe(first.bankId);
    const stillThere = await prisma.question.findUnique({ where: { id: userQuestion.id } });
    expect(stillThere?.question).toBe("My private question");

    await prisma.questionBank.update({
      where: { id: first.bankId },
      data: { title: "tampered" },
    });
    const conflict = await ensureCanonicalPreset(prisma, userId).catch((error) => error);
    expect(conflict.code).toBe(QUESTION_BANK_VERSION_CONFLICT);
  });
});

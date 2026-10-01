// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONTACT_ROLES, JOB_SOURCES, JOB_STATUSES } from "../src/lib/constants";
import { setupTestUser } from "../e2e/support/setupTestUser";
import { E2E_TEST_USER } from "../e2e/support/testUser";
import { resolveE2EDatabase } from "../e2e/support/database";
import { AiProvider, OllamaModel } from "../src/models/ai.model";

describe("E2E test user setup (disposable migrated SQLite)", () => {
  let directory: string;
  let prisma: PrismaClient;
  let run = 0;

  beforeAll(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "vocatrya-e2e-setup-"));
    // Prisma's Windows schema engine requires the SQLite file to exist.
    writeFileSync(path.join(directory, "template.db"), "");
    execFileSync(process.execPath, [
      path.resolve("node_modules/prisma/build/index.js"), "migrate", "deploy",
      "--schema", path.resolve("prisma/schema.prisma"),
    ], {
      env: { ...process.env, DATABASE_URL: `file:${path.join(directory, "template.db").replace(/\\/g, "/")}` },
      stdio: "pipe",
    });
  }, 60_000);

  beforeEach(() => {
    const file = path.join(directory, `${++run}.db`);
    copyFileSync(path.join(directory, "template.db"), file);
    prisma = new PrismaClient({ datasourceUrl: `file:${file.replace(/\\/g, "/")}` });
  });
  afterEach(async () => { await prisma?.$disconnect(); });
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });

  async function snapshot() {
    return {
      users: await prisma.user.findMany({ orderBy: { id: "asc" } }),
      sources: await prisma.jobSource.findMany({ orderBy: { id: "asc" } }),
      roles: await prisma.contactRole.findMany({ orderBy: { id: "asc" } }),
      statuses: await prisma.jobStatus.findMany({ orderBy: { id: "asc" } }),
      settings: await prisma.userSettings.findMany({ orderBy: { id: "asc" } }),
    };
  }

  it("creates a usable bcrypt account and the signup baseline", async () => {
    const { userId } = await setupTestUser(prisma);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.email).toBe(E2E_TEST_USER.email);
    expect(user.password).not.toBe(E2E_TEST_USER.password);
    expect(await bcrypt.compare(E2E_TEST_USER.password, user.password)).toBe(true);
    expect(bcrypt.getRounds(user.password)).toBe(10);
    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId } });
    expect(JSON.parse(settings.settings).ai).toEqual({ provider: AiProvider.OLLAMA, model: OllamaModel.LLAMA3_2 });
    const state = await snapshot();
    expect(state.sources.map(({ label, value }) => ({ label, value }))).toEqual(expect.arrayContaining([...JOB_SOURCES]));
    expect(state.roles.map(({ label, value }) => ({ label, value }))).toEqual(expect.arrayContaining([...CONTACT_ROLES]));
    expect(state.statuses.map(({ label, value }) => ({ label, value }))).toEqual(expect.arrayContaining([...JOB_STATUSES]));
  });

  it("reruns without changing hashes, IDs, or row counts", async () => {
    await setupTestUser(prisma);
    const initial = await snapshot();
    await setupTestUser(prisma);
    expect(await snapshot()).toEqual(initial);
  });

  it("repairs missing baseline records for an existing fixture", async () => {
    const { userId } = await setupTestUser(prisma);
    await prisma.jobSource.delete({ where: { value_createdBy: { value: "indeed", createdBy: userId } } });
    await prisma.contactRole.delete({ where: { value_createdBy: { value: CONTACT_ROLES[0].value, createdBy: userId } } });
    await prisma.jobStatus.delete({ where: { value: JOB_STATUSES[0].value } });
    await prisma.userSettings.delete({ where: { userId } });
    await setupTestUser(prisma);
    expect(await prisma.jobSource.count({ where: { createdBy: userId } })).toBe(JOB_SOURCES.length);
    expect(await prisma.contactRole.count({ where: { createdBy: userId } })).toBe(CONTACT_ROLES.length);
    expect(await prisma.jobStatus.count()).toBe(JOB_STATUSES.length);
    expect(await prisma.userSettings.count({ where: { userId } })).toBe(1);
    const repaired = await snapshot();
    await setupTestUser(prisma);
    expect(await snapshot()).toEqual(repaired);
  });

  it("leaves unrelated users and their baseline data unchanged", async () => {
    const unrelated = await prisma.user.create({ data: {
      name: "Unrelated user", email: "unrelated@example.test", password: await bcrypt.hash("unrelated-password", 10),
      JobSource: { create: { label: "Personal source", value: "personal" } },
      ContactRole: { create: { label: "Personal role", value: "personal" } },
    }, include: { JobSource: true, ContactRole: true } });
    await prisma.jobStatus.create({ data: { label: "Custom New", value: "new" } });
    await setupTestUser(prisma);
    await setupTestUser(prisma);
    expect(await prisma.user.findUnique({ where: { id: unrelated.id }, include: { JobSource: true, ContactRole: true } })).toEqual(unrelated);
    expect(await prisma.jobStatus.findUnique({ where: { value: "new" } })).toMatchObject({ label: "Custom New" });
  });

  it("repairs the fixture password without replacing the user", async () => {
    const user = await prisma.user.create({ data: { ...E2E_TEST_USER, password: await bcrypt.hash("old-password", 10) } });
    expect(await setupTestUser(prisma)).toEqual({ userId: user.id });
    const repaired = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await bcrypt.compare(E2E_TEST_USER.password, repaired.password)).toBe(true);
  });

  it("repairs fixture AI configuration while preserving other preferences", async () => {
    const { userId } = await setupTestUser(prisma);
    await prisma.userSettings.update({ where: { userId }, data: { settings: JSON.stringify({
      ai: { provider: "openai", model: "old-model", interview: { provider: "openai", model: "interview-model" } },
      display: { theme: "dark" },
    }) } });
    await setupTestUser(prisma);
    const settings = await prisma.userSettings.findUniqueOrThrow({ where: { userId } });
    expect(JSON.parse(settings.settings)).toEqual({
      ai: { provider: AiProvider.OLLAMA, model: OllamaModel.LLAMA3_2, interview: { provider: "openai", model: "interview-model" } },
      display: { theme: "dark" },
    });
    const repaired = await snapshot();
    await setupTestUser(prisma);
    expect(await snapshot()).toEqual(repaired);
  });

  it("resolves relative URLs against the schema and rejects nonlocal URLs", () => {
    const absolute = resolveE2EDatabase(`file:${path.join(directory, "template.db")}`);
    expect(resolveE2EDatabase("file:../../template.db", path.join(directory, "project"))).toEqual(absolute);
    expect(() => resolveE2EDatabase("postgresql://user:secret@host/db")).toThrow("local, migrated SQLite");
    expect(() => resolveE2EDatabase("file::memory:")).toThrow("local, migrated SQLite");
    expect(() => resolveE2EDatabase("file:")).toThrow("must name");
    expect(() => resolveE2EDatabase("file:missing.db", directory)).toThrow();
  });
});

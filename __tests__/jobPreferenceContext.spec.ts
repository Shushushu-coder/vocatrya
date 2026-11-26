// @vitest-environment node
/**
 * M2.2 dual-track job-search preference context: the shared read-only
 * helper behind match_job fast screening, the deep-match task and
 * today_plan suggestions. Covers master-switch control, the two-category
 * scope, source labeling, business-table precedence, cross-user isolation
 * and the guarantee that nothing is ever written back.
 */
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import { loadJobPreferenceContext } from "@/lib/career/jobPreferenceContext.server";
import {
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `pref-${Date.now()}@example.com`);
  otherUserId = await seedAccount(prisma, `pref-o-${Date.now()}@example.com`);
});

async function putMemory(
  category: string,
  key: string,
  content: string,
  owner = userId,
) {
  return prisma.userMemoryEntry.create({
    data: { userId: owner, category, key, content },
  });
}

async function setMemoryEnabled(owner: string, enabled: boolean) {
  const settings = JSON.stringify({
    settings: { general: { agent: { longTermMemoryEnabled: enabled } } },
  });
  await prisma.userSettings.upsert({
    where: { userId: owner },
    create: { userId: owner, settings },
    update: { settings },
  });
}

describe("loadJobPreferenceContext (M2.2 dual-track)", () => {
  it("renders business fields as authoritative and memory notes under the 对话沉淀偏好 label", async () => {
    await prisma.jobSearchPreference.create({
      data: { userId, preferredCities: "上海", targetRoles: "后端工程师" },
    });
    await putMemory("career_goal", "target_cities", "杭州");
    await putMemory("industry_preference", "avoid", "外包");
    // Out-of-scope categories never join the supplement.
    await putMemory("collaboration_habit", "style", "简短直接");

    const context = await loadJobPreferenceContext(prisma, userId);
    expect(context.hasBusinessFields).toBe(true);
    expect(context.memoryEnabled).toBe(true);
    expect(context.memoryDegraded).toBe(false);
    expect(context.memoryNotes.map((note) => note.category).sort()).toEqual([
      "career_goal",
      "industry_preference",
    ]);
    expect(context.text).toContain("上海");
    expect(context.text).toContain("杭州");
    expect(context.text).toContain("外包");
    expect(context.text).toContain("对话沉淀偏好");
    expect(context.text).toContain("authoritative");
    expect(context.text).not.toContain("简短直接");

    // The canonical snapshot keeps the legacy business shape and adds the
    // notes block — consumers hash this exact structure.
    expect(context.snapshot).toMatchObject({ preferredCities: "上海" });
    const notes = (
      context.snapshot as {
        memoryNotes: { category: string; key: string }[];
      }
    ).memoryNotes;
    expect(notes).toHaveLength(2);
  });

  it("master switch off → structured fields only, memory never joins", async () => {
    await setMemoryEnabled(userId, false);
    await prisma.jobSearchPreference.create({
      data: { userId, preferredCities: "上海" },
    });
    await putMemory("career_goal", "cities", "杭州");

    const context = await loadJobPreferenceContext(prisma, userId);
    expect(context.memoryEnabled).toBe(false);
    expect(context.memoryNotes).toEqual([]);
    expect(context.text).toContain("上海");
    expect(context.text).not.toContain("杭州");
    expect(context.text).not.toContain("对话沉淀偏好");
    expect(context.snapshot).not.toHaveProperty("memoryNotes");
  });

  it("empty everything → text null and the legacy empty snapshot", async () => {
    const context = await loadJobPreferenceContext(prisma, userId);
    expect(context.text).toBeNull();
    expect(context.snapshot).toEqual({});
    expect(context.hasBusinessFields).toBe(false);
    expect(context.memoryNotes).toEqual([]);
  });

  it("memory-only → advisory label, never an authoritative block", async () => {
    await putMemory("career_goal", "cities", "杭州");

    const context = await loadJobPreferenceContext(prisma, userId);
    expect(context.hasBusinessFields).toBe(false);
    expect(context.text).toContain("对话沉淀偏好");
    expect(context.text).toContain("advisory");
    expect(context.text).toContain("杭州");
    // No business fields — nothing reads as an authoritative record.
    expect(context.text).not.toContain("authoritative business records");
  });

  it("keeps every read strictly user-scoped and never writes either table", async () => {
    await prisma.jobSearchPreference.create({
      data: { userId: otherUserId, preferredCities: "北京" },
    });
    await putMemory("career_goal", "cities", "深圳", otherUserId);

    const preferencesBefore = await prisma.jobSearchPreference.findMany();
    const context = await loadJobPreferenceContext(prisma, userId);
    expect(context.hasBusinessFields).toBe(false);
    expect(context.memoryNotes).toEqual([]);
    expect(context.text).toBeNull();

    // Zero writes: the business table and the memory store are untouched.
    const preferencesAfter = await prisma.jobSearchPreference.findMany();
    expect(preferencesAfter).toEqual(preferencesBefore);
    expect(
      await prisma.userMemoryEntry.count({ where: { userId: otherUserId } }),
    ).toBe(1);
  });

  it("a failed memory read degrades to structured-only instead of breaking the consumer", async () => {
    await prisma.jobSearchPreference.create({
      data: { userId, preferredCities: "上海" },
    });
    const failing = prisma.$extends({
      query: {
        userMemoryEntry: {
          async findMany() {
            throw new Error("memory store unavailable");
          },
        },
      },
    });

    const context = await loadJobPreferenceContext(
      failing as unknown as PrismaClient,
      userId,
    );
    expect(context.memoryEnabled).toBe(true);
    expect(context.memoryDegraded).toBe(true);
    expect(context.memoryNotes).toEqual([]);
    expect(context.text).toContain("上海");
    expect(context.text).not.toContain("对话沉淀偏好");
  });
});

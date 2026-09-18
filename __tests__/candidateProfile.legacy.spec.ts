// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { makeTestDbUrl, pushSchema, seedAccount } from "./helpers/backupTestDb";
import {
  LEGACY,
  PHASE3_MIGRATION_VERSION,
  TARGET,
} from "@/lib/legacy-migration/identities";
import { runLegacyMigration } from "@/lib/legacy-migration/migrator";

const REPO_ROOT = path.resolve(__dirname, "..");

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const dbPath = path.join(ctx.dir, "test.db");

function migrateOpts() {
  return {
    dbPath,
    repoRoot: REPO_ROOT,
    mode: "migrate" as const,
    confirmWritable: true,
    allowDisposableCopy: true,
  };
}

async function seedAgreeingContact() {
  const userId = await seedAccount(prisma, "candidate-legacy@example.com");
  const profile = await prisma.profile.create({ data: { userId } });
  const resume = await prisma.resume.create({
    data: { profileId: profile.id, title: "Primary" },
  });
  await prisma.contactInfo.create({
    data: {
      resumeId: resume.id,
      firstName: "Fixture",
      lastName: "Name",
      headline: "Engineer",
      email: "fixture-legacy@example.com",
      phone: "010-0000-0000",
      address: "Fixture Address",
    },
  });
  return userId;
}

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp dirs is a known flake.
  }
});

describe("CandidateProfile legacy migrator compatibility", () => {
  it("creates, respects old mappings, and links existing profiles without duplicating", async () => {
    const userId = await seedAgreeingContact();
    const first = await runLegacyMigration(migrateOpts());
    expect(first.phaseResult).toBe("PASS");
    expect(first.created.contactProfiles).toBe(1);

    const created = await prisma.candidateProfile.findUniqueOrThrow({
      where: { userId },
    });
    expect(created.email).toBe("fixture-legacy@example.com");
    const maps = await prisma.legacyMigrationMap.findMany({
      where: {
        userId,
        legacyEntityType: LEGACY.USER_CONTACT_INFO,
      },
    });
    expect(maps).toHaveLength(1);
    expect(maps[0].targetEntityType).toBe(TARGET.CANDIDATE_PROFILE);
    expect(maps[0].targetEntityId).toBe(created.id);

    const second = await runLegacyMigration(migrateOpts());
    expect(second.created.contactProfiles).toBe(0);
    expect(await prisma.candidateProfile.count()).toBe(1);

    await prisma.legacyMigrationMap.updateMany({
      where: {
        userId,
        legacyEntityType: LEGACY.USER_CONTACT_INFO,
        migrationVersion: PHASE3_MIGRATION_VERSION,
      },
      data: { targetEntityType: "ResumeContactProfile" },
    });
    const aliasRerun = await runLegacyMigration(migrateOpts());
    expect(aliasRerun.created.contactProfiles).toBe(0);
    expect(await prisma.candidateProfile.count()).toBe(1);

    await prisma.legacyMigrationMap.deleteMany({
      where: {
        userId,
        legacyEntityType: LEGACY.USER_CONTACT_INFO,
      },
    });
    const linked = await runLegacyMigration(migrateOpts());
    expect(linked.created.contactProfiles).toBe(0);
    expect(await prisma.candidateProfile.count()).toBe(1);
    const relinked = await prisma.legacyMigrationMap.findMany({
      where: {
        userId,
        legacyEntityType: LEGACY.USER_CONTACT_INFO,
      },
    });
    expect(relinked).toHaveLength(1);
    expect(relinked[0].targetEntityType).toBe(TARGET.CANDIDATE_PROFILE);
    expect(relinked[0].targetEntityId).toBe(created.id);
  }, 120_000);
});

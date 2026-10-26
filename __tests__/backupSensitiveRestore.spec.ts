// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import JSZip from "jszip";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { writeSnapshot } from "@/lib/backup/snapshot";
import { BackupError } from "@/lib/backup/schema";
import { emptyStandardBackupData } from "@/lib/backup/compat";
import { BackupDataSchema } from "@/lib/backup/schema";
import { TARGET } from "@/lib/legacy-migration/identities";
import { log } from "@/lib/telemetry";
import {
  makeTestDbUrl,
  pushSchema,
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

vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;
const EMAIL = "sensitive-restore@example.com";

let userId: string;
let uploadsDir: string;

async function zipOf(manifest: unknown, data: unknown): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest));
  zip.file("data.json", JSON.stringify(data));
  return zip.generateAsync({ type: "nodebuffer" });
}

async function seedSensitive(label: string, familyCount: number) {
  const info = await prisma.candidateSensitiveInfo.create({
    data: {
      userId,
      idNumber: `${label}-id`,
      emergencyContactName: `${label}-name`,
      emergencyContactPhone: `${label}-phone`,
    },
  });
  for (let i = 0; i < familyCount; i += 1) {
    await prisma.candidateFamilyMember.create({
      data: {
        sensitiveInfoId: info.id,
        name: `${label}-family-${i}`,
        phone: `${label}-fam-phone-${i}`,
        sortOrder: (i + 1) * 10,
      },
    });
  }
  return info;
}

beforeAll(async () => {
  uploadsDir = path.join(ctx.dir, "uploads");
  fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
}, 120_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp dirs is a known flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, EMAIL);
});

describe("sensitive restore policy", () => {
  it("A: a standard backup leaves existing sensitive rows in place", async () => {
    await seedSensitive("keep", 2);
    const { buffer } = await buildBackupZip(userId, EMAIL);
    const zip = await JSZip.loadAsync(buffer);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    expect(manifest.containsSensitiveData).toBe(false);
    expect(data).not.toHaveProperty("CandidateSensitiveInfo");
    expect(data).not.toHaveProperty("CandidateFamilyMember");

    await importBackup(buffer, userId, EMAIL, true);
    expect(await prisma.candidateSensitiveInfo.count()).toBe(1);
    expect(await prisma.candidateFamilyMember.count()).toBe(2);
  }, 60_000);

  it("B: a sensitive backup replaces existing sensitive rows", async () => {
    await seedSensitive("old", 2);
    const { buffer } = await buildBackupZip(userId, EMAIL, {
      includeSensitiveData: true,
    });
    await prisma.candidateFamilyMember.deleteMany();
    await prisma.candidateSensitiveInfo.deleteMany();
    await seedSensitive("new", 1);

    await importBackup(buffer, userId, EMAIL, true);
    const remaining = await prisma.candidateSensitiveInfo.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].idNumber).toBe("old-id");
    expect(await prisma.candidateFamilyMember.count()).toBe(2);
  }, 60_000);

  it("the pre-import snapshot carries sensitive rows so rollback undoes a sensitive import", async () => {
    await seedSensitive("keep", 1);
    const snapPath = await writeSnapshot(userId, EMAIL);
    const bytes = await fs.promises.readFile(snapPath);
    const zip = await JSZip.loadAsync(bytes);
    const manifest = JSON.parse(await zip.file("manifest.json")!.async("string"));
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    expect(manifest.containsSensitiveData).toBe(true);
    expect(data.CandidateSensitiveInfo).toHaveLength(1);

    // A sensitive import wipes and replaces these rows; the snapshot is what
    // makes that undoable.
    await prisma.candidateFamilyMember.deleteMany();
    await prisma.candidateSensitiveInfo.deleteMany();
    await seedSensitive("imported", 1);

    await importBackup(bytes, userId, EMAIL, true);
    const info = await prisma.candidateSensitiveInfo.findFirstOrThrow();
    expect(info.idNumber).toBe("keep-id");
    expect(await prisma.candidateFamilyMember.count()).toBe(1);
  }, 60_000);

  it("C: a sensitive backup with empty arrays clears current sensitive rows", async () => {
    await seedSensitive("clear", 2);
    const data = BackupDataSchema.parse({});
    const buffer = await zipOf(
      {
        formatVersion: 3,
        appVersion: "1.1.20",
        exportedAt: "2026-01-01T00:00:00.000Z",
        sourceEmail: EMAIL,
        counts: { CandidateSensitiveInfo: 0, CandidateFamilyMember: 0 },
        containsSensitiveData: true,
      },
      data,
    );
    await importBackup(buffer, userId, EMAIL, true);
    expect(await prisma.candidateSensitiveInfo.count()).toBe(0);
    expect(await prisma.candidateFamilyMember.count()).toBe(0);
  }, 60_000);

  it("D: fail closed when a standard backup payload includes sensitive keys", async () => {
    await seedSensitive("keep", 1);
    const data = {
      ...emptyStandardBackupData(),
      CandidateSensitiveInfo: [],
    };
    const buffer = await zipOf(
      {
        formatVersion: 3,
        appVersion: "1.1.20",
        exportedAt: "2026-01-01T00:00:00.000Z",
        sourceEmail: EMAIL,
        counts: {},
        containsSensitiveData: false,
      },
      data,
    );
    await expect(importBackup(buffer, userId, EMAIL, true)).rejects.toBeInstanceOf(
      BackupError,
    );
    expect(await prisma.candidateSensitiveInfo.count()).toBe(1);
  }, 60_000);

  it("E: manifest true with missing sensitive groups clears current rows", async () => {
    await seedSensitive("missing-groups", 2);
    const buffer = await zipOf(
      {
        formatVersion: 3,
        appVersion: "1.1.20",
        exportedAt: "2026-01-01T00:00:00.000Z",
        sourceEmail: EMAIL,
        counts: {},
        containsSensitiveData: true,
      },
      emptyStandardBackupData(),
    );
    await importBackup(buffer, userId, EMAIL, true);
    expect(await prisma.candidateSensitiveInfo.count()).toBe(0);
    expect(await prisma.candidateFamilyMember.count()).toBe(0);
  }, 60_000);

  it("does not log sensitive sentinels during export", async () => {
    const info = await prisma.candidateSensitiveInfo.create({
      data: {
        userId,
        idNumber: "SENSITIVE_ID_SENTINEL_123",
        emergencyContactName: "SENSITIVE_NAME_SENTINEL",
        emergencyContactPhone: "SENSITIVE_PHONE_SENTINEL_456",
      },
    });
    await prisma.candidateFamilyMember.create({
      data: {
        sensitiveInfoId: info.id,
        name: "SENSITIVE_NAME_SENTINEL",
        phone: "SENSITIVE_PHONE_SENTINEL_456",
        sortOrder: 10,
      },
    });
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(log, "error").mockImplementation(() => undefined);
    try {
      await buildBackupZip(userId, EMAIL, { includeSensitiveData: true });
      const captured = JSON.stringify([
        infoSpy.mock.calls,
        warnSpy.mock.calls,
        errorSpy.mock.calls,
      ]);
      expect(captured).not.toContain("SENSITIVE_ID_SENTINEL_123");
      expect(captured).not.toContain("SENSITIVE_PHONE_SENTINEL_456");
      expect(captured).not.toContain("SENSITIVE_NAME_SENTINEL");
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  }, 60_000);

  it("restores a v1 ResumeContactProfile backup as CandidateProfile", async () => {
    const buffer = await zipOf(
      {
        formatVersion: 1,
        appVersion: "1.1.16",
        exportedAt: "2026-01-01T00:00:00.000Z",
        sourceEmail: EMAIL,
        counts: { ResumeContactProfile: 1 },
      },
      {
        ResumeContactProfile: [
          {
            id: "v1-profile-1",
            fullName: "Fixture V1 Name",
            headline: null,
            email: "fixture-v1@example.com",
            phone: null,
            address: null,
            linksData: null,
            extraData: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    );
    await importBackup(buffer, userId, EMAIL, true);
    const profiles = await prisma.candidateProfile.findMany();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].fullName).toBe("Fixture V1 Name");
    expect(profiles[0].email).toBe("fixture-v1@example.com");
  }, 60_000);

  it("restores a v2 ResumeContactProfile backup as CandidateProfile", async () => {
    const buffer = await zipOf(
      {
        formatVersion: 2,
        appVersion: "1.1.16",
        exportedAt: "2026-01-01T00:00:00.000Z",
        sourceEmail: EMAIL,
        counts: { ResumeContactProfile: 1 },
      },
      {
        ResumeContactProfile: [
          {
            id: "legacy-profile-1",
            fullName: "Fixture Full Name",
            headline: "Fixture Headline",
            email: "fixture-profile@example.com",
            phone: "010-0000-0000",
            address: "Fixture Address",
            linksData: null,
            extraData: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        LegacyMigrationMap: [
          {
            id: "map-1",
            legacyEntityType: "UserContactInfo",
            legacyEntityId: "source-user",
            targetEntityType: "ResumeContactProfile",
            targetEntityId: "legacy-profile-1",
            migrationVersion: "vocatrya-ab-phase3-legacy-backfill-v1",
            mappingReason: "fixture",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    );
    await importBackup(buffer, userId, EMAIL, true);
    const profiles = await prisma.candidateProfile.findMany();
    expect(profiles).toHaveLength(1);
    expect(profiles[0].fullName).toBe("Fixture Full Name");
    expect(profiles[0].email).toBe("fixture-profile@example.com");
    const maps = await prisma.legacyMigrationMap.findMany();
    expect(maps).toHaveLength(1);
    expect(maps[0].targetEntityType).toBe(TARGET.CANDIDATE_PROFILE);
    expect(maps[0].targetEntityId).toBe(profiles[0].id);
  }, 60_000);

  it("round-trips CandidateProfile extras and education GPA fields", async () => {
    await prisma.candidateProfile.create({
      data: {
        userId,
        fullName: "Fixture Full Name",
        gender: "女",
        birthDate: "1998-02-03",
        ethnicity: "汉族",
        politicalStatus: "群众",
        nativePlace: "Fixture Place",
        householdRegistration: "Fixture Hukou",
        graduationCohort: "2027",
      },
    });
    const material = await prisma.careerMaterialItem.create({
      data: {
        userId,
        type: "EDUCATION",
        title: "Fixture University",
        educationDetail: {
          create: {
            institution: "Fixture University",
            gpaValue: 3.7,
            gpaScale: 4,
            rankText: "10/120",
          },
        },
      },
    });
    const { buffer } = await buildBackupZip(userId, EMAIL);
    await prisma.careerEducationDetail.deleteMany();
    await prisma.careerMaterialItem.deleteMany();
    await prisma.candidateProfile.deleteMany();
    await importBackup(buffer, userId, EMAIL, true);
    const profile = await prisma.candidateProfile.findUniqueOrThrow({
      where: { userId },
    });
    expect(profile.gender).toBe("女");
    expect(profile.birthDate).toBe("1998-02-03");
    expect(profile.graduationCohort).toBe("2027");
    const education = await prisma.careerEducationDetail.findFirstOrThrow({
      where: { materialItem: { userId } },
    });
    expect(education.gpaValue).toBe(3.7);
    expect(education.gpaScale).toBe(4);
    expect(education.rankText).toBe("10/120");
    expect(education.materialItemId).not.toBe(material.id);
  }, 60_000);
});

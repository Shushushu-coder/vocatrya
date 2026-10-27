// @vitest-environment node
import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import JSZip from "jszip";
import fs from "fs";
import os from "os";
import path from "path";
import { APP_CONSTANTS } from "@/lib/constants";
import { deriveEducationSummary } from "@/lib/career/educationDerivation";
import {
  sanitizeApplicationMaterialDetail,
  resolveApplicationMaterialTitle,
} from "@/lib/career/careerMaterialInput";
import { maskEmail, maskName, maskPhone } from "@/lib/career/sensitiveMask";
import {
  BackupDataSchema,
  BACKUP_FORMAT_VERSION,
  SUPPORTED_BACKUP_FORMAT_VERSIONS,
} from "@/lib/backup/schema";
import {
  backupDataset,
  INSERT_ORDER,
  EMPTINESS_MODELS,
} from "@/lib/backup/ordering";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { activateFreshAbNative } from "@/lib/career";
import { CandidateRefereeService } from "@/lib/career/candidateRefereeService";
import { CandidateAttachmentService } from "@/lib/career/candidateAttachmentService";
import { checkImportedAttachment } from "@/lib/backup/normalize";

// The shared `@/lib/db` client and import path must point at the disposable
// test database — the env var alone races module initialization.
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

const { resetDisposableDb, seedAccount } = await import("./helpers/backupTestDb");

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0,
]);

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
const originalUploads = APP_CONSTANTS.UPLOADS_DIR;
let uploadsDir: string;

beforeAll(async () => {
  // Fresh-native runtime gates: services call assertResumeV1* internally.
  process.env.VOCATRYA_AB_RUNTIME_ENABLED = "true";
  process.env.VOCATRYA_AB_ROLLOUT_SCOPE = "full";
}, 120_000);

beforeEach(async () => {
  await resetDisposableDb(prisma);
  // Fresh-native activation writes the migration state the AB gates consult.
  await activateFreshAbNative(prisma);
  userId = await seedAccount(prisma, "w4@example.com");
  // Every service test needs its own uploads root so nothing touches real data.
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-w4-uploads-"));
  fs.mkdirSync(path.join(uploadsDir, "files", "career-attachments"), {
    recursive: true,
  });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
});

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows can retain a short-lived SQLite handle after disconnect.
  }
});

function eduItem(overrides: {
  id: string;
  degree?: string | null;
  graduationOn?: string | null;
  graduationExpected?: boolean;
  isCurrent?: boolean;
  endDate?: string | null;
}) {
  return {
    id: overrides.id,
    isCurrent: overrides.isCurrent ?? false,
    endDate: overrides.endDate ?? null,
    updatedAt: "2026-01-01T00:00:00Z",
    educationDetail: {
      degree: overrides.degree ?? null,
      locationText: null,
      graduationOn: overrides.graduationOn ?? null,
      graduationExpected: overrides.graduationExpected ?? false,
    },
  };
}

describe("education derivation (contract §4)", () => {
  it("does not infer education from MBA or unknown degree names", () => {
    for (const degree of ["MBA", "工商管理硕士", "未知学历"]) {
      const derived = deriveEducationSummary([
        eduItem({ id: "a", degree, graduationOn: "2024-06-30" }),
      ], null);
      expect(derived.highestEducation).toBeNull();
    }
    const derived = deriveEducationSummary([
      eduItem({ id: "a", degree: "MBA", graduationOn: "2024-06-30" }),
      eduItem({ id: "b", degree: "本科", graduationOn: "2020-06-30" }),
    ], null);
    expect(derived.highestEducation).toBe("本科");
  });
  it("derives highest education only from explicitly obtained facts", () => {
    const derived = deriveEducationSummary(
      [
        eduItem({ id: "a", degree: "硕士", graduationOn: "2024-06-30" }),
        eduItem({ id: "b", degree: "本科", isCurrent: false }),
      ],
      null,
    );
    expect(derived.highestEducation).toBe("硕士");
    expect(derived.graduationCohort).toBe("2024");
    expect(derived.cohortSource).toBe("derived");
  });

  it("isCurrent=false alone never counts as graduated", () => {
    const derived = deriveEducationSummary(
      [eduItem({ id: "a", degree: "本科", isCurrent: false, endDate: "2020-07-01" })],
      null,
    );
    // endDate alone is not an explicit obtained fact (graduationOn is).
    expect(derived.highestEducation).toBeNull();
    expect(derived.cohortSource).toBe("none");
  });

  it("keeps unknown unknown and reports in-progress separately", () => {
    const derived = deriveEducationSummary(
      [eduItem({ id: "a", degree: "硕士", isCurrent: true, graduationExpected: true })],
      null,
    );
    expect(derived.highestEducation).toBeNull();
    expect(derived.inProgressDegree).toBe("硕士");
    expect(derived.cohortSource).toBe("none");
  });

  it("excludes postdoctoral records from degree levels", () => {
    const derived = deriveEducationSummary(
      [
        eduItem({ id: "a", degree: "博士后", graduationOn: "2025-06-30" }),
        eduItem({ id: "b", degree: "博士", graduationOn: "2022-06-30" }),
      ],
      null,
    );
    expect(derived.highestEducation).toBe("博士");
    expect(derived.graduationCohort).toBe("2022");
  });

  it("falls back to the manual cohort only when nothing derives", () => {
    const derived = deriveEducationSummary([], "2020届");
    expect(derived.graduationCohort).toBe("2020届");
    expect(derived.cohortSource).toBe("manual");
  });
});

describe("LANGUAGE material input (§3)", () => {
  it("requires language or exam/level at title resolution", () => {
    // The "at least one meaningful value" rule is enforced where the record
    // title is composed; the sanitizer itself stays field-shape only.
    expect(() =>
      resolveApplicationMaterialTitle("LANGUAGE", "", {}),
    ).toThrow();
    const detail = sanitizeApplicationMaterialDetail("LANGUAGE", {
      language: "英语",
    });
    expect(detail).toEqual({ language: "英语" });
  });

  it("composes a readable title from language and exam/level", () => {
    const title = resolveApplicationMaterialTitle("LANGUAGE", "", {
      language: "英语",
      examOrLevel: "CET-6",
    });
    expect(title).toContain("英语");
    expect(title).toContain("CET-6");
  });

  it("accepts the new structured detail fields", () => {
    const project = sanitizeApplicationMaterialDetail("PROJECT", {
      projectType: "个人项目",
      techStack: "Next.js, Prisma",
    });
    expect(project).toEqual({
      projectType: "个人项目",
      techStack: "Next.js, Prisma",
    });
    // Unknown keys are rejected outright, never silently stripped.
    expect(() =>
      sanitizeApplicationMaterialDetail("PROJECT", { ignoredColumn: "x" }),
    ).toThrow();
    const award = sanitizeApplicationMaterialDetail("AWARD", {
      awardType: "奖学金",
      awardLevel: "国家级",
      awardScope: "全国",
    });
    expect(award.awardLevel).toBe("国家级");
    const edu = sanitizeApplicationMaterialDetail("EDUCATION", {
      graduationOn: "2024-06-30",
      graduationExpected: false,
      isExchange: true,
      hasNationalScholarship: true,
      advisorName: "王导",
    });
    expect(edu.graduationOn).toBe("2024-06-30");
    expect(edu.isExchange).toBe(true);
  });
});

describe("sensitive masking", () => {
  it("masks referee-style values", () => {
    expect(maskName("张三丰")).not.toBe("张三丰");
    expect(maskName("张三丰")).toContain("*");
    expect(maskPhone("13800001234")).toContain("*");
    expect(maskEmail("ref@example.com")).toContain("*");
  });
});

describe("backup V5 schema surface", () => {
  it("rejects PDF bytes for ID photos during restore", () => {
    const pdf = Buffer.from("%PDF-1.4\n");
    expect(checkImportedAttachment(pdf, "ID_PHOTO")).toBeNull();
    expect(checkImportedAttachment(pdf, "AWARD_PROOF")?.kind).toBe("pdf");
    expect(checkImportedAttachment(PNG_BYTES, "UNKNOWN")).toBeNull();
  });
  it("declares version 5 and supports 1..5", () => {
    expect(BACKUP_FORMAT_VERSION).toBe(5);
    for (const v of [1, 2, 3, 4, 5]) {
      expect(SUPPORTED_BACKUP_FORMAT_VERSIONS).toContain(v);
    }
  });

  it("registers the three new models with correct dataset scope", () => {
    expect(backupDataset("CareerLanguageDetail")).toBe("standard");
    expect(backupDataset("CandidateReferee")).toBe("sensitive");
    expect(backupDataset("CandidateAttachment")).toBe("sensitive");
    for (const m of [
      "CareerLanguageDetail",
      "CandidateReferee",
      "CandidateAttachment",
    ] as const) {
      expect(INSERT_ORDER).toContain(m);
    }
    // Referee/attachment are user-level emptiness signals; the language
    // detail is covered by its parent CareerMaterialItem.
    for (const m of ["CandidateReferee", "CandidateAttachment"] as const) {
      expect(EMPTINESS_MODELS).toContain(m);
    }
  });

  it("parses data with new groups optional (v1-v4 tolerance)", () => {
    const empty = BackupDataSchema.parse({});
    expect(empty.CandidateReferee).toEqual([]);
    expect(empty.CandidateAttachment).toEqual([]);
    expect(empty.CareerLanguageDetail).toEqual([]);
  });
});

describe("referee + attachment services (isolated db)", () => {
  it("creates, lists, updates and archives referees", async () => {
    const svc = new CandidateRefereeService(prisma, userId);
    const created = await svc.create({
      name: "  李老师 ",
      organization: "某大学",
      position: "教授",
      phone: "13800001234",
      email: "li@example.com",
    });
    expect(created.name).toBe("李老师");
    const listed = await svc.list();
    expect(listed).toHaveLength(1);
    await svc.update(created.id, { position: "副教授" });
    await svc.archive(created.id);
    expect(await svc.list()).toHaveLength(0);
    await expect(svc.create({ name: "  " })).rejects.toThrow();
  });

  it("stores attachments under logical keys with sniffed mime", async () => {
    const svc = new CandidateAttachmentService(prisma, userId);
    const row = await svc.create({
      category: "ID_PHOTO",
      fileName: "photo.png",
      bytes: new Uint8Array(PNG_BYTES),
    });
    expect(row.mimeType).toBe("image/png");
    expect(row.storageKey).toContain("career-attachments");
    expect(path.isAbsolute(row.storageKey)).toBe(false);
    // Bytes landed under UPLOADS_DIR/files/, never at an absolute path.
    const file = path.join(uploadsDir, "files", row.storageKey);
    expect(fs.existsSync(file)).toBe(true);
    await svc.archive(row.id);
    expect(await svc.list({ category: "ID_PHOTO" })).toHaveLength(0);
    await expect(
      svc.create({
        category: "ID_PHOTO",
        fileName: "x.pdf",
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      }),
    ).rejects.toThrow();
  });
});

describe("backup V5 round trip", () => {
  async function seedCareerData() {
    await prisma.candidateProfile.create({
      data: { userId, fullName: "张三", wechatId: "wx-1", countryOrRegion: "中国" },
    });
    const sensitive = await prisma.candidateSensitiveInfo.create({
      data: { userId, idType: "身份证", idNumber: "110101199001011234" },
    });
    await prisma.candidateReferee.create({
      data: {
        sensitiveInfoId: sensitive.id,
        name: "李老师",
        phone: "13800001234",
      },
    });
    const item = await prisma.careerMaterialItem.create({
      data: { userId, type: "LANGUAGE", title: "英语 CET-6" },
    });
    await prisma.careerLanguageDetail.create({
      data: { materialItemId: item.id, language: "英语", examOrLevel: "CET-6" },
    });
    const key = `career-attachments/${item.id}/proof.png`;
    const abs = path.join(uploadsDir, "files", key);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, PNG_BYTES);
    await prisma.candidateAttachment.create({
      data: {
        userId,
        materialItemId: item.id,
        category: "AWARD_PROOF",
        fileName: "proof.png",
        mimeType: "image/png",
        sizeBytes: PNG_BYTES.length,
        storageKey: key,
      },
    });
  }

  it("standard backup excludes sensitive groups; sensitive backup round-trips them", async () => {
    await seedCareerData();

    const standard = await buildBackupZip(userId, "w4@example.com");
    const stdZip = await JSZip.loadAsync(standard.buffer);
    const stdData = JSON.parse(await stdZip.file("data.json")!.async("string"));
    const stdManifest = JSON.parse(
      await stdZip.file("manifest.json")!.async("string"),
    );
    expect(stdManifest.formatVersion).toBe(5);
    expect(stdManifest.containsSensitiveData).toBe(false);
    expect(stdData.CandidateReferee).toBeUndefined();
    expect(stdData.CandidateAttachment).toBeUndefined();
    expect(stdData.CareerLanguageDetail).toHaveLength(1);
    expect(
      Object.keys(stdZip.files).some((n) => n.startsWith("career-attachments/")),
    ).toBe(false);

    const sensitive = await buildBackupZip(userId, "w4@example.com", {
      includeSensitiveData: true,
    });
    const senZip = await JSZip.loadAsync(sensitive.buffer);
    const senData = JSON.parse(await senZip.file("data.json")!.async("string"));
    expect(senData.CandidateReferee).toHaveLength(1);
    expect(senData.CandidateAttachment).toHaveLength(1);
    const entryName = Object.keys(senZip.files).find(
      (n) => n.startsWith("career-attachments/") && !senZip.files[n].dir,
    );
    expect(entryName).toBeTruthy();
    expect(await senZip.files[entryName!].async("nodebuffer")).toEqual(PNG_BYTES);

    // Import into a fresh empty account on the same db.
    await resetDisposableDb(prisma);
    const freshId = await seedAccount(prisma, "fresh@example.com");
    await importBackup(sensitive.buffer, freshId, "fresh@example.com", false);
    expect(
      await prisma.candidateReferee.count({
        where: { sensitiveInfo: { userId: freshId } },
      }),
    ).toBe(1);
    expect(
      await prisma.careerLanguageDetail.count({
        where: { materialItem: { userId: freshId } },
      }),
    ).toBe(1);
    const restored = await prisma.candidateAttachment.findFirst({
      where: { userId: freshId },
    });
    expect(restored).toBeTruthy();
    expect(restored!.storageKey).not.toBe("");
    const restoredBytes = await prisma.candidateAttachment.findUniqueOrThrow({
      where: { id: restored!.id },
    });
    expect(restoredBytes.mimeType).toBe("image/png");
    const restoredPath = path.join(uploadsDir, "files", restored!.storageKey);
    expect(fs.existsSync(restoredPath)).toBe(true);
    const profile = await prisma.candidateProfile.findUniqueOrThrow({
      where: { userId: freshId },
    });
    expect(profile.wechatId).toBe("wx-1");
  });
});

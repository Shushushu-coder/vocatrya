// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { BackupDataSchema } from "@/lib/backup/schema";
import { INSERT_ORDER, MODEL_SPECS } from "@/lib/backup/ordering";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ApplicationService,
  OpportunityService,
  PROCESS_STEP_CATEGORY,
  writeInstanceMigrationState,
} from "@/lib/career";
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

let userId: string;
let uploadsDir: string;

beforeAll(async () => {
  uploadsDir = path.join(ctx.dir, "uploads");
  fs.mkdirSync(path.join(uploadsDir, "files", "resumes"), { recursive: true });
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = uploadsDir;
  userId = await seedAccount(prisma, "interview-reflection-backup@example.com");
}, 120_000);

afterAll(async () => {
  (APP_CONSTANTS as { UPLOADS_DIR: string }).UPLOADS_DIR = originalUploads;
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(
    prisma,
    `interview-reflection-backup-${Date.now()}@example.com`,
  );
});

describe("interview reflection backup contract", () => {
  it("keeps reflectionText and includes the child model after ApplicationInterviewDetail", () => {
    expect(INSERT_ORDER).toContain("ApplicationInterviewReflectionItem");
    expect(MODEL_SPECS.ApplicationInterviewReflectionItem).toBeTruthy();
    expect(BackupDataSchema.shape).toHaveProperty(
      "ApplicationInterviewReflectionItem",
    );
    expect(
      INSERT_ORDER.indexOf("ApplicationInterviewDetail"),
    ).toBeLessThan(
      INSERT_ORDER.indexOf("ApplicationInterviewReflectionItem"),
    );

    const parsed = BackupDataSchema.parse({
      ApplicationInterviewDetail: [
        {
          id: "detail-1",
          applicationProcessStepId: "step-1",
          interviewFormat: "ONSITE",
          roundLabel: "legacy-round",
          locationText: "北京",
          interviewerNames: "张三",
          durationMinutes: 45,
          structuredData: "{}",
          reflectionText: "项目经历回答太散，下次先讲职责和结果。",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      ApplicationInterviewReflectionItem: [
        {
          id: "item-1",
          applicationInterviewDetailId: "detail-1",
          questionText: "介绍一下你的推荐系统项目",
          answerNotes: "讲了模型，但没有明确个人贡献",
          sortOrder: 10,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    expect(parsed.ApplicationInterviewDetail[0].reflectionText).toBe(
      "项目经历回答太散，下次先讲职责和结果。",
    );
    expect(parsed.ApplicationInterviewReflectionItem[0]).toMatchObject({
      questionText: "介绍一下你的推荐系统项目",
      answerNotes: "讲了模型，但没有明确个人贡献",
      sortOrder: 10,
    });
  });

  it("accepts old InterviewDetail rows without reflectionText and defaults missing items", () => {
    const parsed = BackupDataSchema.parse({
      ApplicationInterviewDetail: [
        {
          id: "detail-old",
          applicationProcessStepId: "step-old",
          interviewFormat: "ONSITE",
          roundLabel: "Hiring manager",
          locationText: null,
          interviewerNames: null,
          durationMinutes: null,
          structuredData: JSON.stringify({ panel: 2 }),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    expect(parsed.ApplicationInterviewDetail[0].reflectionText).toBeUndefined();
    expect(parsed.ApplicationInterviewDetail[0].interviewFormat).toBe("ONSITE");
    expect(parsed.ApplicationInterviewDetail[0].structuredData).toBe(
      JSON.stringify({ panel: 2 }),
    );
    expect(parsed.ApplicationInterviewReflectionItem).toEqual([]);
  });

  it("round-trips reflectionText, items, and existing metadata", async () => {
    const company = await prisma.company.create({
      data: {
        label: "Tencent",
        value: `tencent-interview-reflection-${Date.now()}`,
        createdBy: userId,
      },
    });
    const opportunity = await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: company.id,
        title: "软件工程师",
        status: "UNKNOWN",
      },
    });
    const attempt = await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: opportunity.id,
        channelLabel: "USER",
        currentStageCategory: "INTERVIEW",
        outcome: "ACTIVE",
      },
    });
    const step = await prisma.applicationProcessStep.create({
      data: {
        applicationAttemptId: attempt.id,
        category: PROCESS_STEP_CATEGORY.INTERVIEW,
        label: "二面",
        sortOrder: 10,
        source: "USER",
      },
    });
    const detail = await prisma.applicationInterviewDetail.create({
      data: {
        applicationProcessStepId: step.id,
        interviewFormat: "ONSITE",
        roundLabel: "should-not-be-round-source",
        locationText: "深圳",
        interviewerNames: "李四",
        durationMinutes: 60,
        structuredData: JSON.stringify({ panel: 2 }),
        reflectionText: "项目经历回答太散，下次先讲职责和结果。",
      },
    });
    await prisma.applicationInterviewReflectionItem.create({
      data: {
        applicationInterviewDetailId: detail.id,
        questionText: "遇到最大的技术问题是什么",
        answerNotes: "讲了冷启动，但缺少量化结果",
        sortOrder: 20,
      },
    });
    await prisma.applicationInterviewReflectionItem.create({
      data: {
        applicationInterviewDetailId: detail.id,
        questionText: "介绍一下你的推荐系统项目",
        answerNotes: "讲了模型，但没有明确个人贡献",
        sortOrder: 10,
      },
    });

    const { buffer } = await buildBackupZip(
      userId,
      "interview-reflection-backup@example.com",
    );
    const result = await importBackup(
      buffer,
      userId,
      "interview-reflection-backup@example.com",
      true,
    );
    expect(result.counts.ApplicationInterviewDetail).toBe(1);
    expect(result.counts.ApplicationInterviewReflectionItem).toBe(2);

    const restoredStep = await prisma.applicationProcessStep.findFirstOrThrow({
      where: {
        applicationAttempt: { userId },
        category: PROCESS_STEP_CATEGORY.INTERVIEW,
      },
      include: {
        interviewDetail: {
          include: {
            reflectionItems: { orderBy: { sortOrder: "asc" } },
          },
        },
      },
    });
    expect(restoredStep.id).not.toBe(step.id);
    expect(restoredStep.label).toBe("二面");
    expect(restoredStep.interviewDetail).not.toBeNull();
    expect(restoredStep.interviewDetail?.id).not.toBe(detail.id);
    expect(restoredStep.interviewDetail?.reflectionText).toBe(
      "项目经历回答太散，下次先讲职责和结果。",
    );
    expect(restoredStep.interviewDetail?.interviewFormat).toBe("ONSITE");
    expect(restoredStep.interviewDetail?.roundLabel).toBe(
      "should-not-be-round-source",
    );
    expect(restoredStep.interviewDetail?.locationText).toBe("深圳");
    expect(restoredStep.interviewDetail?.interviewerNames).toBe("李四");
    expect(restoredStep.interviewDetail?.durationMinutes).toBe(60);
    expect(restoredStep.interviewDetail?.structuredData).toBe(
      JSON.stringify({ panel: 2 }),
    );

    const items = restoredStep.interviewDetail?.reflectionItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0].questionText).toBe("介绍一下你的推荐系统项目");
    expect(items[0].answerNotes).toBe("讲了模型，但没有明确个人贡献");
    expect(items[0].sortOrder).toBe(10);
    expect(items[1].questionText).toBe("遇到最大的技术问题是什么");
    expect(items[1].answerNotes).toBe("讲了冷启动，但缺少量化结果");
    expect(items[1].sortOrder).toBe(20);
    expect(items[0].id).not.toBe(items[1].id);
  }, 120_000);

  it("round-trips reflection written through saveInterviewReflection", async () => {
    await writeInstanceMigrationState(prisma, {
      status: AB_MIGRATION_STATUS.COMPLETED,
      completedAt: new Date(),
      verifiedAt: new Date(),
    });
    const featureOn = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };
    const company = await prisma.company.create({
      data: {
        label: "ByteDance",
        value: `bytedance-interview-reflection-${Date.now()}`,
        createdBy: userId,
      },
    });
    const opportunities = new OpportunityService(prisma, userId, featureOn);
    const applications = new ApplicationService(prisma, userId, featureOn);
    const opportunity = await opportunities.create({
      companyId: company.id,
      title: "软件工程师",
    });
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "二面",
    });
    const saved = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "项目经历回答还是太散。",
      items: [
        {
          questionText: "介绍一下你的推荐系统项目",
          answerNotes: "讲了模型，但没有明确个人贡献",
        },
        {
          questionText: "最大的技术挑战是什么",
          answerNotes: "冷启动",
        },
      ],
    });

    const { buffer } = await buildBackupZip(
      userId,
      "interview-reflection-product@example.com",
    );
    const result = await importBackup(
      buffer,
      userId,
      "interview-reflection-product@example.com",
      true,
    );
    expect(result.counts.ApplicationInterviewDetail).toBe(1);
    expect(result.counts.ApplicationInterviewReflectionItem).toBe(2);

    const restoredStep = await prisma.applicationProcessStep.findFirstOrThrow({
      where: {
        applicationAttempt: { userId },
        category: PROCESS_STEP_CATEGORY.INTERVIEW,
      },
      include: {
        interviewDetail: {
          include: {
            reflectionItems: { orderBy: { sortOrder: "asc" } },
          },
        },
      },
    });
    expect(restoredStep.interviewDetail?.reflectionText).toBe(
      saved.reflectionText,
    );
    const items = restoredStep.interviewDetail?.reflectionItems ?? [];
    expect(items.map((item) => item.questionText)).toEqual(
      saved.items.map((item) => item.questionText),
    );
    expect(items.map((item) => item.answerNotes)).toEqual(
      saved.items.map((item) => item.answerNotes),
    );
    expect(items.map((item) => item.sortOrder)).toEqual([10, 20]);
  }, 120_000);

  it("parses the v8 columns and tolerates their absence (pre-v8 rows)", () => {
    const parsed = BackupDataSchema.parse({
      ApplicationInterviewDetail: [
        {
          id: "detail-new",
          applicationProcessStepId: "step-1",
          interviewFormat: null,
          roundLabel: null,
          locationText: null,
          interviewerNames: null,
          durationMinutes: null,
          structuredData: "{}",
          reflectionText: null,
          reflectionCompletedAt: new Date("2026-11-04T10:00:00.000Z"),
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "detail-legacy",
          applicationProcessStepId: "step-2",
          interviewFormat: null,
          roundLabel: null,
          locationText: null,
          interviewerNames: null,
          durationMinutes: null,
          structuredData: "{}",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      ApplicationInterviewReflectionItem: [
        {
          id: "item-new",
          applicationInterviewDetailId: "detail-new",
          questionText: "Q",
          answerNotes: null,
          sourceQuestionId: "q-1",
          sourceKind: "QUESTION_BANK",
          sortOrder: 10,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "item-legacy",
          applicationInterviewDetailId: "detail-new",
          questionText: "Q2",
          answerNotes: null,
          sortOrder: 20,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    expect(parsed.ApplicationInterviewDetail[0].reflectionCompletedAt)
      .toBeInstanceOf(Date);
    expect(
      parsed.ApplicationInterviewDetail[1].reflectionCompletedAt,
    ).toBeUndefined();
    expect(parsed.ApplicationInterviewReflectionItem[0]).toMatchObject({
      sourceQuestionId: "q-1",
      sourceKind: "QUESTION_BANK",
    });
    expect(
      parsed.ApplicationInterviewReflectionItem[1].sourceQuestionId,
    ).toBeUndefined();
    expect(
      parsed.ApplicationInterviewReflectionItem[1].sourceKind,
    ).toBeUndefined();
  });

  it("round-trips the completion mark and remaps sourceQuestionId to the restored Question", async () => {
    const company = await prisma.company.create({
      data: {
        label: "SourceCo",
        value: `source-reflection-${Date.now()}`,
        createdBy: userId,
      },
    });
    const question = await prisma.question.create({
      data: { question: "题库原题", answer: null, createdBy: userId },
    });
    const opportunity = await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: company.id,
        title: "Engineer",
        status: "UNKNOWN",
      },
    });
    const attempt = await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: opportunity.id,
        channelLabel: "USER",
        outcome: "ACTIVE",
      },
    });
    const step = await prisma.applicationProcessStep.create({
      data: {
        applicationAttemptId: attempt.id,
        category: PROCESS_STEP_CATEGORY.INTERVIEW,
        label: "一面",
        sortOrder: 10,
        source: "USER",
      },
    });
    const detail = await prisma.applicationInterviewDetail.create({
      data: {
        applicationProcessStepId: step.id,
        structuredData: "{}",
        reflectionText: "复盘完成",
        reflectionCompletedAt: new Date("2026-11-04T09:00:00.000Z"),
      },
    });
    await prisma.applicationInterviewReflectionItem.create({
      data: {
        applicationInterviewDetailId: detail.id,
        questionText: "题库原题快照",
        sourceQuestionId: question.id,
        sourceKind: "QUESTION_BANK",
        sortOrder: 10,
      },
    });

    const { buffer } = await buildBackupZip(
      userId,
      "interview-reflection-source@example.com",
    );
    await importBackup(
      buffer,
      userId,
      "interview-reflection-source@example.com",
      true,
    );

    const restoredQuestion = await prisma.question.findFirstOrThrow({
      where: { createdBy: userId },
    });
    expect(restoredQuestion.id).not.toBe(question.id);

    const restoredItem =
      await prisma.applicationInterviewReflectionItem.findFirstOrThrow({
        where: {
          applicationInterviewDetail: {
            processStep: { applicationAttempt: { userId } },
          },
        },
      });
    expect(restoredItem.sourceQuestionId).toBe(restoredQuestion.id);
    expect(restoredItem.sourceKind).toBe("QUESTION_BANK");

    const restoredDetail =
      await prisma.applicationInterviewDetail.findFirstOrThrow({
        where: { processStep: { applicationAttempt: { userId } } },
      });
    expect(restoredDetail.reflectionCompletedAt?.toISOString()).toBe(
      "2026-11-04T09:00:00.000Z",
    );
  }, 120_000);

  it("restores a pre-v8 backup with NULL in the new columns", async () => {
    const JSZip = (await import("jszip")).default;
    const company = await prisma.company.create({
      data: {
        label: "LegacyCo",
        value: `legacy-reflection-${Date.now()}`,
        createdBy: userId,
      },
    });
    const opportunity = await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: company.id,
        title: "Engineer",
        status: "UNKNOWN",
      },
    });
    const attempt = await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: opportunity.id,
        channelLabel: "USER",
        outcome: "ACTIVE",
      },
    });
    const step = await prisma.applicationProcessStep.create({
      data: {
        applicationAttemptId: attempt.id,
        category: PROCESS_STEP_CATEGORY.INTERVIEW,
        label: "一面",
        sortOrder: 10,
        source: "USER",
      },
    });
    const detail = await prisma.applicationInterviewDetail.create({
      data: {
        applicationProcessStepId: step.id,
        structuredData: "{}",
        reflectionText: "老备份的复盘",
      },
    });
    await prisma.applicationInterviewReflectionItem.create({
      data: {
        applicationInterviewDetailId: detail.id,
        questionText: "老问题",
        sortOrder: 10,
      },
    });

    const { buffer } = await buildBackupZip(
      userId,
      "interview-reflection-legacy@example.com",
    );
    const zip = await JSZip.loadAsync(buffer);
    const data = JSON.parse(await zip.file("data.json")!.async("string"));
    const manifest = JSON.parse(
      await zip.file("manifest.json")!.async("string"),
    );
    // Simulate the pre-v8 payload: the keys simply do not exist.
    for (const row of data.ApplicationInterviewDetail) {
      delete row.reflectionCompletedAt;
    }
    for (const row of data.ApplicationInterviewReflectionItem) {
      delete row.sourceQuestionId;
      delete row.sourceKind;
    }
    manifest.formatVersion = 7;
    const legacyZip = new JSZip();
    legacyZip.file("manifest.json", JSON.stringify(manifest));
    legacyZip.file("data.json", JSON.stringify(data));
    const legacyBuffer = await legacyZip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });

    await importBackup(
      legacyBuffer,
      userId,
      "interview-reflection-legacy@example.com",
      true,
    );
    const restoredDetail =
      await prisma.applicationInterviewDetail.findFirstOrThrow({
        where: { processStep: { applicationAttempt: { userId } } },
      });
    expect(restoredDetail.reflectionCompletedAt).toBeNull();
    const restoredItem =
      await prisma.applicationInterviewReflectionItem.findFirstOrThrow({
        where: { applicationInterviewDetailId: restoredDetail.id },
      });
    expect(restoredItem.sourceQuestionId).toBeNull();
    expect(restoredItem.sourceKind).toBeNull();
  }, 120_000);
});

// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  assertInterviewReflectionStep,
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

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true" };
const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let companyId: string;

beforeAll(() => {
  pushSchema(ctx.url);
}, 120_000);

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
  userId = await seedAccount(prisma, `interview-reflection-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-interview-reflection-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
});

async function createInterviewStep(label = "二面") {
  const opportunities = new OpportunityService(prisma, userId, FEATURE_ON);
  const applications = new ApplicationService(prisma, userId, FEATURE_ON);
  const opportunity = await opportunities.create({
    companyId,
    title: "软件工程师",
  });
  const step = await applications.createUserProcessStep({
    jobOpportunityId: opportunity.id,
    category: PROCESS_STEP_CATEGORY.INTERVIEW,
    label,
  });
  return { applications, step };
}

describe("ApplicationInterviewDetail.reflectionText", () => {
  it("round-trips null and non-empty text", async () => {
    const { step } = await createInterviewStep();
    const created = await prisma.applicationInterviewDetail.create({
      data: { applicationProcessStepId: step.id },
    });
    expect(created.reflectionText).toBeNull();

    const updated = await prisma.applicationInterviewDetail.update({
      where: { id: created.id },
      data: {
        reflectionText: "项目经历回答太散，下次先讲职责和结果。",
      },
    });
    expect(updated.reflectionText).toBe("项目经历回答太散，下次先讲职责和结果。");

    const reread = await prisma.applicationInterviewDetail.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(reread.reflectionText).toBe("项目经历回答太散，下次先讲职责和结果。");
  });

  it("keeps existing metadata columns readable after reflectionText is added", async () => {
    const { step } = await createInterviewStep();
    const detail = await prisma.applicationInterviewDetail.create({
      data: {
        applicationProcessStepId: step.id,
        interviewFormat: "ONSITE",
        roundLabel: "should-not-be-round-source",
        locationText: "北京",
        interviewerNames: "张三",
        durationMinutes: 45,
        structuredData: JSON.stringify({ panel: 2 }),
        reflectionText: "整场复盘",
      },
    });
    const reread = await prisma.applicationInterviewDetail.findUniqueOrThrow({
      where: { id: detail.id },
    });
    expect(reread.interviewFormat).toBe("ONSITE");
    expect(reread.roundLabel).toBe("should-not-be-round-source");
    expect(reread.locationText).toBe("北京");
    expect(reread.interviewerNames).toBe("张三");
    expect(reread.durationMinutes).toBe(45);
    expect(reread.structuredData).toBe(JSON.stringify({ panel: 2 }));
    expect(reread.reflectionText).toBe("整场复盘");
  });
});

describe("ApplicationInterviewReflectionItem", () => {
  it("allows 0, 1, and N items on one InterviewDetail", async () => {
    const { step } = await createInterviewStep();
    const detail = await prisma.applicationInterviewDetail.create({
      data: { applicationProcessStepId: step.id },
    });
    expect(
      await prisma.applicationInterviewReflectionItem.count({
        where: { applicationInterviewDetailId: detail.id },
      }),
    ).toBe(0);

    await prisma.applicationInterviewReflectionItem.create({
      data: {
        applicationInterviewDetailId: detail.id,
        questionText: "介绍一下你的推荐系统项目",
        answerNotes: "讲了模型，但没有明确个人贡献",
        sortOrder: 10,
      },
    });
    expect(
      await prisma.applicationInterviewReflectionItem.count({
        where: { applicationInterviewDetailId: detail.id },
      }),
    ).toBe(1);

    await prisma.applicationInterviewReflectionItem.createMany({
      data: [
        {
          applicationInterviewDetailId: detail.id,
          questionText: "遇到最大的技术问题是什么",
          answerNotes: "讲了冷启动，但缺少量化结果",
          sortOrder: 20,
        },
        {
          applicationInterviewDetailId: detail.id,
          questionText: "你为什么想来我们组",
          answerNotes: null,
          sortOrder: 30,
        },
      ],
    });
    const items = await prisma.applicationInterviewReflectionItem.findMany({
      where: { applicationInterviewDetailId: detail.id },
      orderBy: { sortOrder: "asc" },
    });
    expect(items).toHaveLength(3);
    expect(items.map((item) => item.questionText)).toEqual([
      "介绍一下你的推荐系统项目",
      "遇到最大的技术问题是什么",
      "你为什么想来我们组",
    ]);
    expect(items[2].answerNotes).toBeNull();
  });

  it("orders by sortOrder ASC, not insertion order", async () => {
    const { step } = await createInterviewStep();
    const detail = await prisma.applicationInterviewDetail.create({
      data: { applicationProcessStepId: step.id },
    });
    await prisma.applicationInterviewReflectionItem.create({
      data: {
        applicationInterviewDetailId: detail.id,
        questionText: "B",
        answerNotes: "item B",
        sortOrder: 20,
      },
    });
    await prisma.applicationInterviewReflectionItem.create({
      data: {
        applicationInterviewDetailId: detail.id,
        questionText: "A",
        answerNotes: "item A",
        sortOrder: 10,
      },
    });
    const items = await prisma.applicationInterviewReflectionItem.findMany({
      where: { applicationInterviewDetailId: detail.id },
      orderBy: { sortOrder: "asc" },
    });
    expect(items.map((item) => item.questionText)).toEqual(["A", "B"]);
  });
});

describe("Interview reflection cascade", () => {
  it("cascades ProcessStep → InterviewDetail → ReflectionItems on USER step delete", async () => {
    const { applications, step } = await createInterviewStep();
    const detail = await prisma.applicationInterviewDetail.create({
      data: {
        applicationProcessStepId: step.id,
        reflectionText: "整场复盘",
      },
    });
    const item = await prisma.applicationInterviewReflectionItem.create({
      data: {
        applicationInterviewDetailId: detail.id,
        questionText: "介绍一下你的推荐系统项目",
        answerNotes: "讲了模型",
        sortOrder: 10,
      },
    });

    await applications.deleteUserProcessStep(step.id);

    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).toBeNull();
    expect(
      await prisma.applicationInterviewDetail.findUnique({
        where: { id: detail.id },
      }),
    ).toBeNull();
    expect(
      await prisma.applicationInterviewReflectionItem.findUnique({
        where: { id: item.id },
      }),
    ).toBeNull();
  });

  it("cascades ReflectionItems when InterviewDetail is deleted directly", async () => {
    const { step } = await createInterviewStep();
    const detail = await prisma.applicationInterviewDetail.create({
      data: { applicationProcessStepId: step.id },
    });
    const item = await prisma.applicationInterviewReflectionItem.create({
      data: {
        applicationInterviewDetailId: detail.id,
        questionText: "介绍一下你的推荐系统项目",
        sortOrder: 10,
      },
    });

    await prisma.applicationInterviewDetail.delete({ where: { id: detail.id } });

    expect(
      await prisma.applicationInterviewReflectionItem.findUnique({
        where: { id: item.id },
      }),
    ).toBeNull();
    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).not.toBeNull();
  });
});

describe("Interview reflection category invariant", () => {
  it("passes INTERVIEW and rejects ASSESSMENT and OFFER", () => {
    expect(() =>
      assertInterviewReflectionStep(PROCESS_STEP_CATEGORY.INTERVIEW),
    ).not.toThrow();

    for (const category of [
      PROCESS_STEP_CATEGORY.ASSESSMENT,
      PROCESS_STEP_CATEGORY.OFFER,
    ]) {
      try {
        assertInterviewReflectionStep(category);
        throw new Error(`expected ${category} to reject`);
      } catch (error) {
        expect(error).toMatchObject({
          code: "INTERVIEW_REFLECTION_STEP_CATEGORY_INVALID",
        });
      }
    }
  });
});

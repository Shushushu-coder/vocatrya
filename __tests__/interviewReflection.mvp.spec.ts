// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  ATTEMPT_OUTCOME,
  ATTEMPT_STAGE,
  listUpcomingApplicationEvents,
  OpportunityService,
  PROCESS_STEP_CATEGORY,
  PROCESS_STEP_SOURCE,
  PROCESS_STEP_STATUS,
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
let otherUserId: string;
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
  userId = await seedAccount(prisma, `interview-mvp-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `interview-mvp-other-${Date.now()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-interview-mvp-${Date.now()}`,
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

function services(ownerId = userId) {
  return {
    opportunities: new OpportunityService(prisma, ownerId, FEATURE_ON),
    applications: new ApplicationService(prisma, ownerId, FEATURE_ON),
  };
}

async function createInterviewStep(input?: {
  label?: string;
  source?: string;
  status?: string;
  notes?: string | null;
  scheduledAt?: Date | null;
  deadlineAt?: Date | null;
}) {
  const { opportunities, applications } = services();
  const opportunity = await opportunities.create({
    companyId,
    title: "软件工程师",
  });
  const step = await applications.createUserProcessStep({
    jobOpportunityId: opportunity.id,
    category: PROCESS_STEP_CATEGORY.INTERVIEW,
    label: input?.label ?? "二面",
    notes: input?.notes ?? "流程备注，不要进复盘",
    scheduledAt: input?.scheduledAt ?? null,
    deadlineAt: input?.deadlineAt ?? null,
  });
  if (input?.source || input?.status) {
    await prisma.applicationProcessStep.update({
      where: { id: step.id },
      data: {
        source: input.source ?? step.source,
        status: input.status ?? step.status,
      },
    });
  }
  const fresh = await prisma.applicationProcessStep.findUniqueOrThrow({
    where: { id: step.id },
  });
  return { applications, opportunity, step: fresh };
}

async function createNonInterviewStep(category: string) {
  const { opportunities, applications } = services();
  const opportunity = await opportunities.create({
    companyId,
    title: "软件工程师",
  });
  const step = await applications.createUserProcessStep({
    jobOpportunityId: opportunity.id,
    category,
    label: category,
  });
  return { applications, step };
}

describe("getInterviewReflection", () => {
  it("returns an empty DTO without creating InterviewDetail", async () => {
    const { applications, step } = await createInterviewStep();
    const dto = await applications.getInterviewReflection(step.id);
    expect(dto).toEqual({
      applicationProcessStepId: step.id,
      reflectionText: null,
      items: [],
    });
    expect(await prisma.applicationInterviewDetail.count()).toBe(0);
    expect(await prisma.applicationInterviewReflectionItem.count()).toBe(0);
  });

  it("rejects non-interview steps", async () => {
    for (const category of [
      PROCESS_STEP_CATEGORY.ASSESSMENT,
      PROCESS_STEP_CATEGORY.OFFER,
      PROCESS_STEP_CATEGORY.OTHER,
    ]) {
      const { applications, step } = await createNonInterviewStep(category);
      await expect(
        applications.getInterviewReflection(step.id),
      ).rejects.toMatchObject({
        code: "INTERVIEW_REFLECTION_STEP_CATEGORY_INVALID",
      });
    }
  });
});

describe("saveInterviewReflection", () => {
  it("creates InterviewDetail and items with normalized sortOrder", async () => {
    const { applications, step } = await createInterviewStep();
    const saved = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "  项目经历回答还是太散。  ",
      items: [
        {
          questionText: "  介绍一下你的推荐系统项目  ",
          answerNotes: "  讲了模型  ",
        },
        {
          questionText: "最大的技术挑战是什么",
          answerNotes: "   ",
        },
      ],
    });
    expect(saved.reflectionText).toBe("项目经历回答还是太散。");
    expect(saved.items).toHaveLength(2);
    expect(saved.items[0]).toMatchObject({
      questionText: "介绍一下你的推荐系统项目",
      answerNotes: "讲了模型",
      sortOrder: 10,
    });
    expect(saved.items[1]).toMatchObject({
      questionText: "最大的技术挑战是什么",
      answerNotes: null,
      sortOrder: 20,
    });
    expect(await prisma.applicationInterviewDetail.count()).toBe(1);
    expect(await prisma.applicationInterviewReflectionItem.count()).toBe(2);
  });

  it("preserves existing item ids across edits", async () => {
    const { applications, step } = await createInterviewStep();
    const first = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "初稿",
      items: [
        { questionText: "问题 A", answerNotes: "回答 A" },
        { questionText: "问题 B", answerNotes: "回答 B" },
      ],
    });
    const [itemA, itemB] = first.items;
    const second = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "改稿",
      items: [
        { id: itemA.id, questionText: "问题 A 改", answerNotes: "回答 A 改" },
        { id: itemB.id, questionText: "问题 B 改", answerNotes: "回答 B 改" },
      ],
    });
    expect(second.items.map((item) => item.id)).toEqual([itemA.id, itemB.id]);
    expect(second.items[0].questionText).toBe("问题 A 改");
    expect(second.items[1].questionText).toBe("问题 B 改");
    expect(await prisma.applicationInterviewReflectionItem.count()).toBe(2);
  });

  it("reconciles mixed update, reorder, delete, and create", async () => {
    const { applications, step } = await createInterviewStep();
    const first = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      items: [
        { questionText: "A" },
        { questionText: "B" },
        { questionText: "C" },
      ],
    });
    const itemA = first.items[0];
    const itemB = first.items[1];
    const itemC = first.items[2];
    const second = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      items: [
        { id: itemB.id, questionText: "B 保留" },
        { id: itemA.id, questionText: "A 保留" },
        { questionText: "D 新建" },
      ],
    });
    expect(second.items).toHaveLength(3);
    expect(second.items[0]).toMatchObject({
      id: itemB.id,
      questionText: "B 保留",
      sortOrder: 10,
    });
    expect(second.items[1]).toMatchObject({
      id: itemA.id,
      questionText: "A 保留",
      sortOrder: 20,
    });
    expect(second.items[2]).toMatchObject({
      questionText: "D 新建",
      sortOrder: 30,
    });
    expect(second.items[2].id).not.toBe(itemA.id);
    expect(second.items[2].id).not.toBe(itemB.id);
    expect(second.items[2].id).not.toBe(itemC.id);
    expect(
      await prisma.applicationInterviewReflectionItem.findUnique({
        where: { id: itemC.id },
      }),
    ).toBeNull();
  });

  it("rejects a foreign item id instead of treating it as new", async () => {
    const owned = await createInterviewStep();
    await owned.applications.saveInterviewReflection({
      applicationProcessStepId: owned.step.id,
      items: [{ questionText: "自己的问题" }],
    });

    const otherCompany = await prisma.company.create({
      data: {
        label: "Other",
        value: `other-interview-mvp-${Date.now()}`,
        createdBy: otherUserId,
      },
    });
    const other = services(otherUserId);
    const otherOpportunity = await other.opportunities.create({
      companyId: otherCompany.id,
      title: "其他岗位",
    });
    const otherStep = await other.applications.createUserProcessStep({
      jobOpportunityId: otherOpportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "一面",
    });
    const foreign = await other.applications.saveInterviewReflection({
      applicationProcessStepId: otherStep.id,
      items: [{ questionText: "别人的问题" }],
    });

    await expect(
      owned.applications.saveInterviewReflection({
        applicationProcessStepId: owned.step.id,
        items: [
          { id: foreign.items[0].id, questionText: "注入别人的问题" },
        ],
      }),
    ).rejects.toMatchObject({
      code: "INTERVIEW_REFLECTION_ITEM_NOT_OWNED",
    });
    expect(await prisma.applicationInterviewReflectionItem.count()).toBe(2);
    expect(
      await prisma.applicationInterviewReflectionItem.findUnique({
        where: { id: foreign.items[0].id },
      }),
    ).not.toBeNull();
  });

  it("rejects an item id from another interview step of the same user", async () => {
    const first = await createInterviewStep({ label: "一面" });
    const saved = await first.applications.saveInterviewReflection({
      applicationProcessStepId: first.step.id,
      items: [{ questionText: "一面问题" }],
    });
    const secondStep = await first.applications.createUserProcessStep({
      jobOpportunityId: first.opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "二面",
    });
    await expect(
      first.applications.saveInterviewReflection({
        applicationProcessStepId: secondStep.id,
        items: [{ id: saved.items[0].id, questionText: "跨步骤注入" }],
      }),
    ).rejects.toMatchObject({
      code: "INTERVIEW_REFLECTION_ITEM_NOT_OWNED",
    });
  });

  it("rejects non-interview steps", async () => {
    for (const category of [
      PROCESS_STEP_CATEGORY.ASSESSMENT,
      PROCESS_STEP_CATEGORY.OFFER,
      PROCESS_STEP_CATEGORY.OTHER,
    ]) {
      const { applications, step } = await createNonInterviewStep(category);
      await expect(
        applications.saveInterviewReflection({
          applicationProcessStepId: step.id,
          items: [{ questionText: "不该保存" }],
        }),
      ).rejects.toMatchObject({
        code: "INTERVIEW_REFLECTION_STEP_CATEGORY_INVALID",
      });
    }
  });

  it("allows SYSTEM interview steps", async () => {
    const { applications, step } = await createInterviewStep({
      source: PROCESS_STEP_SOURCE.SYSTEM,
    });
    const saved = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "系统步骤也可以复盘",
      items: [{ questionText: "系统面试问了什么" }],
    });
    expect(saved.items).toHaveLength(1);
    expect(saved.reflectionText).toBe("系统步骤也可以复盘");
  });

  it("allows PENDING and COMPLETED interview steps", async () => {
    const pending = await createInterviewStep({
      status: PROCESS_STEP_STATUS.PENDING,
    });
    await expect(
      pending.applications.saveInterviewReflection({
        applicationProcessStepId: pending.step.id,
        items: [{ questionText: "待完成也可以记" }],
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ questionText: "待完成也可以记" })],
    });

    const completed = await createInterviewStep({
      status: PROCESS_STEP_STATUS.COMPLETED,
    });
    await expect(
      completed.applications.saveInterviewReflection({
        applicationProcessStepId: completed.step.id,
        items: [{ questionText: "完成后也可以记" }],
      }),
    ).resolves.toMatchObject({
      items: [expect.objectContaining({ questionText: "完成后也可以记" })],
    });
  });

  it("rejects blank question text", async () => {
    const { applications, step } = await createInterviewStep();
    await expect(
      applications.saveInterviewReflection({
        applicationProcessStepId: step.id,
        items: [{ questionText: "   ", answerNotes: "只有回答" }],
      }),
    ).rejects.toMatchObject({
      code: "INTERVIEW_REFLECTION_QUESTION_REQUIRED",
    });
  });

  it("does not create InterviewDetail on a fully empty first save", async () => {
    const { applications, step } = await createInterviewStep();
    const saved = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "   ",
      items: [],
    });
    expect(saved).toEqual({
      applicationProcessStepId: step.id,
      reflectionText: null,
      items: [],
    });
    expect(await prisma.applicationInterviewDetail.count()).toBe(0);
  });

  it("clears reflection content without deleting InterviewDetail", async () => {
    const { applications, step } = await createInterviewStep();
    await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "整场复盘",
      items: [{ questionText: "问题 1", answerNotes: "要点" }],
    });
    const detail = await prisma.applicationInterviewDetail.findUniqueOrThrow({
      where: { applicationProcessStepId: step.id },
    });
    await prisma.applicationInterviewDetail.update({
      where: { id: detail.id },
      data: { interviewFormat: "ONSITE", roundLabel: "should-not-be-round-source" },
    });

    const cleared = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "   ",
      items: [],
    });
    expect(cleared).toEqual({
      applicationProcessStepId: step.id,
      reflectionText: null,
      items: [],
    });
    const remaining = await prisma.applicationInterviewDetail.findUniqueOrThrow({
      where: { id: detail.id },
    });
    expect(remaining.reflectionText).toBeNull();
    expect(remaining.interviewFormat).toBe("ONSITE");
    expect(remaining.roundLabel).toBe("should-not-be-round-source");
    expect(await prisma.applicationInterviewReflectionItem.count()).toBe(0);
  });
});

describe("interview reflection isolation", () => {
  it("does not change ProcessStep public facts or Attempt summary", async () => {
    const { applications, opportunity, step } = await createInterviewStep({
      scheduledAt: new Date("2026-10-08T00:00:00.000Z"),
      deadlineAt: new Date("2026-10-09T00:00:00.000Z"),
    });
    await applications.updateStage(
      (
        await prisma.applicationAttempt.findFirstOrThrow({
          where: { jobOpportunityId: opportunity.id },
        })
      ).id,
      ATTEMPT_STAGE.INTERVIEW,
    );
    await applications.recordOutcome(
      (
        await prisma.applicationAttempt.findFirstOrThrow({
          where: { jobOpportunityId: opportunity.id },
        })
      ).id,
      ATTEMPT_OUTCOME.ACTIVE,
    );
    const beforeTimeline = await applications.getTimeline(opportunity.id);
    const beforeStep = beforeTimeline.attempts[0].steps[0];
    const beforeAttempt = beforeTimeline.attempts[0];

    await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "整场复盘",
      items: [{ questionText: "介绍一下你的推荐系统项目", answerNotes: "讲了模型" }],
    });

    const afterTimeline = await applications.getTimeline(opportunity.id);
    const afterStep = afterTimeline.attempts[0].steps[0];
    const afterAttempt = afterTimeline.attempts[0];
    expect(afterStep).toEqual(beforeStep);
    expect(afterAttempt.currentStageCategory).toBe(beforeAttempt.currentStageCategory);
    expect(afterAttempt.outcome).toBe(beforeAttempt.outcome);
    expect(afterStep.notes).toBe("流程备注，不要进复盘");
    expect(afterStep.label).toBe("二面");
    expect(JSON.stringify(afterTimeline)).not.toContain("整场复盘");
    expect(JSON.stringify(afterTimeline)).not.toContain("介绍一下你的推荐系统项目");
  });

  it("does not change Upcoming attentionAt, scheduledAt, or deadlineAt", async () => {
    const { applications, step } = await createInterviewStep({
      scheduledAt: new Date("2026-10-08T00:00:00.000Z"),
      deadlineAt: new Date("2026-10-09T00:00:00.000Z"),
    });
    const before = await listUpcomingApplicationEvents(prisma, userId);
    const beforeEvent = before.find((event) => event.processStepId === step.id);
    expect(beforeEvent).toBeTruthy();

    await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "整场复盘",
      items: [{ questionText: "介绍一下你的推荐系统项目" }],
    });

    const after = await listUpcomingApplicationEvents(prisma, userId);
    const afterEvent = after.find((event) => event.processStepId === step.id);
    expect(afterEvent).toEqual(beforeEvent);
  });

  it("still cascades ProcessStep → InterviewDetail → ReflectionItems on USER delete", async () => {
    const { applications, step } = await createInterviewStep();
    const saved = await applications.saveInterviewReflection({
      applicationProcessStepId: step.id,
      reflectionText: "整场复盘",
      items: [{ questionText: "介绍一下你的推荐系统项目" }],
    });
    await applications.deleteUserProcessStep(step.id);
    expect(
      await prisma.applicationProcessStep.findUnique({ where: { id: step.id } }),
    ).toBeNull();
    expect(await prisma.applicationInterviewDetail.count()).toBe(0);
    expect(
      await prisma.applicationInterviewReflectionItem.findUnique({
        where: { id: saved.items[0].id },
      }),
    ).toBeNull();
  });
});

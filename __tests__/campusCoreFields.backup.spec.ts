// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { APP_CONSTANTS } from "@/lib/constants";
import { buildBackupZip } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import { BackupDataSchema } from "@/lib/backup/schema";
import { ATTEMPT_OUTCOME, ATTEMPT_STAGE } from "@/lib/career";
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
  userId = await seedAccount(prisma, "campus-backup@example.com");
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
  userId = await seedAccount(prisma, `campus-backup-${Date.now()}@example.com`);
});

describe("campus core fields backup contract", () => {
  it("keeps cohort, batch, TRANSFERRED, transfer relation, and deadlineAt", async () => {
    const parsed = BackupDataSchema.parse({
      JobOpportunity: [
        {
          id: "opp-1",
          companyId: "c1",
          campaignId: null,
          title: "软件工程师",
          normalizedTitle: null,
          locationText: null,
          employmentType: null,
          recruitmentType: null,
          workplaceType: null,
          sourceSystem: null,
          sourceLabel: null,
          sourceUrl: null,
          externalSourceKey: null,
          deadline: null,
          recruitmentCohort: "2027届",
          recruitmentBatch: "秋招",
          salaryText: null,
          status: "UNKNOWN",
          currentJdVersionId: null,
          sourceAutomationId: null,
          discoveredAt: null,
          closedAt: null,
          notes: null,
          archivedAt: null,
          createdVia: "USER",
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      ApplicationAttempt: [
        {
          id: "att-2",
          jobOpportunityId: "opp-2",
          channelCategory: null,
          channelLabel: "USER",
          sourceUrl: null,
          submittedAt: null,
          currentStageCategory: "DRAFT",
          outcome: "TRANSFERRED",
          transferredFromAttemptId: "att-1",
          submittedResumeVersionId: null,
          submittedResumeArtifactId: null,
          submittedAgainstJdVersionId: null,
          notes: null,
          createdVia: "TRANSFER",
          archivedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      ApplicationProcessStep: [
        {
          id: "step-1",
          applicationAttemptId: "att-1",
          category: "INTERVIEW",
          label: "一面",
          status: "PENDING",
          sortOrder: 10,
          scheduledAt: null,
          deadlineAt: new Date("2026-10-01T00:00:00.000Z"),
          completedAt: null,
          result: null,
          source: "USER",
          notes: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
    });
    expect(parsed.JobOpportunity[0]).toMatchObject({
      recruitmentCohort: "2027届",
      recruitmentBatch: "秋招",
    });
    expect(parsed.ApplicationAttempt[0]).toMatchObject({
      outcome: "TRANSFERRED",
      transferredFromAttemptId: "att-1",
    });
    expect(parsed.ApplicationProcessStep[0].deadlineAt?.toISOString()).toBe(
      "2026-10-01T00:00:00.000Z",
    );
  });

  it("round-trips cohort, batch, TRANSFERRED, transfer relation, and deadlineAt", async () => {
    const company = await prisma.company.create({
      data: {
        label: "Tencent",
        value: `tencent-backup-${Date.now()}`,
        createdBy: userId,
      },
    });
    const sourceOpp = await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: company.id,
        title: "软件工程师",
        recruitmentCohort: "2027届",
        recruitmentBatch: "秋招",
        deadline: new Date("2026-09-20T00:00:00.000Z"),
        status: "UNKNOWN",
      },
    });
    const targetOpp = await prisma.jobOpportunity.create({
      data: {
        userId,
        companyId: company.id,
        title: "云计算工程师",
        recruitmentCohort: "2027届",
        recruitmentBatch: "秋招",
        status: "UNKNOWN",
      },
    });
    const sourceAttempt = await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: sourceOpp.id,
        channelLabel: "USER",
        currentStageCategory: ATTEMPT_STAGE.SUBMITTED,
        outcome: ATTEMPT_OUTCOME.TRANSFERRED,
      },
    });
    const targetAttempt = await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: targetOpp.id,
        channelLabel: "USER",
        currentStageCategory: ATTEMPT_STAGE.DRAFT,
        outcome: ATTEMPT_OUTCOME.ACTIVE,
        transferredFromAttemptId: sourceAttempt.id,
        createdVia: "TRANSFER",
      },
    });
    const step = await prisma.applicationProcessStep.create({
      data: {
        applicationAttemptId: sourceAttempt.id,
        category: "INTERVIEW",
        label: "一面",
        sortOrder: 10,
        deadlineAt: new Date("2026-10-08T00:00:00.000Z"),
        source: "USER",
      },
    });

    const { buffer } = await buildBackupZip(userId, "campus-backup@example.com");
    const result = await importBackup(
      buffer,
      userId,
      "campus-backup@example.com",
      true,
    );
    expect(result.counts.JobOpportunity).toBe(2);
    expect(result.counts.ApplicationAttempt).toBe(2);

    const restoredSourceOpp = await prisma.jobOpportunity.findFirstOrThrow({
      where: { userId, title: "软件工程师" },
    });
    expect(restoredSourceOpp.recruitmentCohort).toBe("2027届");
    expect(restoredSourceOpp.recruitmentBatch).toBe("秋招");
    expect(restoredSourceOpp.deadline?.toISOString()).toBe(
      "2026-09-20T00:00:00.000Z",
    );
    const restoredTargetOpp = await prisma.jobOpportunity.findFirstOrThrow({
      where: { userId, title: "云计算工程师" },
    });
    const restoredSource = await prisma.applicationAttempt.findFirstOrThrow({
      where: { userId, jobOpportunityId: restoredSourceOpp.id },
    });
    expect(restoredSource.outcome).toBe(ATTEMPT_OUTCOME.TRANSFERRED);
    expect(restoredSource.id).not.toBe(sourceAttempt.id);
    const restoredTarget = await prisma.applicationAttempt.findFirstOrThrow({
      where: { userId, jobOpportunityId: restoredTargetOpp.id },
    });
    expect(restoredTarget.outcome).toBe(ATTEMPT_OUTCOME.ACTIVE);
    expect(restoredTarget.transferredFromAttemptId).toBe(restoredSource.id);
    expect(restoredTarget.id).not.toBe(targetAttempt.id);
    const restoredStep = await prisma.applicationProcessStep.findFirstOrThrow({
      where: { applicationAttemptId: restoredSource.id },
    });
    expect(restoredStep.deadlineAt?.toISOString()).toBe(
      "2026-10-08T00:00:00.000Z",
    );
    expect(restoredStep.id).not.toBe(step.id);
  }, 120_000);
});

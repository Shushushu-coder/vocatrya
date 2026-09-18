// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  copyMigrationBySuffix,
  INTERVIEW_REFLECTION_MIGRATION,
  makeAbTestDbUrl,
  migrateDeploy,
  preparePrismaProject,
} from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(
  REPO_ROOT,
  "prisma",
  "migrations",
  "20260918140000_add_interview_reflection_items",
);

describe("interview reflection migration", () => {
  it("is additive only", () => {
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
    expect(sql).toMatch(/ADD COLUMN\s+"reflectionText"/i);
    expect(sql).toMatch(/CREATE TABLE\s+"ApplicationInterviewReflectionItem"/i);
    expect(sql).toMatch(
      /CREATE INDEX\s+"ApplicationInterviewReflectionItem_applicationInterviewDetailId_sortOrder_idx"/i,
    );
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
    expect(sql).not.toMatch(/\bRENAME\b/i);
  });

  it("applies on disposable sqlite and leaves existing details with null reflection and no items", async () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir, {
      excludeSuffix: INTERVIEW_REFLECTION_MIGRATION,
    });
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schemaPath);
      const userId = await seedAccount(
        prisma,
        `interview-reflection-mig-${Date.now()}@example.com`,
      );
      const company = await prisma.company.create({
        data: {
          label: "Acme",
          value: `acme-interview-reflection-mig-${Date.now()}`,
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
        },
      });
      const step = await prisma.applicationProcessStep.create({
        data: {
          applicationAttemptId: attempt.id,
          category: "INTERVIEW",
          label: "二面",
          sortOrder: 10,
        },
      });
      const detailId = "detail-before-reflection-column";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ApplicationInterviewDetail" (
          "id", "applicationProcessStepId", "interviewFormat", "roundLabel",
          "locationText", "interviewerNames", "durationMinutes", "structuredData",
          "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        detailId,
        step.id,
        "ONSITE",
        "Hiring manager",
        "北京",
        "张三",
        45,
        JSON.stringify({ panel: 2 }),
        new Date().toISOString(),
        new Date().toISOString(),
      );

      copyMigrationBySuffix(ctx.dir, INTERVIEW_REFLECTION_MIGRATION);
      migrateDeploy(ctx.url, schemaPath);

      const detail = await prisma.applicationInterviewDetail.findUniqueOrThrow({
        where: { id: detailId },
      });
      expect(detail.reflectionText).toBeNull();
      expect(detail.interviewFormat).toBe("ONSITE");
      expect(detail.roundLabel).toBe("Hiring manager");
      expect(detail.locationText).toBe("北京");
      expect(detail.interviewerNames).toBe("张三");
      expect(detail.durationMinutes).toBe(45);
      expect(detail.structuredData).toBe(JSON.stringify({ panel: 2 }));
      expect(
        await prisma.applicationInterviewReflectionItem.count({
          where: { applicationInterviewDetailId: detailId },
        }),
      ).toBe(0);
    } finally {
      await prisma.$disconnect();
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  copyMigrationBySuffix,
  makeAbTestDbUrl,
  migrateDeploy,
  preparePrismaProject,
  PROCESS_STEP_DEADLINE_MIGRATION,
} from "./helpers/abSchemaTestDb";
import { seedAccount } from "./helpers/backupTestDb";

const REPO_ROOT = path.resolve(__dirname, "..");
const MIGRATION_DIR = path.join(
  REPO_ROOT,
  "prisma",
  "migrations",
  "20260918120000_add_process_step_deadline_at",
);

describe("ApplicationProcessStep.deadlineAt migration", () => {
  it("is additive only", () => {
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
    expect(sql).toMatch(/ADD COLUMN\s+"deadlineAt"/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
  });

  it("applies on disposable sqlite and leaves existing steps with null deadlineAt", async () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir, {
      excludeSuffix: PROCESS_STEP_DEADLINE_MIGRATION,
    });
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schemaPath);
      const userId = await seedAccount(prisma, `deadline-mig-${Date.now()}@example.com`);
      const company = await prisma.company.create({
        data: {
          label: "Acme",
          value: `acme-deadline-mig-${Date.now()}`,
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
      const stepId = "step-before-deadline-column";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ApplicationProcessStep" (
          "id", "applicationAttemptId", "category", "label", "status", "sortOrder",
          "scheduledAt", "completedAt", "result", "source", "notes", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        stepId,
        attempt.id,
        "INTERVIEW",
        "Hiring manager",
        "PENDING",
        10,
        null,
        null,
        null,
        "USER",
        null,
        new Date().toISOString(),
        new Date().toISOString(),
      );

      copyMigrationBySuffix(ctx.dir, PROCESS_STEP_DEADLINE_MIGRATION);
      migrateDeploy(ctx.url, schemaPath);

      const row = await prisma.applicationProcessStep.findUniqueOrThrow({
        where: { id: stepId },
      });
      expect(row.deadlineAt).toBeNull();
      expect(row.scheduledAt).toBeNull();
      expect(row.label).toBe("Hiring manager");
    } finally {
      await prisma.$disconnect();
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  CAMPUS_CORE_FIELDS_MIGRATION,
  copyMigrationBySuffix,
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
  "20260918130000_add_campus_core_fields",
);

describe("campus core fields migration", () => {
  it("is additive only", () => {
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
    expect(sql).toMatch(/ADD COLUMN\s+"recruitmentCohort"/i);
    expect(sql).toMatch(/ADD COLUMN\s+"recruitmentBatch"/i);
    expect(sql).toMatch(/ADD COLUMN\s+"transferredFromAttemptId"/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
    expect(sql).not.toMatch(/^\s*UPDATE\b/im);
    expect(sql).not.toMatch(/^\s*DELETE\b/im);
  });

  it("applies on disposable sqlite and leaves existing rows null", async () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir, {
      excludeSuffix: CAMPUS_CORE_FIELDS_MIGRATION,
    });
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schemaPath);
      const userId = await seedAccount(
        prisma,
        `campus-mig-${Date.now()}@example.com`,
      );
      const company = await prisma.company.create({
        data: {
          label: "Acme",
          value: `acme-campus-mig-${Date.now()}`,
          createdBy: userId,
        },
      });
      const opportunityId = "opp-before-campus-columns";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "JobOpportunity" (
          "id", "userId", "companyId", "title", "status", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        opportunityId,
        userId,
        company.id,
        "Engineer",
        "UNKNOWN",
        new Date().toISOString(),
        new Date().toISOString(),
      );
      const attemptId = "attempt-before-campus-columns";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ApplicationAttempt" (
          "id", "userId", "jobOpportunityId", "channelLabel",
          "currentStageCategory", "outcome", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        attemptId,
        userId,
        opportunityId,
        "USER",
        "DRAFT",
        "ACTIVE",
        new Date().toISOString(),
        new Date().toISOString(),
      );

      copyMigrationBySuffix(ctx.dir, CAMPUS_CORE_FIELDS_MIGRATION);
      migrateDeploy(ctx.url, schemaPath);

      const opportunity = await prisma.jobOpportunity.findUniqueOrThrow({
        where: { id: opportunityId },
      });
      expect(opportunity.recruitmentCohort).toBeNull();
      expect(opportunity.recruitmentBatch).toBeNull();
      const attempt = await prisma.applicationAttempt.findUniqueOrThrow({
        where: { id: attemptId },
      });
      expect(attempt.transferredFromAttemptId).toBeNull();
    } finally {
      await prisma.$disconnect();
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  }, 120_000);
});

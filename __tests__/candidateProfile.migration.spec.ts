// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  CANDIDATE_PROFILE_MIGRATION,
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
  "20260918150000_rename_resume_contact_profile_to_candidate_profile",
);

describe("candidate profile rename migration", () => {
  it("renames in place and does not drop the profile table", () => {
    const sql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
    expect(sql).toMatch(/ALTER TABLE\s+"ResumeContactProfile"\s+RENAME TO\s+"CandidateProfile"/i);
    expect(sql).not.toMatch(/DROP TABLE\s+"ResumeContactProfile"/i);
    expect(sql).not.toMatch(/DROP TABLE\s+"CandidateProfile"/i);
    expect(sql).toMatch(/CREATE TABLE\s+"CandidateSensitiveInfo"/i);
    expect(sql).toMatch(/CREATE TABLE\s+"CandidateFamilyMember"/i);
    expect(sql).toMatch(/ADD COLUMN\s+"gpaValue"/i);
    expect(sql).toMatch(/ADD COLUMN\s+"rankText"/i);
  });

  it("preserves existing ResumeContactProfile rows and values", async () => {
    const ctx = makeAbTestDbUrl();
    const schemaPath = preparePrismaProject(ctx.dir, {
      excludeSuffix: CANDIDATE_PROFILE_MIGRATION,
    });
    const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
    try {
      migrateDeploy(ctx.url, schemaPath);
      const userId = await seedAccount(
        prisma,
        `candidate-profile-mig-${Date.now()}@example.com`,
      );
      const profileId = "profile-before-rename";
      const createdAt = "2026-01-02 03:04:05";
      const updatedAt = "2026-01-03 04:05:06";
      await prisma.$executeRawUnsafe(
        `INSERT INTO "ResumeContactProfile" (
          "id", "userId", "fullName", "headline", "email", "phone", "address",
          "linksData", "extraData", "createdAt", "updatedAt"
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        profileId,
        userId,
        "Fixture Full Name",
        "Fixture Headline",
        "fixture-profile@example.com",
        "010-0000-0000",
        "Fixture Address",
        '{"url":"https://example.test"}',
        '{"note":"fixture-extra"}',
        createdAt,
        updatedAt,
      );

      const before = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*) as n FROM "ResumeContactProfile"`,
      );

      copyMigrationBySuffix(ctx.dir, CANDIDATE_PROFILE_MIGRATION);
      migrateDeploy(ctx.url, schemaPath);

      const after = await prisma.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT COUNT(*) as n FROM "CandidateProfile"`,
      );
      expect(Number(after[0].n)).toBe(Number(before[0].n));
      expect(Number(after[0].n)).toBeGreaterThan(0);

      const rows = await prisma.$queryRawUnsafe<
        Array<{
          id: string;
          userId: string;
          fullName: string | null;
          headline: string | null;
          email: string | null;
          phone: string | null;
          address: string | null;
          linksData: string | null;
          extraData: string | null;
          gender: string | null;
          gpaValue?: number | null;
        }>
      >(
        `SELECT "id", "userId", "fullName", "headline", "email", "phone", "address",
                "linksData", "extraData", "gender"
         FROM "CandidateProfile" WHERE "id" = ?`,
        profileId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: profileId,
        userId,
        fullName: "Fixture Full Name",
        headline: "Fixture Headline",
        email: "fixture-profile@example.com",
        phone: "010-0000-0000",
        address: "Fixture Address",
        linksData: '{"url":"https://example.test"}',
        extraData: '{"note":"fixture-extra"}',
        gender: null,
      });

      const oldTables = await prisma.$queryRawUnsafe<Array<{ name: string }>>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ResumeContactProfile'`,
      );
      expect(oldTables).toEqual([]);
    } finally {
      await prisma.$disconnect();
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  }, 120_000);
});

// @vitest-environment node
// LOCAL / MANUAL / ENVIRONMENT-SENSITIVE smoke.
//
// Reads the current machine's prisma/dev.db and assumes a pristine
// NOT_STARTED development instance. This is not isolated automated
// coverage. Isolated contracts live in:
//   __tests__/freshActivation.phase7.spec.ts
//   __tests__/careerRuntime.phase5.spec.ts
//   __tests__/careerRuntime.phase7.spec.ts
//   __tests__/backupFreshNative.phase7.spec.ts
//
// Default `vitest run` skips this file.
// Opt in (read-only; does not write prisma/dev.db):
//   VOCATRYA_RUN_LOCAL_DB_SMOKE=1 npx vitest run __tests__/freshDb.localSmoke.spec.ts
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  AB_MIGRATION_STATUS,
  CAREER_RUNTIME_MODE,
  resolveCareerRuntimeMode,
} from "@/lib/career";

const RUN_LOCAL_DB_SMOKE = process.env.VOCATRYA_RUN_LOCAL_DB_SMOKE === "1";
const localDevDb = path.resolve(process.cwd(), "prisma", "dev.db");
const url = `file:${localDevDb.replace(/\\/g, "/")}`;

describe.skipIf(!RUN_LOCAL_DB_SMOKE)(
  "fresh local development database (opt-in local smoke)",
  () => {
    it("starts as NOT_STARTED / LEGACY_ONLY with empty A+B residue", async () => {
      const prisma = new PrismaClient({ datasources: { db: { url } } });
      try {
        await prisma.$queryRaw`SELECT 1`;

        const migrations = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT COUNT(*) as n FROM "_prisma_migrations"
        `;
        expect(Number(migrations[0]?.n ?? 0)).toBe(41);

        const tables = await prisma.$queryRaw<Array<{ name: string }>>`
          SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
        `;
        const names = tables.map((t) => t.name);
        for (const required of [
          "Job",
          "Resume",
          "JobOpportunity",
          "ApplicationAttempt",
          "JobDescriptionVersion",
          "CareerMaterialItem",
          "ResumeVariant",
          "ResumeVariantVersion",
          "AbMigrationState",
          "LegacyMigrationMap",
          "DataMigrationRun",
        ]) {
          expect(names).toContain(required);
        }

        expect(await prisma.abMigrationState.count()).toBe(0);
        expect(await prisma.legacyMigrationMap.count()).toBe(0);
        expect(await prisma.dataMigrationRun.count()).toBe(0);
        expect(await prisma.jobOpportunity.count()).toBe(0);
        expect(await prisma.applicationAttempt.count()).toBe(0);
        expect(await prisma.resumeVariant.count()).toBe(0);
        expect(await prisma.careerMaterialItem.count()).toBe(0);
        expect(await prisma.job.count()).toBe(0);
        expect(await prisma.resume.count()).toBe(0);

        const resolved = await resolveCareerRuntimeMode(prisma, {
          env: { ...process.env, VOCATRYA_AB_RUNTIME_ENABLED: "" },
        });
        expect(resolved.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
        expect(resolved.migrationStatus).toBe(AB_MIGRATION_STATUS.NOT_STARTED);
        expect(resolved.mode).not.toBe(CAREER_RUNTIME_MODE.AB_ENABLED);

        const flagged = await resolveCareerRuntimeMode(prisma, {
          env: { ...process.env, VOCATRYA_AB_RUNTIME_ENABLED: "true", VOCATRYA_AB_ROLLOUT_SCOPE: "full" },
        });
        expect(flagged.mode).not.toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
        expect(flagged.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
      } finally {
        await prisma.$disconnect();
      }
    });
  },
);

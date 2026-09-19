// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ApplicationService,
  CareerRuntimeError,
  OpportunityService,
  RESUME_VARIANT_VERSION_DIRECT_WRITE_RE,
  RESUME_VARIANT_VERSION_WRITE_ALLOWLIST,
  RESUME_VERSION_STATUS,
  ResumeVariantService,
  writeInstanceMigrationState,
} from "@/lib/career";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };
const SRC_ROOT = path.resolve(__dirname, "..", "src");
const REPO_ROOT = path.resolve(__dirname, "..");

function listSourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) return [];
    return [full];
  });
}

function relativePosix(file: string): string {
  return path.relative(REPO_ROOT, file).split(path.sep).join("/");
}

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
  userId = await seedAccount(prisma, `write-boundary-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-wb-${Date.now()}`, createdBy: userId },
    })
  ).id;
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
});

function variants() {
  return new ResumeVariantService(prisma, userId, FEATURE_ON);
}

describe("ResumeVariantVersion write-surface architecture guard", () => {
  it("flags direct Prisma writes in a sample source fragment", () => {
    const sample = `
      await prisma.resumeVariantVersion.update({ where: { id }, data: {} });
      await tx.resumeVariantVersion.deleteMany({ where: { id } });
    `;
    const hits = [...sample.matchAll(new RegExp(RESUME_VARIANT_VERSION_DIRECT_WRITE_RE, "g"))];
    expect(hits.map((hit) => hit[1])).toEqual(["update", "deleteMany"]);
  });

  it("allows only the explicit production write allowlist under src/", () => {
    const allow = new Set<string>(RESUME_VARIANT_VERSION_WRITE_ALLOWLIST);
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const rel = relativePosix(file);
      const source = fs.readFileSync(file, "utf8");
      if (!RESUME_VARIANT_VERSION_DIRECT_WRITE_RE.test(source)) continue;
      if (!allow.has(rel)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist small and present", () => {
    expect([...RESUME_VARIANT_VERSION_WRITE_ALLOWLIST]).toEqual([
      "src/lib/career/resumeVariantService.ts",
      "src/lib/legacy-migration/migrator.ts",
    ]);
    for (const rel of RESUME_VARIANT_VERSION_WRITE_ALLOWLIST) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel))).toBe(true);
    }
  });
});

describe("ResumeVariantVersion immutable write boundary", () => {
  it("updates DRAFT in place and rejects FROZEN/SUBMITTED/ARCHIVED in-place edits", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    const draftId = variant.currentVersionId!;

    const edited = await service.updateDraft(draftId, { locale: "en" });
    expect(edited.locale).toBe("en");
    expect(edited.id).toBe(draftId);

    const frozen = await service.freeze(draftId);
    expect(frozen.status).toBe(RESUME_VERSION_STATUS.FROZEN);
    await expect(
      service.updateDraft(draftId, { locale: "zh" }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });

    const fromFrozen = await service.editVersion(draftId, { locale: "zh" });
    expect(fromFrozen.id).not.toBe(draftId);
    expect(fromFrozen.status).toBe(RESUME_VERSION_STATUS.DRAFT);
    expect(fromFrozen.parentVersionId).toBe(draftId);
    const frozenAfter = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: draftId },
    });
    expect(frozenAfter.locale).toBe("en");
    expect(frozenAfter.status).toBe(RESUME_VERSION_STATUS.FROZEN);

    const submitted = await service.markSubmitted(fromFrozen.id);
    expect(submitted.status).toBe(RESUME_VERSION_STATUS.SUBMITTED);
    await expect(
      service.updateDraft(fromFrozen.id, { locale: "ja" }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    const fromSubmitted = await service.editVersion(fromFrozen.id, { locale: "ja" });
    expect(fromSubmitted.id).not.toBe(fromFrozen.id);
    expect(fromSubmitted.status).toBe(RESUME_VERSION_STATUS.DRAFT);
    const submittedAfter = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: fromFrozen.id },
    });
    expect(submittedAfter.locale).toBe("zh");
    expect(submittedAfter.status).toBe(RESUME_VERSION_STATUS.SUBMITTED);

    await prisma.resumeVariantVersion.update({
      where: { id: fromSubmitted.id },
      data: { status: RESUME_VERSION_STATUS.ARCHIVED },
    });
    await expect(
      service.updateDraft(fromSubmitted.id, { locale: "fr" }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    const fromArchived = await service.editVersion(fromSubmitted.id, { locale: "fr" });
    expect(fromArchived.id).not.toBe(fromSubmitted.id);
    expect(fromArchived.status).toBe(RESUME_VERSION_STATUS.DRAFT);
    const archivedAfter = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: fromSubmitted.id },
    });
    expect(archivedAfter.status).toBe(RESUME_VERSION_STATUS.ARCHIVED);
    expect(archivedAfter.locale).toBe("ja");
  });

  it("refuses in-place overwrite of a submitted-resume reference", async () => {
    const service = variants();
    const applications = new ApplicationService(prisma, userId, FEATURE_ON);
    const opportunities = new OpportunityService(prisma, userId, FEATURE_ON);
    const opportunity = await opportunities.create({
      companyId,
      title: "Staff Engineer",
    });
    const variant = await service.createVariant({ name: "General" });
    const draftId = variant.currentVersionId!;
    await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers",
    });
    await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: opportunity.id,
        channelLabel: "Direct",
        submittedResumeVersionId: draftId,
      },
    });

    await expect(
      service.updateDraft(draftId, { locale: "en-GB" }),
    ).rejects.toMatchObject({ code: "SUBMITTED_RESUME_PROVENANCE" });

    const cloned = await service.editVersion(draftId, { locale: "en-GB" });
    expect(cloned.id).not.toBe(draftId);
    expect(cloned.status).toBe(RESUME_VERSION_STATUS.DRAFT);
    const original = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: draftId },
    });
    expect(original.locale).toBeNull();
  });

  it("surfaces CareerRuntimeError rather than mutating FROZEN through updateDraft", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    const id = variant.currentVersionId!;
    await service.freeze(id);
    try {
      await service.updateDraft(id, { headerSnapshot: "{}" });
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(CareerRuntimeError);
    }
  });
});

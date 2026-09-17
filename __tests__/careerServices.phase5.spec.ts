// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  CareerMaterialService,
  CareerRuntimeError,
  OpportunityService,
  ResumeVariantService,
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
  userId = await seedAccount(prisma, `phase5-svc-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-svc-${Date.now()}`, createdBy: userId },
    })
  ).id;
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
});

function services() {
  return {
    opportunities: new OpportunityService(prisma, userId, FEATURE_ON),
    applications: new ApplicationService(prisma, userId, FEATURE_ON),
    variants: new ResumeVariantService(prisma, userId, FEATURE_ON),
    materials: new CareerMaterialService(prisma, userId, FEATURE_ON),
  };
}

describe("Phase 5 A+B services", () => {
  it("writes and reads opportunities without process outcomes as status", async () => {
    const { opportunities } = services();
    const created = await opportunities.create({
      companyId,
      title: "Staff Engineer",
      locationText: "Remote",
    });
    expect(created.status).toBe("UNKNOWN");
    const listed = await opportunities.list();
    expect(listed.map((row) => row.id)).toEqual([created.id]);
    const updated = await opportunities.updateSafe(created.id, {
      status: "ACTIVE",
      salaryText: "200k",
    });
    expect(updated.status).toBe("ACTIVE");
    expect(updated.salaryText).toBe("200k");
    await expect(
      opportunities.updateSafe(created.id, { status: "INTERVIEW" }),
    ).rejects.toBeInstanceOf(CareerRuntimeError);
    expect((await opportunities.get(created.id))?.status).toBe("ACTIVE");
  });

  it("supports multiple attempts and submitted resume provenance", async () => {
    const { opportunities, applications, variants } = services();
    const opportunity = await opportunities.create({
      companyId,
      title: "Staff Engineer",
    });
    const variant = await variants.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;

    const first = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers page",
    });
    const second = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Referral",
    });
    expect(first.id).not.toBe(second.id);

    const submitted = await applications.markSubmitted({
      attemptId: first.id,
      submittedResumeVersionId: versionId,
    });
    expect(submitted.submittedResumeVersionId).toBe(versionId);
    expect(submitted.currentStageCategory).toBe("SUBMITTED");

    await expect(
      applications.markSubmitted({
        attemptId: first.id,
        submittedResumeVersionId: "different-version",
      }),
    ).rejects.toMatchObject({ code: "SUBMITTED_RESUME_PROVENANCE" });
    const reread = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(reread.submittedResumeVersionId).toBe(versionId);

    await applications.updateStage(second.id, "SCREENING");
    await applications.recordOutcome(second.id, "REJECTED");
    const step = await applications.upsertProcessStep({
      attemptId: first.id,
      category: "INTERVIEW",
      label: "Hiring manager",
      sortOrder: 10,
    });
    expect(step.category).toBe("INTERVIEW");
    expect(opportunity.status).not.toBe("INTERVIEW");
  });

  it("enforces DRAFT mutability and FROZEN/SUBMITTED immutability", async () => {
    const { variants } = services();
    const variant = await variants.createVariant({ name: "General" });
    const draftId = variant.currentVersionId!;

    const edited = await variants.updateDraft(draftId, {
      headerSnapshot: JSON.stringify({ name: "Ada" }),
    });
    expect(edited.headerSnapshot).toContain("Ada");

    const frozen = await variants.freeze(draftId);
    expect(frozen.status).toBe("FROZEN");
    await expect(
      variants.updateDraft(draftId, { locale: "en" }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });

    const next = await variants.editVersion(draftId, {
      headerSnapshot: JSON.stringify({ name: "Ada Lovelace" }),
    });
    expect(next.id).not.toBe(draftId);
    expect(next.status).toBe("DRAFT");
    expect(next.parentVersionId).toBe(draftId);
    expect(next.headerSnapshot).toContain("Ada Lovelace");

    const original = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: draftId },
    });
    expect(original.status).toBe("FROZEN");
    expect(original.headerSnapshot).toContain("Ada");

    const submitted = await variants.markSubmitted(next.id);
    expect(submitted.status).toBe("SUBMITTED");
    await expect(
      variants.updateDraft(next.id, { locale: "zh" }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    const fromSubmitted = await variants.editVersion(next.id, { locale: "zh-CN" });
    expect(fromSubmitted.id).not.toBe(next.id);
    expect(fromSubmitted.status).toBe("DRAFT");
  });

  it("keeps career material facts separate from resume expression text", async () => {
    const { materials, variants } = services();
    const item = await materials.create({
      type: "EMPLOYMENT",
      title: "Engineer",
      detail: { roleTitle: "Engineer", organizationName: "Acme" },
    });
    expect(item.type).toBe("EMPLOYMENT");
    expect(item.origin).toBe("USER");

    const variant = await variants.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;
    const section = await prisma.resumeVariantSection.create({
      data: {
        resumeVariantVersionId: versionId,
        title: "Experience",
        sortOrder: 0,
      },
    });
    const sectionItem = await prisma.resumeVariantSectionItem.create({
      data: {
        resumeVariantSectionId: section.id,
        careerMaterialItemId: item.id,
        itemKind: "EXPERIENCE",
        sortOrder: 0,
      },
    });
    const expression = await prisma.resumeExpression.create({
      data: {
        resumeVariantSectionItemId: sectionItem.id,
        kind: "BULLET",
        content: "Wrote compilers.",
        sortOrder: 0,
      },
    });

    await materials.update({
      id: item.id,
      title: "Senior Engineer",
      detail: { roleTitle: "Senior Engineer" },
    });
    await materials.confirm(item.id);
    await materials.addEvidence({
      materialItemId: item.id,
      kind: "METRIC",
      content: "Shipped 3 compilers",
    });

    const fact = await prisma.careerMaterialItem.findUniqueOrThrow({
      where: { id: item.id },
      include: { employmentDetail: true, evidence: true },
    });
    expect(fact.title).toBe("Senior Engineer");
    expect(fact.verificationStatus).toBe("USER_CONFIRMED");
    expect(fact.employmentDetail?.roleTitle).toBe("Senior Engineer");
    expect(fact.evidence).toHaveLength(1);

    const expressionAfter = await prisma.resumeExpression.findUniqueOrThrow({
      where: { id: expression.id },
    });
    expect(expressionAfter.content).toBe("Wrote compilers.");
  });
});

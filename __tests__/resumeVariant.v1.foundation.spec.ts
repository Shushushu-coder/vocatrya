// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  CareerMaterialService,
  CareerRuntimeError,
  EVIDENCE_STATUS,
  OpportunityService,
  RESUME_EXPRESSION_KIND,
  RESUME_SECTION_ITEM_KIND,
  RESUME_VERSION_STATUS,
  ResumeProvenanceService,
  ResumeVariantService,
  VERSION_NUMBER_UNIQUE_RETRY,
  buildResumeHeaderSnapshot,
  parseResumeHeaderSnapshot,
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
  userId = await seedAccount(prisma, `rv1-${Date.now()}@example.com`);
  otherUserId = await seedAccount(prisma, `rv1-other-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-rv1-${Date.now()}`, createdBy: userId },
    })
  ).id;
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
});

function variants(owner = userId) {
  return new ResumeVariantService(prisma, owner, FEATURE_ON);
}

function materials(owner = userId) {
  return new CareerMaterialService(prisma, owner, FEATURE_ON);
}

function provenance(owner = userId) {
  return new ResumeProvenanceService(prisma, owner, FEATURE_ON);
}

async function seedGraph(owner = userId) {
  const service = variants(owner);
  const created = await service.createVariant({ name: "General" });
  const versionId = created.currentVersionId!;
  const section = await service.createSection({
    versionId,
    title: "Experience",
  });
  const item = await service.createSectionItem({
    sectionId: section.id,
    itemKind: RESUME_SECTION_ITEM_KIND.MANUAL,
  });
  const expression = await service.createExpression({
    itemId: item.id,
    content: "Shipped compilers.",
    kind: RESUME_EXPRESSION_KIND.BULLET,
  });
  return { service, variant: created, versionId, section, item, expression };
}

describe("Resume Variant V1 list/rename/archive/versions", () => {
  it("lists owned non-archived summaries without the section graph", async () => {
    const service = variants();
    const first = await service.createVariant({ name: "Alpha" });
    await service.createSection({
      versionId: first.currentVersionId!,
      title: "Hidden from list",
    });
    await service.createVariant({ name: "Beta" });
    await service.archiveVariant(
      (await service.createVariant({ name: "Archived" })).id,
    );

    const list = await service.listVariants();
    expect(list.map((row) => row.name)).toEqual(["Beta", "Alpha"]);
    expect(list[0]).not.toHaveProperty("sections");
    expect(list[0].currentVersion?.status).toBe(RESUME_VERSION_STATUS.DRAFT);
    expect(list.every((row) => row.archivedAt == null)).toBe(true);
  });

  it("renames with trim and rejects empty or archived names without touching versions", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    const before = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: variant.currentVersionId! },
    });
    const renamed = await service.renameVariant(variant.id, "  Campus  ");
    expect(renamed.name).toBe("Campus");
    const after = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: variant.currentVersionId! },
    });
    expect(after.headerSnapshot).toBe(before.headerSnapshot);
    expect(after.locale).toBe(before.locale);
    expect(after.status).toBe(before.status);
    expect(after.versionNumber).toBe(before.versionNumber);

    await expect(service.renameVariant(variant.id, "   ")).rejects.toMatchObject({
      code: "VARIANT_NAME_REQUIRED",
    });
    await service.archiveVariant(variant.id);
    await expect(service.renameVariant(variant.id, "Later")).rejects.toMatchObject({
      code: "VARIANT_ARCHIVED",
    });
  });

  it("archives without deleting versions and keeps submitted attempt references", async () => {
    const service = variants();
    const applications = new ApplicationService(prisma, userId, FEATURE_ON);
    const opportunities = new OpportunityService(prisma, userId, FEATURE_ON);
    const opportunity = await opportunities.create({
      companyId,
      title: "Staff Engineer",
    });
    const variant = await service.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers",
    });
    await applications.markSubmitted({
      attemptId: attempt.id,
      submittedResumeVersionId: versionId,
    });

    const archived = await service.archiveVariant(variant.id);
    expect(archived.archivedAt).not.toBeNull();
    expect(await prisma.resumeVariantVersion.count({ where: { resumeVariantId: variant.id } })).toBe(1);
    expect(
      (await prisma.applicationAttempt.findUniqueOrThrow({ where: { id: attempt.id } }))
        .submittedResumeVersionId,
    ).toBe(versionId);
    expect(await service.listVariants()).toEqual([]);
    const versions = await service.listVariantVersions(variant.id);
    expect(versions[0]?.id).toBe(versionId);
    expect(versions[0]?.currentVersion).toBe(true);
  });

  it("createBlankDraft rejects an editable current draft and allocates after freeze", async () => {
    expect(VERSION_NUMBER_UNIQUE_RETRY).toBe(1);
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    await expect(service.createBlankDraft(variant.id)).rejects.toMatchObject({
      code: "DRAFT_ALREADY_EXISTS",
    });
    await service.freeze(variant.currentVersionId!);
    const blank = await service.createBlankDraft(variant.id);
    expect(blank.status).toBe(RESUME_VERSION_STATUS.DRAFT);
    expect(blank.versionNumber).toBe(2);
    expect(blank.parentVersionId).toBeNull();
    const graph = await service.getVersion(blank.id);
    expect(graph.sections).toEqual([]);
    const current = await prisma.resumeVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(current.currentVersionId).toBe(blank.id);
  });
});

describe("Resume Variant V1 structure CRUD", () => {
  it("creates, updates, deletes, and reorders sections with contiguous sortOrder", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;
    const a = await service.createSection({ versionId, title: "A" });
    const b = await service.createSection({ versionId, title: "B" });
    const c = await service.createSection({ versionId, title: "C" });
    expect([a.sortOrder, b.sortOrder, c.sortOrder]).toEqual([0, 1, 2]);

    await service.updateSection({ sectionId: b.id, title: "Experience" });
    const reordered = await service.reorderSections(versionId, [c.id, a.id, b.id]);
    expect(reordered.map((row) => row.id)).toEqual([c.id, a.id, b.id]);
    expect(reordered.map((row) => row.sortOrder)).toEqual([0, 1, 2]);

    await expect(
      service.reorderSections(versionId, [a.id, a.id, b.id]),
    ).rejects.toMatchObject({ code: "REORDER_INVALID" });
    await expect(
      service.reorderSections(versionId, [a.id, b.id]),
    ).rejects.toMatchObject({ code: "REORDER_INVALID" });

    await service.deleteSection(c.id);
    expect(
      await prisma.resumeVariantSection.count({ where: { resumeVariantVersionId: versionId } }),
    ).toBe(2);
  });

  it("supports manual items and owned material selection with duplicate protection", async () => {
    const service = variants();
    const material = await materials().create({
      type: "PROJECT",
      title: "Compiler",
    });
    const archived = await materials().create({ type: "SKILL", title: "Rust" });
    await materials().archive(archived.id);
    const foreign = await materials(otherUserId).create({
      type: "PROJECT",
      title: "Theirs",
    });

    const variant = await service.createVariant({ name: "General" });
    const section = await service.createSection({
      versionId: variant.currentVersionId!,
      title: "Projects",
    });
    const linked = await service.createSectionItem({
      sectionId: section.id,
      careerMaterialItemId: material.id,
    });
    expect(linked.itemKind).toBe("PROJECT");
    const manual = await service.createSectionItem({ sectionId: section.id });
    expect(manual.careerMaterialItemId).toBeNull();
    expect(manual.itemKind).toBe(RESUME_SECTION_ITEM_KIND.MANUAL);

    await expect(
      service.createSectionItem({
        sectionId: section.id,
        careerMaterialItemId: material.id,
      }),
    ).rejects.toMatchObject({ code: "MATERIAL_ALREADY_IN_SECTION" });
    await expect(
      service.createSectionItem({
        sectionId: section.id,
        careerMaterialItemId: foreign.id,
      }),
    ).rejects.toMatchObject({ code: "MATERIAL_NOT_FOUND" });
    await expect(
      service.createSectionItem({
        sectionId: section.id,
        careerMaterialItemId: archived.id,
      }),
    ).rejects.toMatchObject({ code: "MATERIAL_ARCHIVED" });

    const otherSection = await service.createSection({
      versionId: variant.currentVersionId!,
      title: "Also projects",
    });
    const reused = await service.createSectionItem({
      sectionId: otherSection.id,
      careerMaterialItemId: material.id,
    });
    expect(reused.careerMaterialItemId).toBe(material.id);

    const materialAfter = await prisma.careerMaterialItem.findUniqueOrThrow({
      where: { id: material.id },
    });
    expect(materialAfter.title).toBe("Compiler");
  });

  it("reorders items and expressions and validates expression content/kind", async () => {
    const { service, item, expression } = await seedGraph();
    const second = await service.createExpression({
      itemId: item.id,
      content: "Mentored two engineers.",
    });
    const third = await service.createExpression({
      itemId: item.id,
      content: "Wrote docs.",
    });
    const expressions = await service.reorderExpressions(item.id, [
      third.id,
      expression.id,
      second.id,
    ]);
    expect(expressions.map((row) => row.id)).toEqual([third.id, expression.id, second.id]);
    expect(expressions.map((row) => row.sortOrder)).toEqual([0, 1, 2]);

    await expect(
      service.createExpression({ itemId: item.id, content: "   " }),
    ).rejects.toMatchObject({ code: "EXPRESSION_CONTENT_REQUIRED" });
    await expect(
      service.createExpression({
        itemId: item.id,
        content: "Nope",
        kind: "POETRY",
      }),
    ).rejects.toMatchObject({ code: "INVALID_EXPRESSION_KIND" });
    await expect(
      service.updateExpression({
        expressionId: second.id,
        evidenceStatus: EVIDENCE_STATUS.LINKED,
      } as never),
    ).resolves.toMatchObject({ evidenceStatus: EVIDENCE_STATUS.UNLINKED });
  });

  it("rejects incomplete or foreign reorder lists for items", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    const sectionA = await service.createSection({
      versionId: variant.currentVersionId!,
      title: "A",
    });
    const sectionB = await service.createSection({
      versionId: variant.currentVersionId!,
      title: "B",
    });
    const a1 = await service.createSectionItem({ sectionId: sectionA.id });
    const a2 = await service.createSectionItem({ sectionId: sectionA.id });
    const a3 = await service.createSectionItem({ sectionId: sectionA.id });
    const b1 = await service.createSectionItem({ sectionId: sectionB.id });

    await expect(
      service.reorderSectionItems(sectionA.id, [a1.id, a2.id, b1.id]),
    ).rejects.toMatchObject({ code: "REORDER_INVALID" });
    await expect(
      service.reorderSectionItems(sectionA.id, [a3.id, a1.id]),
    ).rejects.toMatchObject({ code: "REORDER_INVALID" });

    const reordered = await service.reorderSectionItems(sectionA.id, [
      a3.id,
      a1.id,
      a2.id,
    ]);
    expect(reordered.map((row) => row.id)).toEqual([a3.id, a1.id, a2.id]);
    expect(reordered.map((row) => row.sortOrder)).toEqual([0, 1, 2]);
  });
});

describe("Resume Variant V1 ownership and immutability", () => {
  it("denies cross-user mutations and leaves the database unchanged", async () => {
    const owned = await seedGraph(userId);
    const other = variants(otherUserId);
    const before = await prisma.resumeVariant.findUniqueOrThrow({
      where: { id: owned.variant.id },
    });

    await expect(other.getVariant(owned.variant.id)).rejects.toMatchObject({
      code: "VARIANT_NOT_FOUND",
    });
    await expect(other.renameVariant(owned.variant.id, "Stolen")).rejects.toMatchObject({
      code: "VARIANT_NOT_FOUND",
    });
    await expect(other.archiveVariant(owned.variant.id)).rejects.toMatchObject({
      code: "VARIANT_NOT_FOUND",
    });
    await expect(other.getVersion(owned.versionId)).rejects.toMatchObject({
      code: "VERSION_NOT_FOUND",
    });
    await expect(
      other.createSection({ versionId: owned.versionId, title: "Nope" }),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    await expect(
      other.updateSection({ sectionId: owned.section.id, title: "Nope" }),
    ).rejects.toMatchObject({ code: "SECTION_NOT_FOUND" });
    await expect(other.deleteSection(owned.section.id)).rejects.toMatchObject({
      code: "SECTION_NOT_FOUND",
    });
    await expect(
      other.createSectionItem({ sectionId: owned.section.id }),
    ).rejects.toMatchObject({ code: "SECTION_NOT_FOUND" });
    await expect(other.deleteSectionItem(owned.item.id)).rejects.toMatchObject({
      code: "ITEM_NOT_FOUND",
    });
    await expect(
      other.createExpression({ itemId: owned.item.id, content: "Nope" }),
    ).rejects.toMatchObject({ code: "ITEM_NOT_FOUND" });
    await expect(
      other.updateExpression({
        expressionId: owned.expression.id,
        content: "Nope",
      }),
    ).rejects.toMatchObject({ code: "EXPRESSION_NOT_FOUND" });
    await expect(other.deleteExpression(owned.expression.id)).rejects.toMatchObject({
      code: "EXPRESSION_NOT_FOUND" });
    await expect(
      other.reorderSections(owned.versionId, [owned.section.id]),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    await expect(other.cloneAsDraft(owned.versionId)).rejects.toMatchObject({
      code: "VERSION_NOT_FOUND",
    });
    await expect(other.freeze(owned.versionId)).rejects.toMatchObject({
      code: "VERSION_NOT_FOUND",
    });

    const after = await prisma.resumeVariant.findUniqueOrThrow({
      where: { id: owned.variant.id },
    });
    expect(after.name).toBe(before.name);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
  });

  it("rejects cross-version injection even for the same owner", async () => {
    const service = variants();
    const first = await service.createVariant({ name: "A" });
    const second = await service.createVariant({ name: "B" });
    const sectionA = await service.createSection({
      versionId: first.currentVersionId!,
      title: "A",
    });
    const sectionB = await service.createSection({
      versionId: second.currentVersionId!,
      title: "B",
    });
    const itemB = await service.createSectionItem({ sectionId: sectionB.id });

    await expect(
      service.reorderSections(first.currentVersionId!, [sectionB.id]),
    ).rejects.toMatchObject({ code: "REORDER_INVALID" });
    await expect(
      service.reorderSectionItems(sectionA.id, [itemB.id]),
    ).rejects.toMatchObject({ code: "REORDER_INVALID" });
  });

  it("freezes and submitted references block structural mutation; clone stays byte-identical", async () => {
    const { service, variant, versionId, section, item, expression } = await seedGraph();
    const frozen = await service.freeze(versionId);
    expect(frozen.status).toBe(RESUME_VERSION_STATUS.FROZEN);

    await expect(
      service.createSection({ versionId, title: "Later" }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    await expect(
      service.updateSection({ sectionId: section.id, title: "Later" }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    await expect(service.deleteSection(section.id)).rejects.toMatchObject({
      code: "VERSION_IMMUTABLE",
    });
    await expect(
      service.createSectionItem({ sectionId: section.id }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    await expect(
      service.updateExpression({
        expressionId: expression.id,
        content: "Changed",
      }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });

    const original = await service.getVersion(versionId);
    const cloned = await service.cloneAsDraft(versionId);
    expect(cloned.id).not.toBe(versionId);
    expect(cloned.status).toBe(RESUME_VERSION_STATUS.DRAFT);
    expect(cloned.parentVersionId).toBe(versionId);

    const cloneGraph = await service.getVersion(cloned.id);
    await service.updateSection({
      sectionId: cloneGraph.sections[0]!.id,
      title: "Edited clone",
    });
    const frozenAfter = await service.getVersion(versionId);
    expect(frozenAfter.sections[0]!.title).toBe(original.sections[0]!.title);
    expect(frozenAfter.sections[0]!.items[0]!.expressions[0]!.content).toBe(
      original.sections[0]!.items[0]!.expressions[0]!.content,
    );
    expect(item.id).toBe(original.sections[0]!.items[0]!.id);

    const submitted = await service.markSubmitted(cloned.id);
    await expect(
      service.createExpression({
        itemId: cloneGraph.sections[0]!.items[0]!.id,
        content: "Nope",
      }),
    ).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    expect(submitted.status).toBe(RESUME_VERSION_STATUS.SUBMITTED);
    expect(variant.id).toBeTruthy();
  });

  it("rejects direct mutation of a DRAFT referenced by submittedResumeVersionId", async () => {
    const { service, versionId, section } = await seedGraph();
    const applications = new ApplicationService(prisma, userId, FEATURE_ON);
    const opportunities = new OpportunityService(prisma, userId, FEATURE_ON);
    const opportunity = await opportunities.create({
      companyId,
      title: "Staff Engineer",
    });
    await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: opportunity.id,
        channelLabel: "Direct",
        submittedResumeVersionId: versionId,
      },
    });

    await expect(
      service.createSection({ versionId, title: "Nope" }),
    ).rejects.toMatchObject({ code: "SUBMITTED_RESUME_PROVENANCE" });
    await expect(
      service.updateSection({ sectionId: section.id, title: "Nope" }),
    ).rejects.toMatchObject({ code: "SUBMITTED_RESUME_PROVENANCE" });
  });
});

describe("Resume Variant V1 header snapshot", () => {
  it("copies only the allowlisted CandidateProfile fields", async () => {
    await prisma.candidateProfile.create({
      data: {
        userId,
        fullName: "Ada Lovelace",
        headline: "Engineer",
        email: "ada@example.com",
        phone: "123",
        address: "London",
        linksData: JSON.stringify(["https://ada.dev"]),
        gender: "女",
        birthDate: "1815-12-10",
        ethnicity: "hidden",
        politicalStatus: "群众",
        nativePlace: "hidden",
        householdRegistration: "hidden",
      },
    });
    await prisma.candidateSensitiveInfo.create({
      data: {
        userId,
        idNumber: "SECRET",
        emergencyContactName: "Annabella",
        emergencyContactPhone: "999",
      },
    });

    const snapshot = buildResumeHeaderSnapshot(
      await prisma.candidateProfile.findUniqueOrThrow({ where: { userId } }),
    );
    expect(snapshot).toBeTruthy();
    const parsed = parseResumeHeaderSnapshot(snapshot);
    expect(parsed.fullName).toBe("Ada Lovelace");
    expect(parsed.headline).toBe("Engineer");
    expect(parsed.email).toBe("ada@example.com");
    expect(parsed.phone).toBe("123");
    expect(parsed.address).toBe("London");
    expect(parsed.links[0]?.url).toBe("https://ada.dev");
    expect(JSON.parse(snapshot!)).not.toHaveProperty("gender");
    expect(JSON.parse(snapshot!)).not.toHaveProperty("birthDate");
    expect(JSON.parse(snapshot!)).not.toHaveProperty("ethnicity");
    expect(JSON.parse(snapshot!)).not.toHaveProperty("politicalStatus");
    expect(JSON.parse(snapshot!)).not.toHaveProperty("nativePlace");
    expect(JSON.parse(snapshot!)).not.toHaveProperty("householdRegistration");
    expect(JSON.stringify(parsed)).not.toContain("SECRET");
    expect(JSON.stringify(parsed)).not.toContain("Annabella");

    const created = await variants().createVariant({
      name: "General",
      headerSnapshot: JSON.stringify({
        fullName: "Ada Lovelace",
        gender: "女",
        birthDate: "1815-12-10",
        idNumber: "SECRET",
      }),
    });
    const stored = JSON.parse(
      (await prisma.resumeVariantVersion.findUniqueOrThrow({
        where: { id: created.currentVersionId! },
      })).headerSnapshot!,
    ) as Record<string, unknown>;
    expect(stored.fullName).toBe("Ada Lovelace");
    expect(stored).not.toHaveProperty("gender");
    expect(stored).not.toHaveProperty("birthDate");
    expect(stored).not.toHaveProperty("idNumber");
  });

  it("updates headerSnapshot on DRAFT without writing CandidateProfile", async () => {
    await prisma.candidateProfile.create({
      data: { userId, fullName: "Ada Lovelace" },
    });
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    await service.updateHeaderSnapshot(variant.currentVersionId!, {
      fullName: "Ada Byron",
      email: "ada@example.com",
      links: [{ label: "site", url: "https://ada.dev" }],
    });
    const version = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: variant.currentVersionId! },
    });
    expect(parseResumeHeaderSnapshot(version.headerSnapshot).fullName).toBe("Ada Byron");
    const profile = await prisma.candidateProfile.findUniqueOrThrow({
      where: { userId },
    });
    expect(profile.fullName).toBe("Ada Lovelace");
  });
});

describe("Resume Variant V1 submit binding", () => {
  it("submits a DRAFT through ApplicationService and refuses replacement or cross-user versions", async () => {
    const service = variants();
    const other = variants(otherUserId);
    const applications = new ApplicationService(prisma, userId, FEATURE_ON);
    const opportunities = new OpportunityService(prisma, userId, FEATURE_ON);
    const opportunity = await opportunities.create({
      companyId,
      title: "Staff Engineer",
    });
    const variant = await service.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;
    const foreign = await other.createVariant({ name: "Theirs" });
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers",
    });

    const submitted = await applications.markSubmitted({
      attemptId: attempt.id,
      submittedResumeVersionId: versionId,
    });
    expect(submitted.submittedResumeVersionId).toBe(versionId);
    const version = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(version.status).toBe(RESUME_VERSION_STATUS.SUBMITTED);

    const next = await service.cloneAsDraft(versionId);
    await expect(
      applications.markSubmitted({
        attemptId: attempt.id,
        submittedResumeVersionId: next.id,
      }),
    ).rejects.toMatchObject({ code: "SUBMITTED_RESUME_PROVENANCE" });
    await expect(
      applications.markSubmitted({
        attemptId: attempt.id,
        submittedResumeVersionId: foreign.currentVersionId!,
      }),
    ).rejects.toMatchObject({ code: "SUBMITTED_RESUME_PROVENANCE" });

    const unchanged = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(unchanged.status).toBe(RESUME_VERSION_STATUS.SUBMITTED);
    expect(unchanged.headerSnapshot).toBe(version.headerSnapshot);
  });
});

describe("Resume Variant V1 evidence linking", () => {
  it("reuses provenance replace and keeps snapshots", async () => {
    const { service, item, expression } = await seedGraph();
    const material = await materials().create({ type: "PROJECT", title: "Compiler" });
    await service.createSectionItem({
      sectionId: (await prisma.resumeVariantSectionItem.findUniqueOrThrow({
        where: { id: item.id },
      })).resumeVariantSectionId,
      careerMaterialItemId: material.id,
    });
    const evidence = await materials().addEvidence({
      materialItemId: material.id,
      kind: "METRIC",
      content: "Shipped 3 compilers",
    });
    const links = await provenance().replaceExpressionEvidence({
      expressionId: expression.id,
      evidenceIds: [evidence.id],
    });
    expect(links).toHaveLength(1);
    expect(links[0]?.evidenceContentSnapshot).toBe("Shipped 3 compilers");
    await prisma.careerEvidence.update({
      where: { id: evidence.id },
      data: { content: "Changed later" },
    });
    const again = await provenance().getExpressionEvidence(expression.id);
    expect(again[0]?.evidenceContentSnapshot).toBe("Shipped 3 compilers");
  });
});

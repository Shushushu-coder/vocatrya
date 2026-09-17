// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  CareerMaterialService,
  EVIDENCE_STATUS,
  ResumeProvenanceService,
  ResumeVariantService,
  hashEvidenceContent,
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
  userId = await seedAccount(prisma, `prov-${Date.now()}@example.com`);
  otherUserId = await seedAccount(prisma, `prov-other-${Date.now()}@example.com`);
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
});

function services(owner = userId) {
  return {
    variants: new ResumeVariantService(prisma, owner, FEATURE_ON),
    materials: new CareerMaterialService(prisma, owner, FEATURE_ON),
    provenance: new ResumeProvenanceService(prisma, owner, FEATURE_ON),
  };
}

async function createExpression(owner = userId) {
  const { variants, materials } = services(owner);
  const item = await materials.create({
    type: "EMPLOYMENT",
    title: "Engineer",
    detail: { roleTitle: "Engineer", organizationName: "Acme" },
  });
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
  return { item, variant, versionId, expression };
}

async function addEvidence(materialItemId: string, content: string, owner = userId) {
  return services(owner).materials.addEvidence({
    materialItemId,
    kind: "METRIC",
    content,
  });
}

describe("Resume expression evidence provenance", () => {
  it("links one and then multiple evidence rows with server-side snapshots", async () => {
    const { provenance } = services();
    const { item, expression } = await createExpression();
    const first = await addEvidence(item.id, "Shipped 3 compilers");
    const second = await addEvidence(item.id, "Mentored 2 engineers");

    const link = await provenance.linkEvidenceToExpression({
      expressionId: expression.id,
      evidenceId: first.id,
    });
    expect(link.evidenceContentSnapshot).toBe("Shipped 3 compilers");
    expect(link.evidenceHashSnapshot).toBe(hashEvidenceContent("Shipped 3 compilers"));
    expect(link.evidenceUpdatedAtSnapshot.getTime()).toBe(first.updatedAt.getTime());

    await provenance.linkEvidenceToExpression({
      expressionId: expression.id,
      evidenceId: second.id,
    });
    const links = await provenance.getExpressionEvidence(expression.id);
    expect(links).toHaveLength(2);
    const status = await prisma.resumeExpression.findUniqueOrThrow({
      where: { id: expression.id },
    });
    expect(status.evidenceStatus).toBe(EVIDENCE_STATUS.LINKED);
  });

  it("treats duplicate links as idempotent and keeps the original snapshot", async () => {
    const { provenance } = services();
    const { item, expression } = await createExpression();
    const evidence = await addEvidence(item.id, "Original");
    const first = await provenance.linkEvidenceToExpression({
      expressionId: expression.id,
      evidenceId: evidence.id,
    });
    await prisma.careerEvidence.update({
      where: { id: evidence.id },
      data: { content: "Changed later" },
    });
    const second = await provenance.linkEvidenceToExpression({
      expressionId: expression.id,
      evidenceId: evidence.id,
    });
    expect(second.id).toBe(first.id);
    expect(second.evidenceContentSnapshot).toBe("Original");
    expect(await provenance.getExpressionEvidence(expression.id)).toHaveLength(1);
  });

  it("unlinks and replaces evidence, syncing evidenceStatus", async () => {
    const { provenance } = services();
    const { item, expression } = await createExpression();
    const a = await addEvidence(item.id, "A");
    const b = await addEvidence(item.id, "B");
    const c = await addEvidence(item.id, "C");
    await provenance.linkEvidenceToExpression({
      expressionId: expression.id,
      evidenceId: a.id,
    });
    await provenance.unlinkEvidenceFromExpression({
      expressionId: expression.id,
      evidenceId: a.id,
    });
    let status = await prisma.resumeExpression.findUniqueOrThrow({
      where: { id: expression.id },
    });
    expect(status.evidenceStatus).toBe(EVIDENCE_STATUS.UNLINKED);

    await provenance.replaceExpressionEvidence({
      expressionId: expression.id,
      evidenceIds: [b.id, c.id],
    });
    status = await prisma.resumeExpression.findUniqueOrThrow({
      where: { id: expression.id },
    });
    expect(status.evidenceStatus).toBe(EVIDENCE_STATUS.LINKED);
    const replaced = await provenance.getExpressionEvidence(expression.id);
    expect(replaced.map((row) => row.careerEvidenceId).sort()).toEqual(
      [b.id, c.id].sort(),
    );

    await provenance.replaceExpressionEvidence({
      expressionId: expression.id,
      evidenceIds: [],
    });
    status = await prisma.resumeExpression.findUniqueOrThrow({
      where: { id: expression.id },
    });
    expect(status.evidenceStatus).toBe(EVIDENCE_STATUS.UNLINKED);
  });

  it("rejects cross-user evidence and expressions", async () => {
    const owner = services(userId);
    const other = services(otherUserId);
    const owned = await createExpression(userId);
    const foreign = await createExpression(otherUserId);
    const ownedEvidence = await addEvidence(owned.item.id, "Mine", userId);
    const foreignEvidence = await addEvidence(foreign.item.id, "Theirs", otherUserId);

    await expect(
      owner.provenance.linkEvidenceToExpression({
        expressionId: owned.expression.id,
        evidenceId: foreignEvidence.id,
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });
    await expect(
      owner.provenance.linkEvidenceToExpression({
        expressionId: foreign.expression.id,
        evidenceId: ownedEvidence.id,
      }),
    ).rejects.toMatchObject({ code: "EXPRESSION_NOT_FOUND" });
    await expect(
      other.provenance.linkEvidenceToExpression({
        expressionId: owned.expression.id,
        evidenceId: ownedEvidence.id,
      }),
    ).rejects.toMatchObject({ code: "EXPRESSION_NOT_FOUND" });
  });

  it("copies provenance links and historical snapshots when cloning a frozen version", async () => {
    const { provenance, variants } = services();
    const { item, expression, versionId } = await createExpression();
    const evidence = await addEvidence(item.id, "Snapshot A");
    const originalLink = await provenance.linkEvidenceToExpression({
      expressionId: expression.id,
      evidenceId: evidence.id,
    });
    await variants.freeze(versionId);

    await prisma.careerEvidence.update({
      where: { id: evidence.id },
      data: { content: "Snapshot B" },
    });

    const cloned = await variants.editVersion(versionId, { locale: "en" });
    const clonedTree = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: cloned.id },
      include: {
        sections: {
          include: {
            items: {
              include: {
                expressions: { include: { evidenceLinks: true } },
              },
            },
          },
        },
      },
    });
    const clonedExpr = clonedTree.sections[0].items[0].expressions[0];
    expect(clonedExpr.evidenceLinks).toHaveLength(1);
    expect(clonedExpr.evidenceStatus).toBe(EVIDENCE_STATUS.LINKED);
    expect(clonedExpr.evidenceLinks[0].careerEvidenceId).toBe(evidence.id);
    expect(clonedExpr.evidenceLinks[0].evidenceContentSnapshot).toBe("Snapshot A");
    expect(clonedExpr.evidenceLinks[0].evidenceHashSnapshot).toBe(
      originalLink.evidenceHashSnapshot,
    );
    expect(clonedExpr.evidenceLinks[0].evidenceUpdatedAtSnapshot.getTime()).toBe(
      originalLink.evidenceUpdatedAtSnapshot.getTime(),
    );
    expect(clonedExpr.evidenceLinks[0].evidenceContentSnapshot).not.toBe("Snapshot B");

    const sourceExpr = await prisma.resumeExpression.findUniqueOrThrow({
      where: { id: expression.id },
      include: { evidenceLinks: true },
    });
    expect(sourceExpr.evidenceLinks[0].evidenceContentSnapshot).toBe("Snapshot A");
  });
});

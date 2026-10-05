import type { Prisma, PrismaClient } from "@prisma/client";
import { assertResumeV1Writable } from "./capabilities";
import { hashEvidenceContent } from "./resumeProvenanceService";
import { buildResumeHeaderSnapshot } from "./resumeHeaderSnapshot";
import { resolveCompany } from "@/lib/jobs/resolve";
import { ResumeVariantService } from "./resumeVariantService";
import { importDate, importProfileFields, validateResumeImport, type ParsedResumeImport, type ResumeImportItem } from "./resumeImportContract";

type ImportDb = PrismaClient | Prisma.TransactionClient;
const detailKeys = {
  EDUCATION: "educationDetail", INTERNSHIP: "internshipDetail", EMPLOYMENT: "employmentDetail",
  PROJECT: "projectDetail", RESEARCH: "researchDetail", PUBLICATION: "publicationDetail",
  AWARD: "awardDetail", SKILL: "skillDetail", CUSTOM: "customDetail",
} as const;

function structuredData(item: ResumeImportItem) {
  // Preserve date precision and source even when the typed DateTime is null.
  return JSON.stringify({ source: "RESUME_IMPORT", sourceText: item.sourceText, fields: item.structuredFields, uncertainty: item.uncertainty });
}

async function existingMaterial(db: ImportDb, userId: string, item: ResumeImportItem) {
  const candidates = await db.careerMaterialItem.findMany({
    where: { userId, type: item.type, title: item.title, notes: item.sourceText, archivedAt: null },
    include: { educationDetail: true, internshipDetail: true, employmentDetail: true, projectDetail: true,
      researchDetail: true, publicationDetail: true, awardDetail: true, skillDetail: true, customDetail: true },
  });
  // All source fields must match, including dates. Company+role alone never merges.
  return candidates.find((row) => {
    try {
      const stored = JSON.parse(row[detailKeys[item.type]]?.structuredData ?? "{}") as { fields?: Record<string, unknown> };
      return stored.fields && Object.entries(item.structuredFields).every(([key, value]) => stored.fields?.[key] === value);
    } catch { return false; }
  });
}

export async function inspectResumeImport(db: ImportDb, userId: string, parsed: ParsedResumeImport) {
  const existing = await db.candidateProfile.findUnique({ where: { userId } });
  const conflicts = importProfileFields.filter((field) => existing?.[field] && parsed.profile[field] && existing[field] !== parsed.profile[field]);
  let reused = 0;
  for (const section of parsed.sections) for (const item of section.items) {
    if (await existingMaterial(db, userId, item)) reused++;
  }
  const total = parsed.sections.reduce((sum, section) => sum + section.items.length, 0);
  return { conflicts, reused, created: total - reused };
}

async function createMaterial(tx: Prisma.TransactionClient, userId: string, item: ResumeImportItem) {
  const f = item.structuredFields;
  const common = { structuredData: structuredData(item) };
  const companyId = (item.type === "INTERNSHIP" || item.type === "EMPLOYMENT") && f.organization
    ? (await resolveCompany(f.organization, userId, tx)).id : null;
  const details = {
    EDUCATION: { ...common, institution: f.institution, degree: f.degree, fieldOfStudy: f.fieldOfStudy, locationText: f.location },
    INTERNSHIP: { ...common, companyId, organizationName: f.organization, roleTitle: f.role, locationText: f.location },
    EMPLOYMENT: { ...common, companyId, organizationName: f.organization, roleTitle: f.role, locationText: f.location },
    PROJECT: { ...common, roleTitle: f.role, projectUrl: f.url, organizationName: f.organization },
    RESEARCH: { ...common, institution: f.institution, roleTitle: f.role, field: f.fieldOfStudy },
    PUBLICATION: { ...common, venue: f.venue, authors: f.authors, url: f.url },
    AWARD: { ...common, issuer: f.issuer },
    SKILL: { ...common, skillName: f.skillName ?? item.title, proficiency: f.proficiency },
    CUSTOM: common,
  };
  return tx.careerMaterialItem.create({ data: {
    user: { connect: { id: userId } }, type: item.type, title: item.title,
    notes: item.sourceText, startDate: importDate(f.startDate), endDate: importDate(f.endDate),
    isCurrent: /^(至今|现在|Present|Current)$/i.test(f.endDate ?? ""),
    origin: "IMPORT", verificationStatus: "USER_CONFIRMED",
    [detailKeys[item.type]]: { create: details[item.type] },
  } });
}

export async function persistResumeImport(db: PrismaClient, userId: string, input: {
  requestId: string; name: string; rawText: string; parsed: ParsedResumeImport;
  resolvedConnectionId: string; resolvedModel: string;
}, env?: NodeJS.ProcessEnv) {
  await assertResumeV1Writable(db, env);
  const parsed = validateResumeImport(input.parsed, input.rawText);
  const replay = () => db.resumeVariant.findFirst({ where: { id: input.requestId, userId } });
  const previous = await replay();
  if (previous) return previous;
  try {
    return await new ResumeVariantService(db, userId, env).createImportedDraft({
      id: input.requestId, name: input.name, resolvedConnectionId: input.resolvedConnectionId, resolvedModel: input.resolvedModel,
    }, async (tx, versionId) => {
      const existingProfile = await tx.candidateProfile.findUnique({ where: { userId } });
      const fill: Record<string, string> = {};
      for (const field of importProfileFields) {
        if (!existingProfile?.[field] && parsed.profile[field]) fill[field] = parsed.profile[field];
      }
      const profile = await tx.candidateProfile.upsert({ where: { userId },
        create: { userId, ...fill }, update: fill });
      for (const [sectionOrder, section] of parsed.sections.entries()) {
        const createdSection = await tx.resumeVariantSection.create({ data: {
          resumeVariantVersionId: versionId, title: section.title, sortOrder: sectionOrder,
          systemKind: "CUSTOM",
        } });
        for (const [itemOrder, item] of section.items.entries()) {
          const material = await existingMaterial(tx, userId, item) ?? await createMaterial(tx, userId, item);
          const sectionItem = await tx.resumeVariantSectionItem.create({ data: {
            resumeVariantSectionId: createdSection.id, careerMaterialItemId: material.id,
            itemKind: item.type, sortOrder: itemOrder,
          } });
          for (const [expressionOrder, content] of item.expressions.entries()) {
            const candidates = item.evidenceCandidates.filter((candidate) => candidate.expressionIndex === expressionOrder);
            const expression = await tx.resumeExpression.create({ data: {
              resumeVariantSectionItemId: sectionItem.id, content, kind: "BODY", sortOrder: expressionOrder,
              evidenceStatus: candidates.length ? "LINKED" : "UNLINKED",
            } });
            for (const candidate of candidates) {
              const evidence = await tx.careerEvidence.findFirst({ where: {
                materialItemId: material.id, content: candidate.content, kind: candidate.kind, archivedAt: null,
              } }) ?? await tx.careerEvidence.create({ data: {
                materialItemId: material.id, content: candidate.content, kind: candidate.kind,
                metricText: candidate.kind === "METRIC" ? candidate.content : null,
                origin: "IMPORT", verificationStatus: "USER_CONFIRMED", sortOrder: expressionOrder,
              } });
              await tx.resumeExpressionEvidence.upsert({
                where: { resumeExpressionId_careerEvidenceId: { resumeExpressionId: expression.id, careerEvidenceId: evidence.id } },
                update: {}, create: {
                  resumeExpressionId: expression.id, careerEvidenceId: evidence.id,
                  evidenceContentSnapshot: evidence.content, evidenceHashSnapshot: hashEvidenceContent(evidence.content),
                  evidenceUpdatedAtSnapshot: evidence.updatedAt,
                },
              });
            }
          }
        }
      }
      return buildResumeHeaderSnapshot(profile);
    });
  } catch (error) {
    // A competing confirm can win the primary-key race. No staging table needed.
    const winner = await replay();
    if (winner) return winner;
    throw error;
  }
}

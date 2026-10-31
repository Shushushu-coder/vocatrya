// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { diffResumeVersions } from "@/lib/career/resumeVersionDiff";
import { projectResumeVariantText } from "@/lib/career/resumeVariantText";
import { ResumeArtifactService } from "@/lib/career/resumeArtifactService";
import { parseResumeLayoutConfig } from "@/lib/career/resumeLayoutConfig";
import { BackupDataSchema, ManifestSchema, BACKUP_FORMAT_VERSION } from "@/lib/backup/schema";
import { readAbResumeVariant } from "@/lib/career/resumeReadDispatch";
import mammoth from "mammoth";
import JSZip from "jszip";
import { buildResumeDocx } from "@/lib/career/resumeDocx";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
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

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };

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

describe("resume builder persistence and boundaries", () => {
  it("updates variant target without touching frozen content, and rejects foreign or archived jobs", async () => {
    const { service, versionId } = await seedGraph();
    await service.freeze(versionId);
    const frozen = await service.getVersion(versionId);
    const opportunity = await new OpportunityService(prisma, userId, FEATURE_ON).create({ companyId, title: "Target job" });
    await service.updateTargetJob(versionId, opportunity.id);
    expect((await service.getVariant(frozen.resumeVariantId)).targetJobOpportunityId).toBe(opportunity.id);
    expect(await service.getVersion(versionId)).toEqual(frozen);
    await expect(variants(otherUserId).updateTargetJob(versionId, null)).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    await prisma.jobOpportunity.update({ where: { id: opportunity.id }, data: { archivedAt: new Date() } });
    await expect(service.updateTargetJob(versionId, opportunity.id)).rejects.toMatchObject({ code: "TARGET_JOB_NOT_FOUND" });
    await service.updateTargetJob(versionId, null);
  });
  it("projection diff never embeds hidden descendants inside added or removed parents", async () => {
    const { service, versionId, expression } = await seedGraph();
    await service.setHidden("expression", expression.id, true);
    const graph = await service.getVersion(versionId);
    const changes = diffResumeVersions({ ...graph, sections: [] }, graph, "projection");
    expect(JSON.stringify(changes)).not.toContain("Shipped compilers");
    expect(JSON.stringify(diffResumeVersions({ ...graph, sections: [] }, graph))).toContain("Shipped compilers");
  });

  it("clones lineage, records only local edits and hidden state, and keeps source materials intact", async () => {
    const { service, variant, versionId, section } = await seedGraph();
    const material = await materials().create({ type: "PROJECT", title: "Source project" });
    const evidence = await materials().addEvidence({ materialItemId: material.id, kind: "METRIC", content: "Built compiler for 300 users" });
    const attached = await service.attachMaterialToSection(section.id, material.id);
    const original = await service.getVersion(versionId);
    const linked = original.sections[0].items.find((i) => i.id === attached.id)!;
    expect(linked.expressions[0].kind).toBe("BULLET");
    expect(linked.expressions[0].evidenceLinks[0].evidenceContentSnapshot).toBe(evidence.content);
    await service.freeze(versionId);
    const cloned = await service.cloneAsDraft(versionId);
    const copy = await service.getVersion(cloned.id);
    expect(diffResumeVersions(original, copy)).toEqual([]);
    const copiedItem = copy.sections[0].items.find((i) => i.careerMaterialItemId === material.id)!;
    await service.updateExpression({ expressionId: copiedItem.expressions[0].id, content: "Version-local rewrite" });
    await service.setHidden("item", copiedItem.id, true);
    const changed = await service.getVersion(cloned.id);
    const diff = diffResumeVersions(original, changed);
    expect(diff).toHaveLength(2);
    expect(diff.every((c) => c.type === "changed" && c.matched === "origin")).toBe(true);
    expect(projectResumeVariantText(changed)).not.toContain("Source project");
    expect((await readAbResumeVariant(prisma, userId, variant.id))?.text).not.toContain("Version-local rewrite");
    expect((await prisma.careerEvidence.findUniqueOrThrow({ where: { id: evidence.id } })).content).toBe(evidence.content);
    await service.deleteSectionItem(copiedItem.id);
    expect(await prisma.careerMaterialItem.findUnique({ where: { id: material.id } })).not.toBeNull();
    expect(await prisma.careerEvidence.findUnique({ where: { id: evidence.id } })).not.toBeNull();
  });
  it("rejects foreign, archived, frozen and submitted writes atomically", async () => {
    const { service, versionId, section, item, expression } = await seedGraph();
    await expect(variants(otherUserId).setHidden("section", section.id, true)).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });
    const foreign = await materials(otherUserId).create({ type: "PROJECT", title: "Foreign" });
    await expect(service.attachMaterialToSection(section.id, foreign.id)).rejects.toMatchObject({ code: "MATERIAL_NOT_FOUND" });
    expect(await prisma.resumeVariantSectionItem.count({ where: { resumeVariantSectionId: section.id } })).toBe(1);
    const own = await materials().create({ type: "PROJECT", title: "Own" });
    const e = await materials().addEvidence({ materialItemId: own.id, kind: "METRIC", content: "Owned evidence" });
    await expect(service.addEvidenceAsExpression(item.id, e.id)).rejects.toMatchObject({ code: "MATERIAL_NOT_FOUND" });
    await service.freeze(versionId);
    await expect(service.setHidden("expression", expression.id, true)).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
    await expect(service.attachMaterialToSection(section.id, own.id)).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
  });
  it("persists three visibility levels, backup fields and optional layout without overwriting migration metadata", async () => {
    const { service, versionId, section, item, expression } = await seedGraph();
    await service.updateDraft(versionId, { layoutConfig: JSON.stringify({ migrationSource: "legacy" }) });
    await service.updateLayout(versionId, { pageTarget: 2, template: "standard" });
    for (const [kind, id] of [["section", section.id], ["item", item.id], ["expression", expression.id]] as const) await service.setHidden(kind, id, true);
    const saved = await service.getVersion(versionId);
    expect(JSON.parse(saved.layoutConfig!).migrationSource).toBe("legacy");
    expect(parseResumeLayoutConfig(saved.layoutConfig).pageTarget).toBe(2);
    expect(projectResumeVariantText(saved)).not.toContain("Shipped compilers");
    await service.setHidden("section", section.id, false);
    await service.setHidden("item", item.id, false);
    expect(projectResumeVariantText(await service.getVersion(versionId))).not.toContain("Shipped compilers");
    await service.setHidden("expression", expression.id, false);
    expect(projectResumeVariantText(await service.getVersion(versionId))).toContain("Shipped compilers");
    const data = BackupDataSchema.parse({ ResumeVariantSection: [saved.sections[0]], ResumeVariantSectionItem: [saved.sections[0].items[0]], ResumeExpression: [saved.sections[0].items[0].expressions[0]] });
    expect(data.ResumeVariantSection![0].hiddenAt).toBeInstanceOf(Date);
    expect(data.ResumeExpression![0].originRefId).toBeTruthy();
    expect(BACKUP_FORMAT_VERSION).toBe(7);
    expect(ManifestSchema.safeParse({ formatVersion: 7, appVersion: "test", exportedAt: new Date().toISOString(), sourceEmail: "test@example.com", counts: {}, containsSensitiveData: false }).success).toBe(true);
  });
  it("keeps pre-feature rows readable after applying the additive migration", async () => {
    const { service, versionId } = await seedGraph();
    for (const model of ["ResumeVariantSection", "ResumeVariantSectionItem", "ResumeExpression"]) {
      await prisma.$executeRawUnsafe(`ALTER TABLE "${model}" DROP COLUMN "hiddenAt"`);
      await prisma.$executeRawUnsafe(`ALTER TABLE "${model}" DROP COLUMN "originRefId"`);
    }
    const sql = fs.readFileSync(path.join(process.cwd(), "prisma/migrations/20261029020000_resume_builder_visibility/migration.sql"), "utf8");
    for (const statement of sql.split(";").filter((s) => s.trim())) await prisma.$executeRawUnsafe(statement);
    const graph = await service.getVersion(versionId);
    expect(graph.sections[0].hiddenAt).toBeNull();
    expect(projectResumeVariantText(graph)).toContain("Shipped compilers");
    const copy = await service.getVersion((await service.cloneAsDraft(versionId)).id);
    expect(diffResumeVersions(graph, copy)).toEqual([]);
    // Restoring a pre-feature source remaps its id, while the clone's lineage stays a value.
    const restoredOld = { ...graph, sections: graph.sections.map((s) => ({ ...s, id: `restored-${s.id}`, items: s.items.map((i) => ({ ...i, id: `restored-${i.id}`, expressions: i.expressions.map((e) => ({ ...e, id: `restored-${e.id}` })) })) })) };
    expect(diffResumeVersions(restoredOld, copy)).toEqual([]);
  });
  it("creates server-side DOCX with visibility filtering, owner checks, deduplication and missing-byte regeneration", async () => {
    const { service, versionId, expression, section } = await seedGraph();
    await service.createExpression({ itemId: expression.resumeVariantSectionItemId, content: "可编辑中文正文 Visible body", kind: "BODY" });
    await service.setHidden("expression", expression.id, true);
    const hidden = await service.createSection({ versionId, title: "Hidden section" });
    await service.setHidden("section", hidden.id, true);
    const root = path.join(ctx.dir, "artifacts");
    const artifacts = new ResumeArtifactService(prisma, userId, FEATURE_ON, root);
    await expect(artifacts.createDocxExport(versionId)).rejects.toMatchObject({ code: "VERSION_NOT_IMMUTABLE" });
    await service.freeze(versionId);
    const [a, b] = await Promise.all([artifacts.createDocxExport(versionId), artifacts.createDocxExport(versionId)]);
    expect(a.id).toBe(b.id); expect(a.format).toBe("DOCX");
    const download = await artifacts.openForDownload(a.id);
    const text = (await mammoth.extractRawText({ buffer: download.bytes })).value;
    expect(text).toContain("可编辑中文正文"); expect(text).toContain(section.title.toLocaleUpperCase());
    expect(text).not.toContain("Shipped compilers"); expect(text).not.toContain("Hidden section");
    await expect(new ResumeArtifactService(prisma, otherUserId, FEATURE_ON, root).openForDownload(a.id)).rejects.toMatchObject({ code: "ARTIFACT_NOT_FOUND" });
    fs.unlinkSync(path.join(root, a.storageKey));
    const regenerated = await artifacts.createDocxExport(versionId);
    expect(regenerated.id).not.toBe(a.id);
    expect((await artifacts.openForDownload(regenerated.id)).bytes.byteLength).toBeGreaterThan(100);
  });

  it("moves a section item into another section and rejects a duplicate material", async () => {
    const { service, versionId, section, item } = await seedGraph();
    const other = await service.createSection({ versionId, title: "Projects" });
    const anchor = await service.createSectionItem({ sectionId: other.id, itemKind: RESUME_SECTION_ITEM_KIND.MANUAL });
    await service.moveSectionItem(item.id, other.id, anchor.id);
    const moved = (await service.getVersion(versionId)).sections.find((row) => row.id === other.id)!;
    expect(moved.items.map((row) => row.id)).toEqual([item.id, anchor.id]);
    expect((await service.getVersion(versionId)).sections.find((row) => row.id === section.id)!.items).toHaveLength(0);
    const material = await materials().create({ type: "PROJECT", title: "Once" });
    const first = await service.attachMaterialToSection(section.id, material.id);
    await service.moveSectionItem(first.id, other.id, null);
    const second = await service.attachMaterialToSection(section.id, material.id);
    await expect(service.moveSectionItem(second.id, other.id, null)).rejects.toMatchObject({ code: "MATERIAL_ALREADY_IN_SECTION" });
    await service.freeze(versionId);
    await expect(service.moveSectionItem(item.id, section.id, null)).rejects.toMatchObject({ code: "VERSION_IMMUTABLE" });
  });

  it("changes status after freeze and deletes frozen and draft versions", async () => {
    const { service, variant, versionId } = await seedGraph();
    const content = (await service.getVersion(versionId)).sections[0].items[0].expressions[0].content;
    await service.freeze(versionId);
    const unfrozen = await service.setStatus(versionId, "DRAFT");
    expect(unfrozen.status).toBe("DRAFT");
    expect(unfrozen.frozenAt).not.toBeNull();
    expect((await service.getVersion(versionId)).sections[0].items[0].expressions[0].content).toBe(content);
    await service.setStatus(versionId, "SUBMITTED");
    await service.setStatus(versionId, "FROZEN");
    expect((await service.getVersion(versionId)).status).toBe("FROZEN");
    const cloned = await service.cloneAsDraft(versionId);
    expect(cloned.parentVersionId).toBe(versionId);
    await service.deleteVersion(versionId);
    const remaining = await service.getVersion(cloned.id);
    expect(remaining.parentVersionId).toBeNull();
    expect((await service.getVariant(variant.id)).currentVersionId).toBe(cloned.id);
    const opportunity = await new OpportunityService(prisma, userId, FEATURE_ON).create({ companyId, title: "Cited job" });
    await prisma.applicationAttempt.create({ data: { userId, jobOpportunityId: opportunity.id, channelLabel: "Site", submittedResumeVersionId: cloned.id } });
    await expect(service.setStatus(cloned.id, "FROZEN")).rejects.toMatchObject({ code: "SUBMITTED_RESUME_PROVENANCE" });
    await expect(service.deleteVersion(cloned.id)).rejects.toMatchObject({ code: "SUBMITTED_RESUME_PROVENANCE" });
    await prisma.applicationAttempt.deleteMany({ where: { submittedResumeVersionId: cloned.id } });
    await service.deleteVersion(cloned.id);
    expect(await service.listVariantVersions(variant.id)).toEqual([]);
    expect((await service.getVariant(variant.id)).currentVersionId).toBeNull();
  });

  it("keeps docx contact, links, section case and bullets aligned with the print preview", async () => {
    const bytes = await buildResumeDocx({
      headerSnapshot: JSON.stringify({ fullName: "Ada Lovelace", headline: "Engineer", email: "ada@example.test", phone: "123", links: [{ url: "https://example.test" }] }),
      sections: [{ title: "Experience", items: [{ materialTitleSnapshot: "Analytical Engine", expressions: [{ kind: "BODY", content: "Intro line" }, { kind: "BULLET", content: "Built it" }] }] }],
    });
    const xml = await JSZip.loadAsync(bytes).then((zip) => zip.file("word/document.xml")!.async("string"));
    const paragraphs = xml.split(/<w:p[\s>]/).slice(1);
    const contact = paragraphs.find((paragraph) => paragraph.includes("ada@example.test"));
    expect(contact).toBeTruthy();
    expect(contact).not.toContain("https://example.test");
    expect(xml).toContain("EXPERIENCE");
    expect(xml).toContain('w:val="36"');
    expect(paragraphs.find((paragraph) => paragraph.includes("Intro line"))).not.toContain("<w:numPr");
    expect(paragraphs.find((paragraph) => paragraph.includes("Built it"))).toContain("<w:numPr");
  });
});

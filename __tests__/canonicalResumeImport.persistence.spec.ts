// @vitest-environment node
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { makeResumeExportTestContext } from "./helpers/resumeExportTestDb";
import { activateFreshAbNative } from "@/lib/career/freshActivation";
import { persistResumeImport, inspectResumeImport } from "@/lib/career/canonicalResumeImport";
import { importFixture, importRawText, internshipBullet, projectBullet } from "./helpers/canonicalImportFixture";
import { ResumeVariantService } from "@/lib/career/resumeVariantService";
import { readAbResumeVariant } from "@/lib/career/resumeReadDispatch";
import { buildGetResumeTool } from "@/lib/agent/tools/getResume";
import { buildReviewResumeTool } from "@/lib/agent/tools/reviewResume";
import type { LanguageModel, UIMessageStreamWriter } from "ai";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), generation: vi.fn(), legacySave: vi.fn() }));
vi.mock("@/lib/agent/resumeLookup", () => ({ resolveCanonicalResumeForAgent: mocks.lookup }));
vi.mock("@/lib/agent/nestedGeneration", () => ({ runNestedGeneration: mocks.generation }));
vi.mock("@/actions/profile.actions", () => ({ saveResumeReviewResult: mocks.legacySave }));
const ctx = makeResumeExportTestContext();
const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
let userId: string;
let connectionId: string;
const input = () => ({ requestId: randomUUID(), name: "Synthetic Import", rawText: importRawText,
  parsed: structuredClone(importFixture), resolvedConnectionId: connectionId, resolvedModel: "test-model" });
const counts = async () => ({
  materials: await db.careerMaterialItem.count(), evidence: await db.careerEvidence.count(),
  variants: await db.resumeVariant.count(), versions: await db.resumeVariantVersion.count(),
  company: await db.company.count(), profile: await db.candidateProfile.count(),
  legacyResume: await db.resume.count(), legacySection: await db.resumeSection.count(),
  legacyItem: await db.workExperience.count() + await db.education.count() + await db.skill.count() + await db.otherSection.count() + await db.licenseOrCertification.count() + await db.contactInfo.count() + await db.summary.count(), attempts: await db.applicationAttempt.count(),
  opportunities: await db.jobOpportunity.count(), match: await db.matchAnalysis.count(),
});
beforeAll(async () => {
  await activateFreshAbNative(db);
  userId = (await db.user.create({ data: { name: "Synthetic", email: "canonical-import@example.com", password: "test" } })).id;
  connectionId = (await db.aIConnection.create({ data: { userId, provider: "CODEX", backendKind: "CODEX_CLI", displayName: "Test" } })).id;
});
afterAll(async () => {
  await db.$disconnect();
  const os = await import("node:os"); const path = await import("node:path");
  expect(path.relative(os.tmpdir(), ctx.dir)).not.toMatch(/^\.\./);
  await fs.rm(ctx.dir, { recursive: true, force: true });
});

it("preview inspection and discarding the client draft cause zero writes", async () => {
  const before = await counts();
  expect(await inspectResumeImport(db, userId, importFixture)).toEqual({ created: 4, reused: 0, conflicts: [] });
  expect(await counts()).toEqual(before);
});
it("rolls back profile, catalog, material, evidence and variant on a real midway failure", async () => {
  const before = await counts();
  const failingDb = db.$extends({ query: { resumeExpression: { create() { throw new Error("forced midway failure"); } } } });
  await expect(persistResumeImport(failingDb as unknown as PrismaClient, userId, input(), env)).rejects.toThrow("forced midway failure");
  expect(await counts()).toEqual(before);
});
it("creates canonical facts, original expressions and evidence links atomically as DRAFT, preserving existing profile", async () => {
  await db.candidateProfile.create({ data: { userId, phone: "13800000000" } });
  const request = input();
  expect((await inspectResumeImport(db, userId, request.parsed)).conflicts).toEqual(["phone"]);
  const variant = await persistResumeImport(db, userId, request, env);
  const version = await new ResumeVariantService(db, userId, env).getVersion(variant.currentVersionId!);
  for (const item of version.sections.flatMap((section) => section.items)) expect(item.materialTitleSnapshot).toBe(item.careerMaterialItem?.title ?? null);
  expect(version.status).toBe("DRAFT");
  expect(version.createdVia).toBe("IMPORT");
  expect(version.sections.map((section) => section.title)).toEqual(importFixture.sections.map((section) => section.title));
  const evidenceLinks = await db.resumeExpressionEvidence.findMany({ include: { careerEvidence: { include: { materialItem: true } }, resumeExpression: true } });
  for (const content of [internshipBullet, projectBullet]) {
    const link = evidenceLinks.find((row) => row.resumeExpression.content === content);
    expect(link?.careerEvidence.content).toBe(content);
    expect(link?.careerEvidence.materialItem.userId).toBe(userId);
  }
  expect(evidenceLinks.find((row) => row.careerEvidence.kind === "METRIC")?.evidenceContentSnapshot).toContain("P95 从 480ms 降至 120ms");
  const internship = await db.careerMaterialItem.findFirst({ where: { type: "INTERNSHIP" }, include: { internshipDetail: true } });
  expect(internship).toMatchObject({ origin: "IMPORT", startDate: null, endDate: null });
  expect(internship?.internshipDetail).toMatchObject({ organizationName: "某科技公司", roleTitle: "后端开发实习" });
  expect(JSON.parse(internship!.internshipDetail!.structuredData).fields.startDate).toBe("2025.03");
  expect(await db.candidateProfile.findUnique({ where: { userId } })).toMatchObject({ phone: "13800000000", fullName: "陈启明", email: "synthetic@example.com" });
  expect(await counts()).toMatchObject({ materials: 4, evidence: 2, variants: 1, versions: 1,
    legacyResume: 0, legacySection: 0, legacyItem: 0, attempts: 0, opportunities: 0, match: 0 });
  // Actual canonical projection feeds the existing get_resume/review_resume tools.
  mocks.lookup.mockImplementation(async () => {
    const projection = await readAbResumeVariant(db, userId, variant.id);
    return { ...projection, status: "ok", family: "ab", source: "page", ambiguousTitle: false };
  });
  const getResult = await buildGetResumeTool(userId, variant.id).execute!({}, { toolCallId: "get", messages: [] });
  expect(getResult).toMatchObject({ status: "ok", resumeId: variant.id });
  expect(JSON.stringify(getResult)).toContain("480ms");
  mocks.generation.mockResolvedValue({ status: "ok", text: "Review\nSCORES: overall=80 impact=80 clarity=80 ats=80" });
  const review = buildReviewResumeTool({ userId, pageResumeId: variant.id, model: {} as LanguageModel,
    provider: "test", modelName: "test", writer: {} as UIMessageStreamWriter, guard: { running: false } });
  expect(await review.execute!({}, { toolCallId: "review", messages: [] })).toMatchObject({ status: "ok", saved: false });
  expect(mocks.generation.mock.calls[0][0].prompt).toContain("480ms");
  expect(mocks.legacySave).not.toHaveBeenCalled();
  const expression = await db.resumeExpression.findFirstOrThrow({ where: { content: projectBullet } });
  await new ResumeVariantService(db, userId, env).updateExpression({ expressionId: expression.id, content: projectBullet + " 已检查。" });
  expect((await db.resumeVariantVersion.findUnique({ where: { id: version.id } }))?.status).toBe("DRAFT");
  // Exact approval retries reuse the same root; intentional new upload gets a new root.
  const beforeReplay = await counts();
  expect((await persistResumeImport(db, userId, request, env)).id).toBe(variant.id);
  expect(await counts()).toEqual(beforeReplay);
  expect(await inspectResumeImport(db, userId, importFixture)).toMatchObject({ created: 0, reused: 4 });
  const advisoryChange = structuredClone(importFixture);
  advisoryChange.sections[1].items[0].uncertainty = "Different advisory wording";
  expect(await inspectResumeImport(db, userId, advisoryChange)).toMatchObject({ created: 0, reused: 4 });
  await persistResumeImport(db, userId, input(), env);
  expect(await counts()).toMatchObject({ materials: 4, evidence: 2, variants: 2, versions: 2 });
});
it("does not merge same company and role when dates/source differ", async () => {
  const request = input();
  request.rawText = request.rawText.replaceAll("2025.03", "2024.03");
  const item = request.parsed.sections[1].items[0];
  item.sourceText = item.sourceText.replace("2025.03", "2024.03");
  item.expressions[0] = item.expressions[0].replace("2025.03", "2024.03");
  item.structuredFields.startDate = "2024.03";
  expect(await inspectResumeImport(db, userId, request.parsed)).toMatchObject({ created: 1, reused: 3 });
  await persistResumeImport(db, userId, request, env);
  expect(await db.careerMaterialItem.count({ where: { type: "INTERNSHIP" } })).toBe(2);
});

it("keeps imported frozen titles stable in actual Agent get/review tools after material rename", async () => {
  const variant = await persistResumeImport(db, userId, input(), env);
  const service = new ResumeVariantService(db, userId, env);
  const version = await service.getVersion(variant.currentVersionId!);
  const linked = version.sections.flatMap((section) => section.items).find((item) => item.careerMaterialItemId)!;
  const title = linked.materialTitleSnapshot!;
  await service.freeze(version.id);
  await db.careerMaterialItem.update({ where: { id: linked.careerMaterialItemId! }, data: { title: "LIVE RENAMED MATERIAL MUST NOT APPEAR" } });
  mocks.lookup.mockImplementation(async () => ({ ...await readAbResumeVariant(db, userId, variant.id), status: "ok", family: "ab", source: "page", ambiguousTitle: false }));
  const read = await buildGetResumeTool(userId, variant.id).execute!({}, { toolCallId: "get-history", messages: [] });
  expect(JSON.stringify(read)).toContain(title);
  expect(JSON.stringify(read)).not.toContain("LIVE RENAMED MATERIAL MUST NOT APPEAR");
  mocks.generation.mockResolvedValue({ status: "ok", text: "Review\nSCORES: overall=80 impact=80 clarity=80 ats=80" });
  const review = buildReviewResumeTool({ userId, pageResumeId: variant.id, model: {} as LanguageModel,
    provider: "test", modelName: "test", writer: {} as UIMessageStreamWriter, guard: { running: false } });
  await review.execute!({}, { toolCallId: "review-history", messages: [] });
  const prompt = mocks.generation.mock.calls.at(-1)![0].prompt;
  expect(prompt).toContain(title); expect(prompt).not.toContain("LIVE RENAMED MATERIAL MUST NOT APPEAR");
});

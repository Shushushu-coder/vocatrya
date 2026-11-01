// @vitest-environment node
import fs from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PrismaClient } from "@prisma/client";
import { ResumePreview } from "@/components/career/resume-variant/ResumePreview";
import { BackupDataSchema } from "@/lib/backup/schema";
import { readAbResumeVariant } from "@/lib/career/resumeReadDispatch";
import { projectResumeVariantText } from "@/lib/career/resumeVariantText";
import { buildResumeReviewPrompt } from "@/lib/ai/prompts/resume-review";
import { ApplicationService, CareerMaterialService, ResumeVariantService, ResumeProvenanceService,
  AB_RUNTIME_FEATURE_ENV, AB_ROLLOUT_SCOPE_ENV, activateFreshAbNative } from "@/lib/career";
import { syncJdVersion, syncApplicationFromUiStatus } from "@/lib/career/jobOpportunityAdapter";
import { seedAccount, resetDisposableDb } from "./helpers/backupTestDb";
import { makeResumeExportTestContext } from "./helpers/resumeExportTestDb";

vi.mock("@/i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

const ctx = makeResumeExportTestContext();
const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const db2 = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const env = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };
let userId: string;
let otherUserId: string;
let jobId: string;
const variants = (client = db, owner = userId) => new ResumeVariantService(client, owner, env);
const applications = (client = db) => new ApplicationService(client, userId, env);
const provenance = () => new ResumeProvenanceService(db, userId, env);

beforeEach(async () => {
  await resetDisposableDb(db);
  userId = await seedAccount(db, "history@example.com");
  otherUserId = await seedAccount(db, "other-history@example.com");
  await activateFreshAbNative(db);
  const company = await db.company.create({ data: { label: "Acme", value: "history-acme", createdBy: userId } });
  jobId = (await db.jobOpportunity.create({ data: { userId, companyId: company.id, title: "Engineer" } })).id;
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await Promise.all([db.$disconnect(), db2.$disconnect()]);
  try { fs.rmSync(ctx.dir, { recursive: true, force: true }); } catch { /* Windows file handles may close late. */ }
});

async function graph(owner = userId) {
  const service = variants(db, owner);
  const material = await new CareerMaterialService(db, owner, env).create({ type: "PROJECT", title: "Captured A" });
  const variant = await service.createVariant({ name: "Historical resume" });
  const versionId = variant.currentVersionId!;
  const section = await service.createSection({ versionId, title: "Projects" });
  const item = await service.createSectionItem({ sectionId: section.id, careerMaterialItemId: material.id });
  const expression = await service.createExpression({ itemId: item.id, content: "Built an analytical engine." });
  const evidence = await db.careerEvidence.create({ data: { materialItemId: material.id, kind: "FACT", content: "Engine delivered" } });
  return { variant, versionId, section, item, expression, material, evidence };
}
async function attempt() {
  return applications().createAttempt({ jobOpportunityId: jobId, channelLabel: "Direct" });
}
async function artifact(versionId: string) {
  return db.resumeArtifact.create({ data: { resumeVariantVersionId: versionId, kind: "EXPORT", format: "PDF", storageKey: "unused-test-key", fileName: "test.pdf", sha256: "test-hash" } });
}
function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// Intercept real queries without replacing their DB semantics. Both clients
// reach the writer boundary; the first is held until the second arrives.
function controlledClients(model: "resumeVariantVersion" | "applicationAttempt") {
  const locked = latch(), release = latch(), contender = latch();
  let firstWrite = true, secondWrite = true;
  const isLock = (name: string | undefined, operation: string) => model === "applicationAttempt"
    ? operation === "$executeRaw" : name?.toLowerCase() === model.toLowerCase() && operation === "updateMany";
  const first = db.$extends({ query: { async $allOperations({ model: name, operation, args, query }) {
    const result = await query(args);
    if (isLock(name, operation) && firstWrite) {
      firstWrite = false; locked.resolve(); await release.promise;
    }
    return result;
  } } });
  const second = new Proxy(db2, { get(target, property, receiver) {
    if (property === "$transaction") return (...args: unknown[]) => {
      if (secondWrite) { secondWrite = false; contender.resolve(); }
      return Reflect.apply(target.$transaction, target, args);
    };
    return Reflect.get(target, property, receiver);
  } });
  // Prisma extensions keep the same transaction/delegate surface at runtime.
  return { first: first as unknown as PrismaClient, second: second as unknown as PrismaClient, locked, release, contender };
}

// DB-heavy suite: per-test bodies do many sequential writes and can exceed
// the default 5s timeout under full-suite CPU contention.
describe("version-owned title authority", { timeout: 20_000 }, () => {
  it.each(["FROZEN", "SUBMITTED"])("keeps %s preview, print, text and Agent review input stable after live rename", async (status) => {
    const g = await graph();
    if (status === "FROZEN") await variants().freeze(g.versionId);
    else await applications().submitApplication({ attemptId: (await attempt()).id, submittedResumeVersionId: g.versionId });
    await db.careerMaterialItem.update({ where: { id: g.material.id }, data: { title: "Live B" } });
    const version = await variants().getVersion(g.versionId);
    expect(version.sections[0].items[0].materialTitleSnapshot).toBe("Captured A");
    for (const print of [false, true]) {
      const html = renderToStaticMarkup(createElement(ResumePreview, { ...version, print }));
      expect(html).toContain("Captured A"); expect(html).not.toContain("Live B");
    }
    expect(projectResumeVariantText(version)).toContain("Captured A");
    const agentInput = (await readAbResumeVariant(db, userId, g.variant.id))!.text;
    expect(agentInput).toContain("Captured A"); expect(agentInput).not.toContain("Live B");
    expect(buildResumeReviewPrompt(agentInput)).toContain("Captured A");
    expect(buildResumeReviewPrompt(agentInput)).not.toContain("Live B");
  });
  it("copies the frozen snapshot when cloning, even after the source material changes", async () => {
    const g = await graph(); await variants().freeze(g.versionId);
    await db.careerMaterialItem.update({ where: { id: g.material.id }, data: { title: "Live B" } });
    const clone = await variants().cloneAsDraft(g.versionId);
    for (const id of [g.versionId, clone.id]) {
      expect(projectResumeVariantText(await variants().getVersion(id))).toContain("Captured A");
      expect(projectResumeVariantText(await variants().getVersion(id))).not.toContain("Live B");
    }
  });
  it("old backup rows restore null and never fall back to a live title", async () => {
    const g = await graph();
    const { materialTitleSnapshot: _snapshot, ...oldRow } = g.item;
    const restored = BackupDataSchema.parse({ ResumeVariantSectionItem: [oldRow] }).ResumeVariantSectionItem[0];
    expect(restored.materialTitleSnapshot).toBeNull();
    await db.resumeVariantSectionItem.update({ where: { id: g.item.id }, data: { materialTitleSnapshot: restored.materialTitleSnapshot } });
    const version = await variants().getVersion(g.versionId);
    expect(projectResumeVariantText(version)).not.toContain("Captured A");
    expect((await readAbResumeVariant(db, userId, g.variant.id))!.text).not.toContain("Captured A");
    expect(renderToStaticMarkup(createElement(ResumePreview, version))).not.toContain("Captured A");
  });
});

describe("atomic immutable mutation boundary", { timeout: 20_000 }, () => {
  it("rolls back evidence replacement and evidenceStatus if any requested evidence is not owned", async () => {
    const g = await graph(), foreign = await graph(otherUserId);
    await provenance().linkEvidenceToExpression({ expressionId: g.expression.id, evidenceId: g.evidence.id });
    const before = await variants().getVersion(g.versionId);
    await expect(provenance().replaceExpressionEvidence({ expressionId: g.expression.id, evidenceIds: [foreign.evidence.id] })).rejects.toHaveProperty("code", "EVIDENCE_NOT_FOUND");
    expect(await variants().getVersion(g.versionId)).toEqual(before);
  });
  it.each(["FROZEN", "SUBMITTED", "ARCHIVED", "REFERENCED_DRAFT", "ARCHIVED_VARIANT"])("rejects all content mutations for %s without partial writes", async (state) => {
    const g = await graph();
    if (state === "REFERENCED_DRAFT") await db.applicationAttempt.update({ where: { id: (await attempt()).id }, data: { submittedResumeVersionId: g.versionId } });
    else if (state === "ARCHIVED_VARIANT") await variants().archiveVariant(g.variant.id);
    else await db.resumeVariantVersion.update({ where: { id: g.versionId }, data: { status: state } });
    const before = await variants().getVersion(g.versionId);
    const s = variants(), p = provenance();
    const writes = [
      () => s.updateDraft(g.versionId, { locale: "en" }),
      () => s.updateHeaderSnapshot(g.versionId, { fullName: "Changed" }),
      () => s.createSection({ versionId: g.versionId, title: "Changed" }),
      () => s.updateSection({ sectionId: g.section.id, title: "Changed" }),
      () => s.deleteSection(g.section.id), () => s.reorderSections(g.versionId, [g.section.id]),
      () => s.createSectionItem({ sectionId: g.section.id }),
      () => s.updateSectionItem({ itemId: g.item.id, itemKind: "MANUAL" }),
      () => s.deleteSectionItem(g.item.id), () => s.reorderSectionItems(g.section.id, [g.item.id]),
      () => s.moveSectionItem(g.item.id, g.section.id, null),
      () => s.createExpression({ itemId: g.item.id, content: "Changed" }),
      () => s.updateExpression({ expressionId: g.expression.id, content: "Changed" }),
      () => s.deleteExpression(g.expression.id), () => s.reorderExpressions(g.item.id, [g.expression.id]),
      () => p.linkEvidenceToExpression({ expressionId: g.expression.id, evidenceId: g.evidence.id }),
      () => p.unlinkEvidenceFromExpression({ expressionId: g.expression.id, evidenceId: g.evidence.id }),
      () => p.replaceExpressionEvidence({ expressionId: g.expression.id, evidenceIds: [g.evidence.id] }),
    ];
    for (const write of writes) await expect(write()).rejects.toHaveProperty("code");
    expect(await variants().getVersion(g.versionId)).toEqual(before);
    await expect(s.freeze(g.versionId)).rejects.toHaveProperty("code");
  });
});

describe("two independent SQLite clients with controlled writer ordering", { timeout: 20_000 }, () => {
  it.each(["edit-first", "freeze-first"])("serializes edit/freeze: %s", async (order) => {
    const g = await graph(), c = controlledClients("resumeVariantVersion");
    const first = order === "edit-first"
      ? variants(c.first).updateExpression({ expressionId: g.expression.id, content: "Committed edit" })
      : variants(c.first).freeze(g.versionId);
    await c.locked.promise;
    const second = order === "edit-first" ? variants(c.second).freeze(g.versionId)
      : variants(c.second).updateExpression({ expressionId: g.expression.id, content: "Stale edit" });
    const settled = Promise.allSettled([first, second]);
    await c.contender.promise; c.release.resolve();
    const results = await settled;
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe(order === "edit-first" ? "fulfilled" : "rejected");
    if (order === "freeze-first") expect((results[1] as PromiseRejectedResult).reason.code).toBe("VERSION_IMMUTABLE");
    const version = await variants().getVersion(g.versionId);
    expect(version.status).toBe("FROZEN");
    expect(version.sections[0].items[0].expressions[0].content).toBe(order === "edit-first" ? "Committed edit" : "Built an analytical engine.");
  });
  it.each(["freeze-first", "submit-first"])("never writes SUBMITTED back to FROZEN: %s", async (order) => {
    const g = await graph(), c = controlledClients("resumeVariantVersion");
    const first = order === "freeze-first" ? variants(c.first).freeze(g.versionId) : variants(c.first).markSubmitted(g.versionId);
    await c.locked.promise;
    const second = order === "freeze-first" ? variants(c.second).markSubmitted(g.versionId) : variants(c.second).freeze(g.versionId);
    const settled = Promise.allSettled([first, second]);
    await c.contender.promise; c.release.resolve();
    const results = await settled;
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe(order === "freeze-first" ? "fulfilled" : "rejected");
    expect((await variants().getVersion(g.versionId)).status).toBe("SUBMITTED");
  });
  it.each(["submitApplication", "attachSubmissionProvenance"] as const)("has a single first-binding winner, business conflict and unchanged loser via %s", async (method) => {
    const a = await graph(), b = await graph(), target = await attempt(), c = controlledClients("applicationAttempt");
    const first = applications(c.first)[method]({ attemptId: target.id, submittedResumeVersionId: a.versionId });
    await c.locked.promise;
    const second = applications(c.second)[method]({ attemptId: target.id, submittedResumeVersionId: b.versionId });
    const settled = Promise.allSettled([first, second]);
    await c.contender.promise; c.release.resolve();
    const results = await settled;
    expect(results[0].status).toBe("fulfilled"); expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.code).toBe("SUBMITTED_RESUME_PROVENANCE");
    expect((await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } })).submittedResumeVersionId).toBe(a.versionId);
    expect((await variants().getVersion(b.versionId)).status).toBe("DRAFT");
  });
});

describe("submission and historical provenance", { timeout: 20_000 }, () => {
  it.each(["FROZEN", "SUBMITTED"])("preserves an unknown frozenAt on historical %s transition/replay", async (status) => {
    const g = await graph();
    await db.resumeVariantVersion.update({ where: { id: g.versionId }, data: { status, frozenAt: null } });
    const submitted = await variants().markSubmitted(g.versionId);
    expect(submitted.status).toBe("SUBMITTED"); expect(submitted.frozenAt).toBeNull();
    expect((await variants().markSubmitted(g.versionId)).frozenAt).toBeNull();
  });
  it("accepts an explicit older JD and later only allows identical provenance replay", async () => {
    await syncJdVersion(db, jobId, "Explicit JD v1", null);
    const oldJd = (await db.jobOpportunity.findUniqueOrThrow({ where: { id: jobId } })).currentJdVersionId!;
    await syncJdVersion(db, jobId, "Current JD v2", null);
    const target = await attempt();
    const submitted = await applications().submitApplication({ attemptId: target.id, submittedAgainstJdVersionId: oldJd });
    expect(submitted.submittedAgainstJdVersionId).toBe(oldJd);
    expect(await applications().attachSubmissionProvenance({ attemptId: target.id, submittedAgainstJdVersionId: oldJd })).toEqual(submitted);
    const g = await graph();
    await expect(applications().submitApplication({ attemptId: target.id, submittedResumeVersionId: g.versionId })).rejects.toHaveProperty("code", "ATTEMPT_ALREADY_SUBMITTED");
    expect((await variants().getVersion(g.versionId)).status).toBe("DRAFT");
  });
  it.each(["SUBMITTED", "ASSESSMENT", "INTERVIEW", "OFFER", "CLOSED", "REJECTED", "WITHDRAWN", "HIRED"])("backfills %s without changing lifecycle, including null historical submittedAt", async (stage) => {
    const g = await graph(), target = await attempt();
    const previous = await db.applicationAttempt.update({ where: { id: target.id }, data: { currentStageCategory: stage, outcome: ["REJECTED", "WITHDRAWN", "HIRED"].includes(stage) ? stage : "ACTIVE", submittedAt: stage === "INTERVIEW" ? null : new Date("2020-01-01") } });
    await db.applicationProcessStep.create({ data: { applicationAttemptId: target.id, category: "INTERVIEW", label: "Original interview", sortOrder: 10, status: "COMPLETED", source: "USER" } });
    const steps = await db.applicationProcessStep.findMany();
    await syncJdVersion(db, jobId, "Current JD must not be guessed", null);
    const bound = await applications().attachSubmissionProvenance({ attemptId: target.id, submittedResumeVersionId: g.versionId });
    expect(bound.currentStageCategory).toBe(previous.currentStageCategory); expect(bound.outcome).toBe(previous.outcome);
    expect(bound.submittedAt).toEqual(previous.submittedAt); expect(bound.submittedAgainstJdVersionId).toBeNull();
    expect(await db.applicationProcessStep.findMany()).toEqual(steps);
  });
  it("same-value and null replay preserve provenance, stage, submittedAt and frozenAt", async () => {
    const g = await graph(), target = await attempt(); await variants().freeze(g.versionId);
    const art = await artifact(g.versionId); await syncJdVersion(db, jobId, "JD v1", null);
    const input = { attemptId: target.id, submittedResumeVersionId: g.versionId, submittedResumeArtifactId: art.id };
    const submitted = await applications().submitApplication(input), frozenAt = (await variants().getVersion(g.versionId)).frozenAt;
    expect(await applications().submitApplication({ ...input, submittedAt: new Date() })).toEqual(submitted);
    await db.applicationAttempt.update({ where: { id: target.id }, data: { currentStageCategory: "INTERVIEW" } });
    const previous = await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } });
    const replay = await applications().attachSubmissionProvenance({ ...input, submittedAgainstJdVersionId: submitted.submittedAgainstJdVersionId });
    expect(replay).toEqual(previous);
    expect(await applications().attachSubmissionProvenance({ attemptId: target.id, submittedResumeVersionId: null, submittedResumeArtifactId: null, submittedAgainstJdVersionId: null })).toEqual(previous);
    expect((await variants().getVersion(g.versionId)).frozenAt).toEqual(frozenAt);
  });
  it("rolls back a successful Resume transition when the final Attempt CAS throws", async () => {
    const g = await graph(), target = await attempt();
    let transitioned = false;
    const failing = db.$extends({ query: {
      resumeVariantVersion: { async updateMany({ args, query }) {
        const result = await query(args);
        if (args.data.status === "SUBMITTED" && result.count === 1) transitioned = true;
        return result;
      } },
      applicationAttempt: { async updateMany({ args, query }) {
        if ("submittedResumeVersionId" in args.data) {
          expect(transitioned).toBe(true);
          throw new Error("Injected Attempt update failure");
        }
        return query(args);
      } },
    } });
    await expect(applications(failing as unknown as PrismaClient).submitApplication({ attemptId: target.id, submittedResumeVersionId: g.versionId })).rejects.toThrow("Injected");
    expect(transitioned).toBe(true);
    expect((await variants().getVersion(g.versionId)).status).toBe("DRAFT");
    expect((await variants().getVersion(g.versionId)).frozenAt).toBeNull();
    expect(await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } })).toEqual(target);
  });
  it("captures the JD current at submission, never at draft creation or subsequent save", async () => {
    await syncJdVersion(db, jobId, "JD v1", null);
    const target = await attempt(); expect(target.submittedAgainstJdVersionId).toBeNull();
    await syncJdVersion(db, jobId, "JD v2", null);
    const current = (await db.jobOpportunity.findUniqueOrThrow({ where: { id: jobId } })).currentJdVersionId;
    const submitted = await applications().submitApplication({ attemptId: target.id });
    expect(submitted.submittedAgainstJdVersionId).toBe(current);
    await syncJdVersion(db, jobId, "JD v3", null);
    await syncApplicationFromUiStatus(db, userId, jobId, "interview", { applied: true, env });
    const saved = await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } });
    expect(saved.submittedAgainstJdVersionId).toBe(current); expect(saved.submittedAt).toEqual(submitted.submittedAt);
    expect(saved.currentStageCategory).toBe("INTERVIEW");
    await syncApplicationFromUiStatus(db, userId, jobId, "interview", { applied: true, env });
    expect(await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({ currentStageCategory: saved.currentStageCategory, outcome: saved.outcome, submittedAt: saved.submittedAt, submittedAgainstJdVersionId: saved.submittedAgainstJdVersionId });
  });
  it("keeps a submitted JD v1 after v2 is published, and refuses JD rebinding", async () => {
    await syncJdVersion(db, jobId, "JD v1", null);
    const target = await attempt(), submitted = await applications().submitApplication({ attemptId: target.id });
    await syncJdVersion(db, jobId, "JD v2", null);
    const nextJd = (await db.jobOpportunity.findUniqueOrThrow({ where: { id: jobId } })).currentJdVersionId;
    await expect(applications().attachSubmissionProvenance({ attemptId: target.id, submittedAgainstJdVersionId: nextJd })).rejects.toHaveProperty("code", "SUBMISSION_PROVENANCE_CONFLICT");
    expect(await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } })).toEqual(submitted);
  });
  it("submits without a JD and leaves unknown provenance null after a JD is added", async () => {
    const target = await attempt(); await applications().submitApplication({ attemptId: target.id });
    await syncJdVersion(db, jobId, "Later JD", null);
    await applications().submitApplication({ attemptId: target.id });
    expect((await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } })).submittedAgainstJdVersionId).toBeNull();
  });
  it.each(["INTERVIEW", "CLOSED", "ARCHIVED", "INACTIVE"])("does not infer initial submission from a null timestamp for %s", async (state) => {
    const target = await attempt();
    await db.applicationAttempt.update({ where: { id: target.id }, data: state === "ARCHIVED" ? { archivedAt: new Date() } : state === "INACTIVE" ? { outcome: "REJECTED" } : { currentStageCategory: state } });
    const before = await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } });
    await expect(applications().submitApplication({ attemptId: target.id })).rejects.toHaveProperty("code", "ATTEMPT_NOT_SUBMITTABLE");
    expect(await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } })).toEqual(before);
  });
  it("validates cross-user versions/artifacts, artifact-version consistency and cross-job JD without side effects", async () => {
    const a = await graph(), b = await graph(), foreign = await graph(otherUserId), target = await attempt();
    const artB = await artifact(b.versionId), foreignArt = await artifact(foreign.versionId);
    const otherJob = await db.jobOpportunity.create({ data: { userId, companyId: (await db.jobOpportunity.findUniqueOrThrow({ where: { id: jobId } })).companyId, title: "Other role" } });
    await syncJdVersion(db, otherJob.id, "Other job JD", null);
    const foreignJd = (await db.jobOpportunity.findUniqueOrThrow({ where: { id: otherJob.id } })).currentJdVersionId;
    const inputs = [ { submittedResumeVersionId: foreign.versionId }, { submittedResumeArtifactId: foreignArt.id },
      { submittedResumeVersionId: a.versionId, submittedResumeArtifactId: artB.id }, { submittedAgainstJdVersionId: foreignJd } ];
    for (const input of inputs) {
      await expect(applications().submitApplication({ attemptId: target.id, ...input })).rejects.toHaveProperty("code");
      expect(await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } })).toEqual(target);
      expect((await variants().getVersion(a.versionId)).status).toBe("DRAFT");
    }
    const bound = await applications().attachSubmissionProvenance({ attemptId: target.id, submittedResumeArtifactId: artB.id });
    expect(bound.submittedResumeVersionId).toBe(b.versionId);
    const artA = await artifact(a.versionId);
    await expect(applications().attachSubmissionProvenance({ attemptId: target.id, submittedResumeArtifactId: artA.id })).rejects.toHaveProperty("code");
    expect(await db.applicationAttempt.findUniqueOrThrow({ where: { id: target.id } })).toEqual(bound);
    await db.resumeVariantVersion.update({ where: { id: a.versionId }, data: { status: "ARCHIVED" } });
    await expect(variants().markSubmitted(a.versionId)).rejects.toHaveProperty("code", "VERSION_IMMUTABLE");
  });
});

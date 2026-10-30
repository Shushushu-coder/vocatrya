// @vitest-environment node
/**
 * RESUME-BUILDER §5 I5/I6 — item-level import exclusions.
 *
 *   I5  two-step confirm: the COMPLETE signed parse validates verbatim
 *       first; only then is the exclusion selection checked and the
 *       persistence subset built. Exclusions never launder bad items.
 *   I6  selection-signature idempotency: same requestId + same selection
 *       replays the committed variant; a different selection on an already
 *       confirmed requestId is refused (IMPORT_CONFIRMATION_IMMUTABLE);
 *       pre-feature rows only accept the default (keep-all) selection.
 */
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { makeResumeExportTestContext } from "./helpers/resumeExportTestDb";
import { activateFreshAbNative } from "@/lib/career/freshActivation";
import { persistResumeImport } from "@/lib/career/canonicalResumeImport";
import {
  canonicalImportSelection,
  importItemRef,
  importPreviewRefs,
  parseImportItemRef,
  resolveImportSelection,
  selectImportSubset,
} from "@/lib/career/resumeImportSelection";
import {
  decodeResumeImportResultJson,
} from "@/lib/career/resumeImportAttempt";
import { importFixture, importRawText } from "./helpers/canonicalImportFixture";

const ctx = makeResumeExportTestContext();
const db = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
let userId: string;
let connectionId: string;

const input = (requestId = randomUUID()) => ({
  requestId, name: "Synthetic Import", rawText: importRawText,
  parsed: structuredClone(importFixture),
  resolvedConnectionId: connectionId, resolvedModel: "test-model",
});
const selection = (excludedItemRefs: string[] = [], excludeProfileImport = false) =>
  ({ excludedItemRefs, excludeProfileImport });
const attempt = (requestId: string) =>
  db.resumeImportAttempt.create({ data: {
    id: requestId, userId, requestSha: "test-sha", state: "EXECUTED",
    resultJson: JSON.stringify(importFixture),
  } });
const counts = async () => ({
  materials: await db.careerMaterialItem.count(),
  evidence: await db.careerEvidence.count(),
  variants: await db.resumeVariant.count(),
  versions: await db.resumeVariantVersion.count(),
  sections: await db.resumeVariantSection.count(),
  sectionItems: await db.resumeVariantSectionItem.count(),
  expressions: await db.resumeExpression.count(),
  profile: await db.candidateProfile.count(),
});

beforeAll(async () => {
  await activateFreshAbNative(db);
  userId = (await db.user.create({ data: { name: "Selection", email: "selection@example.com", password: "test" } })).id;
  connectionId = (await db.aIConnection.create({ data: { userId, provider: "CODEX", backendKind: "CODEX_CLI", displayName: "Test" } })).id;
});
afterAll(async () => {
  await db.$disconnect();
  const os = await import("node:os"); const path = await import("node:path");
  expect(path.relative(os.tmpdir(), ctx.dir)).not.toMatch(/^\.\./);
  await fs.rm(ctx.dir, { recursive: true, force: true });
});

describe("selection normalization", () => {
  it("defaults to keep-everything and emits one ref per parsed item", () => {
    expect(importPreviewRefs(importFixture)).toEqual(["s0.it0", "s1.it0", "s2.it0", "s3.it0"]);
    const resolved = resolveImportSelection(importFixture, undefined);
    expect(resolved.refs).toEqual([]);
    expect(resolved.excludeProfileImport).toBe(false);
    expect(canonicalImportSelection(resolved))
      .toBe(JSON.stringify({ excludedItemRefs: [], excludeProfileImport: false }));
  });
  it("deduplicates and sorts refs; subset drops the item and an emptied section", () => {
    const resolved = resolveImportSelection(importFixture, selection(["s3.it0", "s1.it0", "s1.it0"]));
    expect(resolved.refs).toEqual(["s1.it0", "s3.it0"]);
    const kept = selectImportSubset(importFixture, resolved);
    expect(kept.sections.map((section) => section.title)).toEqual(["教育经历", "项目经历"]);
    expect(kept.sections[1].items[0].title).toBe("订单系统");
    // The signed parse itself is untouched — facts are never rewritten.
    expect(importFixture.sections).toHaveLength(4);
  });
  it.each([
    ["bad format", selection(["x1.it0"])],
    ["section-only ref", selection(["s1"])],
    ["extra suffix", selection(["s1.it0.x"])],
    ["out-of-bounds section", selection(["s9.it0"])],
    ["out-of-bounds item", selection(["s0.it5"])],
    ["non-string ref", { excludedItemRefs: [7], excludeProfileImport: false }],
    ["non-array refs", { excludedItemRefs: "s1.it0", excludeProfileImport: false }],
    ["non-object payload", "s1.it0" as unknown as never],
    ["non-boolean flag", { excludedItemRefs: [], excludeProfileImport: "yes" }],
  ])("rejects %s as IMPORT_EXCLUSION_INVALID", (_case, payload) => {
    expect(() => resolveImportSelection(importFixture, payload)).toThrow("IMPORT_EXCLUSION_INVALID");
  });
  it("rejects excluding every item as IMPORT_EXCLUSION_EMPTY", () => {
    expect(() => resolveImportSelection(importFixture, selection(importPreviewRefs(importFixture))))
      .toThrow("IMPORT_EXCLUSION_EMPTY");
    // Even when the profile would still be imported — items are what count.
    expect(() => resolveImportSelection(importFixture,
      selection(importPreviewRefs(importFixture), false))).toThrow("IMPORT_EXCLUSION_EMPTY");
  });
  it("builds refs from positions regardless of display order", () => {
    expect(importItemRef(2, 3)).toBe("s2.it3");
    expect(parseImportItemRef("s2.it3")).toEqual([2, 3]);
    expect(parseImportItemRef("bogus")).toBeNull();
  });
});

describe("persistence subset", () => {
  it("persists only kept items: material, graph, expressions and evidence of excluded items never appear", async () => {
    const before = await counts();
    const request = input();
    await attempt(request.requestId);
    const variant = await persistResumeImport(db, userId,
      { ...request, selection: selection(["s0.it0", "s3.it0"]) }, env);
    const sections = await db.resumeVariantSection.findMany({
      where: { version: { resumeVariantId: variant.id } },
      include: { items: { include: { expressions: true } } }, orderBy: { sortOrder: "asc" },
    });
    expect(sections.map((section) => section.title)).toEqual(["实习经历", "项目经历"]);
    expect(sections.map((section) => section.sortOrder)).toEqual([0, 1]);
    // Excluded EDUCATION and SKILL material was never created or reused.
    expect(await db.careerMaterialItem.count({ where: { type: { in: ["EDUCATION", "SKILL"] } } })).toBe(0);
    expect(await db.careerMaterialItem.count({ where: { type: { in: ["INTERNSHIP", "PROJECT"] } } })).toBe(2);
    // Evidence candidates of kept items still land.
    expect(await db.careerEvidence.count()).toBeGreaterThan(0);
    expect(await counts()).toMatchObject({
      materials: before.materials + 2, variants: before.variants + 1,
      versions: before.versions + 1, profile: before.profile + 1,
    });
  });
  it("excludeProfileImport skips the CandidateProfile backfill but keeps the variant", async () => {
    const request = input();
    await attempt(request.requestId);
    // Pin the profile to a sentinel state: the flag must not backfill the rest.
    await db.candidateProfile.upsert({ where: { userId },
      create: { userId, phone: "sentinel-phone" },
      update: { phone: "sentinel-phone", fullName: null, email: null } });
    const before = await counts();
    const variant = await persistResumeImport(db, userId,
      { ...request, selection: selection([], true) }, env);
    const profile = await db.candidateProfile.findUnique({ where: { userId } });
    expect(profile).toMatchObject({ phone: "sentinel-phone", fullName: null, email: null });
    const version = await db.resumeVariantVersion.findFirstOrThrow({
      where: { resumeVariantId: variant.id } });
    // The header snapshot still reflects the user's real profile, read-only.
    expect(version.headerSnapshot).toContain("sentinel-phone");
    expect(await counts()).toMatchObject({ variants: before.variants + 1, profile: before.profile });
  });
  it("validates the complete parse BEFORE the selection — excluding a bad item cannot bypass", async () => {
    const request = input();
    await attempt(request.requestId);
    request.parsed.sections[1].items[0].sourceText = "伪造的原文";
    await expect(persistResumeImport(db, userId,
      { ...request, selection: selection(["s1.it0"]) }, env))
      .rejects.toThrow("IMPORT_SOURCE_MISMATCH");
    expect(await db.resumeVariant.count({ where: { id: request.requestId } })).toBe(0);
  });
  it("invalid or empty selections write nothing", async () => {
    const before = await counts();
    for (const payload of [selection(["bogus"]), selection(importPreviewRefs(importFixture))]) {
      const request = input();
      await attempt(request.requestId);
      await expect(persistResumeImport(db, userId, { ...request, selection: payload }, env))
        .rejects.toThrow(/^IMPORT_EXCLUSION_/);
    }
    expect(await counts()).toEqual(before);
  });
});

describe("selection-signature idempotency (I6)", () => {
  it("records the selection sha on the attempt; same requestId + same selection replays", async () => {
    const request = input();
    await attempt(request.requestId);
    const picked = selection(["s1.it0", "s3.it0"]);
    const variant = await persistResumeImport(db, userId, { ...request, selection: picked }, env);
    const stored = (await db.resumeImportAttempt.findUniqueOrThrow({ where: { id: request.requestId } })).resultJson;
    const decoded = decodeResumeImportResultJson(stored);
    expect(decoded.confirmedSelectionSha).toMatch(/^[0-9a-f]{64}$/);
    // The cached model payload survives verbatim for post-confirm preview retries.
    expect(decoded.value).toEqual(importFixture);
    const before = await counts();
    expect((await persistResumeImport(db, userId, { ...request, selection: picked }, env)).id).toBe(variant.id);
    // Replay is exact: duplicate refs canonicalize to the same signature.
    expect((await persistResumeImport(db, userId,
      { ...request, selection: selection(["s3.it0", "s1.it0", "s1.it0"]) }, env)).id).toBe(variant.id);
    expect(await counts()).toEqual(before);
  });
  it("rejects a different selection on the same requestId", async () => {
    const request = input();
    await attempt(request.requestId);
    const variant = await persistResumeImport(db, userId, { ...request, selection: selection(["s1.it0"]) }, env);
    const variantCount = await db.resumeVariant.count({ where: { userId } });
    await expect(persistResumeImport(db, userId, { ...request, selection: selection(["s2.it0"]) }, env))
      .rejects.toThrow("IMPORT_CONFIRMATION_IMMUTABLE");
    await expect(persistResumeImport(db, userId, { ...request, selection: selection([], true) }, env))
      .rejects.toThrow("IMPORT_CONFIRMATION_IMMUTABLE");
    expect(await db.resumeVariant.count({ where: { userId } })).toBe(variantCount);
    expect(await db.resumeVariant.count({ where: { id: variant.id } })).toBe(1);
  });
  it("pre-feature imports without a stored signature replay only the default selection", async () => {
    const request = input();
    await attempt(request.requestId);
    const variant = await persistResumeImport(db, userId, { ...request, selection: selection(["s1.it0"]) }, env);
    // Simulate a pre-feature row: raw resultJson without the envelope.
    await db.resumeImportAttempt.update({ where: { id: request.requestId },
      data: { resultJson: JSON.stringify(importFixture) } });
    expect((await persistResumeImport(db, userId, request, env)).id).toBe(variant.id);
    await expect(persistResumeImport(db, userId, { ...request, selection: selection(["s1.it0"]) }, env))
      .rejects.toThrow("IMPORT_CONFIRMATION_IMMUTABLE");
  });
  it("an unconfirmed retry may carry a different selection — only the first successful commit sticks", async () => {
    const request = input();
    await attempt(request.requestId);
    const failing = db.$extends({ query: { resumeExpression: { create() { throw new Error("forced midway failure"); } } } });
    await expect(persistResumeImport(failing as unknown as PrismaClient, userId,
      { ...request, selection: selection(["s0.it0"]) }, env)).rejects.toThrow("forced midway failure");
    expect(await db.resumeVariant.count({ where: { id: request.requestId } })).toBe(0);
    const variant = await persistResumeImport(db, userId, { ...request, selection: selection(["s2.it0"]) }, env);
    expect((await persistResumeImport(db, userId, { ...request, selection: selection(["s2.it0"]) }, env)).id).toBe(variant.id);
    await expect(persistResumeImport(db, userId, { ...request, selection: selection(["s0.it0"]) }, env))
      .rejects.toThrow("IMPORT_CONFIRMATION_IMMUTABLE");
  });
  it("refuses to persist when the durable attempt row is missing (fail closed)", async () => {
    const request = input();
    const before = await counts();
    await expect(persistResumeImport(db, userId,
      { ...request, selection: selection(["s1.it0"]) }, env))
      .rejects.toThrow("IMPORT_ATTEMPT_REQUIRED");
    expect(await counts()).toEqual(before);
    expect(await db.resumeVariant.count({ where: { id: request.requestId } })).toBe(0);
  });
  it("another user cannot confirm over someone else's requestId", async () => {
    const request = input();
    await attempt(request.requestId);
    await persistResumeImport(db, userId, { ...request, selection: selection(["s1.it0"]) }, env);
    const otherId = (await db.user.create({ data: { name: "Other", email: `other-${randomUUID()}@example.com`, password: "test" } })).id;
    const before = await counts();
    await expect(persistResumeImport(db, otherId, { ...request, selection: selection(["s1.it0"]) }, env))
      .rejects.toThrow();
    expect(await counts()).toEqual(before);
    expect(await db.resumeVariant.count({ where: { id: request.requestId, userId: otherId } })).toBe(0);
  });
});

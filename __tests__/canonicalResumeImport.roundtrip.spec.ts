// @vitest-environment node
// Route-level round trip for the account-login AI import closure — the
// durable EXECUTED attempt replays the settled parse result locally, so
// preview → per-item exclusion → confirm → reopen runs through the REAL
// attempt, approval and persistence services with no model call. Only
// transport edges (auth, file extraction, preprocessing, rate limit) are
// stubbed.
import { NextRequest } from "next/server";

const ctx = await vi.hoisted(async () => {
  const { makeResumeExportTestContext } = await import("./helpers/resumeExportTestDb");
  return makeResumeExportTestContext();
});
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return { default: new PrismaClient({ datasources: { db: { url: ctx.url } } }) };
});
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/ai/import/extract-text", async (original) => ({
  ...await original<typeof import("@/lib/ai/import/extract-text")>(),
  extractText: vi.fn(async () => ({ success: true, data: { text: importRawText, truncated: false } })),
}));
vi.mock("@/lib/ai/tools/preprocessing", () => ({
  preprocessText: vi.fn(async () => ({ success: true, data: { normalizedText: importRawText } })),
}));
vi.mock("@/lib/ai/rate-limiter", () => ({ checkRateLimit: () => ({ allowed: true }) }));

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import db from "@/lib/db";
import { auth } from "@/auth";
import { POST } from "@/app/api/profile/resume-import/route";
import { activateFreshAbNative } from "@/lib/career/freshActivation";
import { ResumeVariantService } from "@/lib/career/resumeVariantService";
import { importFixture, importRawText } from "./helpers/canonicalImportFixture";

const env: NodeJS.ProcessEnv = { NODE_ENV: "test" };
let userId: string;
let connectionId: string;
const requestSha = createHash("sha256").update(importRawText).digest("hex");

const upload = (requestId: string) => {
  const form = new FormData();
  form.set("file", new File(["%PDF-roundtrip"], "Synthetic.pdf", { type: "application/pdf" }));
  form.set("requestId", requestId);
  return new NextRequest("http://localhost/api/profile/resume-import", { method: "POST", body: form });
};
const confirm = (body: unknown) => new NextRequest("http://localhost/api/profile/resume-import", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const seedExecutedAttempt = (requestId: string) => db.resumeImportAttempt.create({ data: {
  id: requestId, userId, requestSha, state: "EXECUTED",
  resultJson: JSON.stringify(importFixture),
  resolvedConnectionId: connectionId, resolvedModel: "test-model",
} });

beforeAll(async () => {
  await activateFreshAbNative(db);
  userId = (await db.user.create({ data: { name: "Roundtrip", email: "roundtrip@example.com", password: "test" } })).id;
  connectionId = (await db.aIConnection.create({ data: { userId, provider: "CODEX", backendKind: "CODEX_CLI", displayName: "Test" } })).id;
});
beforeEach(() => {
  vi.mocked(auth).mockResolvedValue({ user: { id: userId } } as never);
});
afterAll(async () => {
  await db.$disconnect();
  expect(path.relative(os.tmpdir(), ctx.dir)).not.toMatch(/^\.\./);
  await fs.rm(ctx.dir, { recursive: true, force: true });
});

it("upload replays the settled parse; excluded items never persist and reopen reads back the kept subset", async () => {
  const requestId = randomUUID();
  await seedExecutedAttempt(requestId);

  const previewResponse = await POST(upload(requestId));
  expect(previewResponse.status).toBe(200);
  const preview = await previewResponse.json();
  expect(preview.previewRefs).toEqual(["s0.it0", "s1.it0", "s2.it0", "s3.it0"]);
  expect(typeof preview.approval).toBe("string");
  // Preview must not persist anything.
  expect(await db.resumeVariant.count()).toBe(0);
  expect(await db.careerMaterialItem.count()).toBe(0);

  // Exclude the internship item and the profile backfill.
  const confirmResponse = await POST(confirm({
    approval: preview.approval,
    excludedItemRefs: ["s1.it0"],
    excludeProfileImport: true,
  }));
  expect(confirmResponse.status).toBe(200);
  const { variantId } = await confirmResponse.json();
  expect(variantId).toBe(requestId);

  // Excluded facts never reach the database; kept items persist intact.
  expect(await db.careerMaterialItem.count()).toBe(3);
  expect(await db.careerMaterialItem.count({ where: { type: "INTERNSHIP" } })).toBe(0);
  expect(await db.candidateProfile.findUnique({ where: { userId } })).toBeNull();
  const attempt = await db.resumeImportAttempt.findUniqueOrThrow({ where: { id: requestId } });
  expect(attempt.state).toBe("CONFIRMED");
  expect(attempt.confirmedSelectionSha).toMatch(/^[0-9a-f]{64}$/);

  // Reopen: the kept graph reads back exactly — sections, items, expressions.
  const variant = await db.resumeVariant.findUniqueOrThrow({ where: { id: variantId } });
  const version = await new ResumeVariantService(db, userId, env).getVersion(variant.currentVersionId!);
  const titles = version.sections.map((section) => section.title);
  expect(titles).toEqual(["教育经历", "项目经历", "技能"]);
  expect(titles).not.toContain("实习经历");
  const contents = version.sections.flatMap((section) => section.items)
    .flatMap((item) => item.expressions.map((expression) => expression.content)).join("\n");
  expect(contents).toContain("订单系统");
  expect(contents).not.toContain("某科技公司");

  // The same selection replays to the same variant; a changed selection is refused.
  const replay = await POST(confirm({
    approval: preview.approval,
    excludedItemRefs: ["s1.it0"],
    excludeProfileImport: true,
  }));
  expect(replay.status).toBe(200);
  expect((await replay.json()).variantId).toBe(variantId);
  expect(await db.resumeVariant.count()).toBe(1);
  const changed = await POST(confirm({ approval: preview.approval, excludedItemRefs: ["s2.it0"] }));
  expect(changed.status).toBe(409);
  expect((await changed.json()).code).toBe("IMPORT_CONFIRMATION_IMMUTABLE");
  expect(await db.resumeVariant.count()).toBe(1);
});

it("an unsettled attempt surfaces AI_NOT_CONFIGURED with zero writes when no RESUME assignment exists", async () => {
  const requestId = randomUUID();
  await db.resumeImportAttempt.create({ data: { id: requestId, userId, requestSha, state: "PENDING" } });
  const response = await POST(upload(requestId));
  expect(response.status).toBe(502);
  expect((await response.json()).code).toBe("AI_NOT_CONFIGURED");
  expect(await db.resumeVariant.count()).toBe(1); // only the first test's variant
  // NOT_CONFIGURED is not an invocation failure — the attempt stays retriable
  // so the same requestId succeeds once an assignment exists.
  expect((await db.resumeImportAttempt.findUniqueOrThrow({ where: { id: requestId } })).state).toBe("PENDING");
});

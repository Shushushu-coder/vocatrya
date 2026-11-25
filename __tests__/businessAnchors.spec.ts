// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { resolveVerifiedBusinessAnchors } from "@/lib/agent/businessAnchors.server";
import type { AgentConversationContextV1 } from "@/lib/agent/conversationContext";
import { FRESH_NATIVE_KEY } from "@/lib/career/identities";
import { makeAbTestDbUrl, migrateDeploy, preparePrismaProject } from "./helpers/abSchemaTestDb";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

const ctx = makeAbTestDbUrl();
const db = new PrismaClient({ datasourceUrl: ctx.url });

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

let savedAbEnabled: string | undefined;
let savedAbScope: string | undefined;

beforeAll(() => {
  savedAbEnabled = process.env.VOCATRYA_AB_RUNTIME_ENABLED;
  savedAbScope = process.env.VOCATRYA_AB_ROLLOUT_SCOPE;
  delete process.env.VOCATRYA_AB_RUNTIME_ENABLED;
  delete process.env.VOCATRYA_AB_ROLLOUT_SCOPE;
  migrateDeploy(ctx.url, preparePrismaProject(ctx.dir));
}, 120_000);

beforeEach(async () => {
  delete process.env.VOCATRYA_AB_RUNTIME_ENABLED;
  delete process.env.VOCATRYA_AB_ROLLOUT_SCOPE;
  await resetDisposableDb(db);
});

afterAll(async () => {
  if (savedAbEnabled !== undefined) process.env.VOCATRYA_AB_RUNTIME_ENABLED = savedAbEnabled;
  if (savedAbScope !== undefined) process.env.VOCATRYA_AB_ROLLOUT_SCOPE = savedAbScope;
  await db.$disconnect();
  const target = path.resolve(ctx.dir);
  if (path.dirname(target) === path.resolve(os.tmpdir()) && path.basename(target).startsWith("vocatrya-ab-schema-")) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup on Windows.
    }
  }
});

async function enableFreshAbRuntime() {
  await db.abMigrationState.create({
    data: {
      scopeKey: "instance",
      migrationKey: FRESH_NATIVE_KEY,
      status: "FRESH_READY",
      completedAt: null,
      verifiedAt: new Date("2026-11-25T00:00:00.000Z"),
    },
  });
}

describe("businessAnchors.server L3 verification", () => {
  it("verifies AB job (+ newer JD), resume version, and today_plan without leaking database IDs", async () => {
    await enableFreshAbRuntime();
    const userId = await seedAccount(db, `ab-${randomUUID()}@example.com`);
    const company = await db.company.create({
      data: { label: "Apex Cloud", value: `apex-${randomUUID()}`, createdBy: userId },
    });
    const opp = await db.jobOpportunity.create({
      data: {
        userId,
        companyId: company.id,
        title: "Staff Platform Engineer",
        status: "ACTIVE",
      },
    });
    const jdv1 = await db.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: opp.id,
        versionNumber: 1,
        rawContent: "Build resilient distributed backends",
        capturedAt: new Date("2026-11-20T00:00:00.000Z"),
        contentHash: `hash-v1-${randomUUID()}`,
      },
    });
    const jdv2 = await db.jobDescriptionVersion.create({
      data: {
        jobOpportunityId: opp.id,
        versionNumber: 2,
        rawContent: "Build resilient distributed backends and mentor staff engineers",
        capturedAt: new Date("2026-11-24T00:00:00.000Z"),
        contentHash: `hash-v2-${randomUUID()}`,
      },
    });
    await db.jobOpportunity.update({
      where: { id: opp.id },
      data: { currentJdVersionId: jdv1.id },
    });

    const variant = await db.resumeVariant.create({
      data: { userId, name: "Backend Platform Resume" },
    });
    const rv2 = await db.resumeVariantVersion.create({
      data: { resumeVariantId: variant.id, versionNumber: 2, status: "FROZEN" },
    });
    await db.resumeVariant.update({
      where: { id: variant.id },
      data: { currentVersionId: rv2.id },
    });

    const conv = await db.chatConversation.create({
      data: { userId, title: "Target Role", messages: "[]" },
    });

    const tOverdue = await db.task.create({
      data: { userId, title: "Submit architecture portfolio", status: "in-progress" },
    });
    const tTodayOpen = await db.task.create({
      data: { userId, title: "Tailor STAR stories", status: "in-progress" },
    });
    const tTodayDone = await db.task.create({
      data: { userId, title: "Export PDF", status: "complete" },
    });
    const tTomorrow = await db.task.create({
      data: { userId, title: "Mock system design", status: "in-progress" },
    });
    await db.todayPlanItem.createMany({
      data: [
        { userId, conversationId: conv.id, taskId: tOverdue.id, plannedOn: "2026-11-24", position: 1 },
        { userId, conversationId: conv.id, taskId: tTodayOpen.id, plannedOn: "2026-11-25", position: 1 },
        { userId, conversationId: conv.id, taskId: tTodayDone.id, plannedOn: "2026-11-25", position: 2 },
        { userId, conversationId: conv.id, taskId: tTomorrow.id, plannedOn: "2026-11-26", position: 1 },
      ],
    });

    const context: AgentConversationContextV1 = {
      version: 1,
      items: [
        {
          kind: "job",
          entityId: opp.id,
          labelSnapshot: "Staff Platform Engineer · Apex Cloud",
          source: "MANUAL",
        },
        {
          kind: "resume",
          entityId: variant.id,
          labelSnapshot: "Backend Platform Resume",
          source: "MANUAL",
        },
      ],
    };
    const now = new Date("2026-11-25T10:00:00.000Z");

    const zh = await resolveVerifiedBusinessAnchors(db, {
      userId,
      conversationId: conv.id,
      context,
      locale: "zh-CN",
      timeZone: "UTC",
      now,
    });
    expect(zh.excludedCount).toBe(0);
    expect(zh.job).toMatchObject({
      title: "Staff Platform Engineer",
      company: "Apex Cloud",
      status: "ACTIVE",
      jdVersionNumber: 1,
      latestJdVersionNumber: 2,
      hasDescription: true,
      newerVersionAvailable: true,
    });
    expect(zh.resume).toMatchObject({
      title: "Backend Platform Resume",
      versionNumber: 2,
      versionStatus: "FROZEN",
    });
    expect(zh.todayPlan).toMatchObject({
      todayTotal: 2,
      todayCompleted: 1,
      overdueCount: 1,
      tomorrowCount: 1,
    });
    expect(zh.todayPlan?.openTitles).toEqual(["Submit architecture portfolio", "Tailor STAR stories"]);

    expect(zh.renderedBlock).toContain("已核验业务锚点");
    expect(zh.renderedBlock).toContain("Staff Platform Engineer · Apex Cloud");
    expect(zh.renderedBlock).toContain("JD v1（最新 v2）");
    expect(zh.renderedBlock).toContain("Backend Platform Resume");
    expect(zh.renderedBlock).toContain("v2（FROZEN）");
    expect(zh.renderedBlock).toContain("今日已完成 1/2，逾期 1，明日 1");
    expect(zh.renderedBlock).toContain("Submit architecture portfolio");

    const en = await resolveVerifiedBusinessAnchors(db, {
      userId,
      conversationId: conv.id,
      context,
      locale: "en",
      timeZone: "UTC",
      now,
    });
    expect(en.renderedBlock).toContain("Verified business anchors (live SQLite state, post-compaction):");
    expect(en.renderedBlock).toContain("JD v1 (latest v2)");
    expect(en.renderedBlock).toContain("today 1/2 done, overdue 1, tomorrow 1");

    for (const block of [zh.renderedBlock, en.renderedBlock]) {
      expect(block).not.toMatch(UUID_PATTERN);
      for (const secretId of [userId, company.id, opp.id, jdv1.id, jdv2.id, variant.id, rv2.id, conv.id, tOverdue.id]) {
        expect(block).not.toContain(secretId);
      }
    }
  });

  it("verifies legacy Job, Resume, and today_plan anchors when AB runtime is inactive", async () => {
    const userId = await seedAccount(db, `legacy-${randomUUID()}@example.com`);
    const company = await db.company.create({
      data: { label: "Legacy Corp", value: `legacy-corp-${randomUUID()}`, createdBy: userId },
    });
    const title = await db.jobTitle.create({
      data: { label: "Backend Lead", value: `backend-lead-${randomUUID()}`, createdBy: userId },
    });
    const status = await db.jobStatus.create({
      data: { label: "Applied", value: `applied-${randomUUID()}` },
    });
    const job = await db.job.create({
      data: {
        userId,
        companyId: company.id,
        jobTitleId: title.id,
        statusId: status.id,
        description: "Lead core API services.",
        jobType: "full-time",
        createdAt: new Date("2026-11-24T00:00:00.000Z"),
      },
    });
    const profile = await db.profile.create({ data: { userId } });
    const resume = await db.resume.create({
      data: { profileId: profile.id, title: "Legacy CV" },
    });
    const conv = await db.chatConversation.create({
      data: { userId, title: "Legacy Conv", messages: "[]" },
    });
    const task = await db.task.create({
      data: { userId, title: "Follow up recruiter", status: "in-progress" },
    });
    await db.todayPlanItem.create({
      data: { userId, conversationId: conv.id, taskId: task.id, plannedOn: "2026-11-25", position: 1 },
    });

    const result = await resolveVerifiedBusinessAnchors(db, {
      userId,
      conversationId: conv.id,
      context: {
        version: 1,
        items: [
          { kind: "job", entityId: job.id, labelSnapshot: "Old Stale Label", source: "MANUAL" },
          { kind: "resume", entityId: resume.id, labelSnapshot: "Old CV Label", source: "MANUAL" },
        ],
      },
      locale: "en",
      timeZone: "UTC",
      now: new Date("2026-11-25T10:00:00.000Z"),
    });

    expect(result.excludedCount).toBe(0);
    expect(result.job).toMatchObject({
      title: "Backend Lead",
      company: "Legacy Corp",
      status: "Applied",
      jdVersionNumber: null,
      hasDescription: true,
    });
    expect(result.resume).toMatchObject({
      title: "Legacy CV",
      versionNumber: null,
    });
    expect(result.todayPlan).toMatchObject({
      todayTotal: 1,
      todayCompleted: 0,
      openTitles: ["Follow up recruiter"],
    });
    expect(result.renderedBlock).toContain("Backend Lead · Legacy Corp");
    expect(result.renderedBlock).toContain("Legacy CV (current version");
    expect(result.renderedBlock).not.toMatch(UUID_PATTERN);
  });

  it("excludes archived, missing, and cross-user entities without name-matching", async () => {
    await enableFreshAbRuntime();
    const aliceId = await seedAccount(db, `alice-${randomUUID()}@example.com`);
    const bobId = await seedAccount(db, `bob-${randomUUID()}@example.com`);

    const aliceCompany = await db.company.create({
      data: { label: "Shared Co", value: `shared-a-${randomUUID()}`, createdBy: aliceId },
    });
    const bobCompany = await db.company.create({
      data: { label: "Shared Co", value: `shared-b-${randomUUID()}`, createdBy: bobId },
    });

    const archivedJob = await db.jobOpportunity.create({
      data: {
        userId: aliceId,
        companyId: aliceCompany.id,
        title: "Archived Role",
        archivedAt: new Date("2026-11-24T00:00:00.000Z"),
      },
    });
    // Alice has an unlinked active job with the exact same title as Bob's job —
    // verification must strictly key on userId + entityId, never bind by title.
    await db.jobOpportunity.create({
      data: {
        userId: aliceId,
        companyId: aliceCompany.id,
        title: "Cross Tenant Secret Role",
      },
    });
    const bobJob = await db.jobOpportunity.create({
      data: {
        userId: bobId,
        companyId: bobCompany.id,
        title: "Cross Tenant Secret Role",
      },
    });
    const bobResume = await db.resumeVariant.create({
      data: { userId: bobId, name: "Bob Private CV" },
    });

    const conv = await db.chatConversation.create({
      data: { userId: aliceId, title: "Isolation", messages: "[]" },
    });

    const res = await resolveVerifiedBusinessAnchors(db, {
      userId: aliceId,
      conversationId: conv.id,
      context: {
        version: 1,
        items: [
          { kind: "job", entityId: archivedJob.id, labelSnapshot: "Archived Role", source: "MANUAL" },
          { kind: "job", entityId: bobJob.id, labelSnapshot: "Cross Tenant Secret Role", source: "MANUAL" },
          { kind: "resume", entityId: "non-existent-resume-id", labelSnapshot: "Ghost Resume", source: "MANUAL" },
          { kind: "resume", entityId: bobResume.id, labelSnapshot: "Bob Private CV", source: "MANUAL" },
        ],
      },
      locale: "zh-CN",
      timeZone: "UTC",
      now: new Date("2026-11-25T10:00:00.000Z"),
    });

    expect(res.job).toBeNull();
    expect(res.resume).toBeNull();
    expect(res.excludedCount).toBe(4);
    expect(res.renderedBlock).toContain("4 项已归档、删除或无权访问");
    expect(res.renderedBlock).not.toContain("Cross Tenant Secret Role");
    expect(res.renderedBlock).not.toContain("Bob Private CV");
    expect(res.renderedBlock).not.toContain("Archived Role");
  });

  it("strips archived ResumeVariantVersion metadata from an otherwise active resume", async () => {
    await enableFreshAbRuntime();
    const userId = await seedAccount(db, `ver-${randomUUID()}@example.com`);
    const variant = await db.resumeVariant.create({
      data: { userId, name: "Product Resume" },
    });
    const archivedVersion = await db.resumeVariantVersion.create({
      data: { resumeVariantId: variant.id, versionNumber: 4, status: "ARCHIVED" },
    });
    await db.resumeVariant.update({
      where: { id: variant.id },
      data: { currentVersionId: archivedVersion.id },
    });
    const conv = await db.chatConversation.create({
      data: { userId, messages: "[]" },
    });

    const res = await resolveVerifiedBusinessAnchors(db, {
      userId,
      conversationId: conv.id,
      context: {
        version: 1,
        items: [{ kind: "resume", entityId: variant.id, labelSnapshot: "Product Resume", source: "MANUAL" }],
      },
      locale: "en",
      timeZone: "UTC",
    });

    expect(res.resume).toMatchObject({
      title: "Product Resume",
      versionNumber: null,
      versionStatus: null,
    });
    expect(res.renderedBlock).toContain("Product Resume (current version");
    expect(res.renderedBlock).not.toContain("v4");
  });
});

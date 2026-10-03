// @vitest-environment node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
  writeInstanceMigrationState,
} from "@/lib/career";
import { createOpportunityFromJobForm } from "@/lib/career/jobOpportunityAdapter";
import { preprocessText } from "@/lib/ai/tools/preprocessing";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const ctx = makeTestDbUrl();
process.env.DATABASE_URL = ctx.url;
delete process.env[AB_RUNTIME_FEATURE_ENV];
delete process.env[AB_ROLLOUT_SCOPE_ENV];

type JobRead = typeof import("@/lib/agent/canonicalJobRead");
type ResumeRead = typeof import("@/lib/agent/resumeLookup");
type JobWrite = typeof import("@/lib/agent/jobLookup");
type ContextServer = typeof import("@/lib/agent/conversationContext.server");

let appPrisma: PrismaClient;
let jobs: JobRead;
let resumes: ResumeRead;
let legacyJobs: JobWrite;
let server: ContextServer;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  pushSchema(ctx.url);
  const dbMod = await import("@/lib/db");
  appPrisma = dbMod.default;
  jobs = await import("@/lib/agent/canonicalJobRead");
  resumes = await import("@/lib/agent/resumeLookup");
  legacyJobs = await import("@/lib/agent/jobLookup");
  server = await import("@/lib/agent/conversationContext.server");
}, 120_000);

afterAll(async () => {
  await appPrisma?.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  delete process.env[AB_RUNTIME_FEATURE_ENV];
  delete process.env[AB_ROLLOUT_SCOPE_ENV];
  await resetDisposableDb(appPrisma);
  userId = await seedAccount(appPrisma, `agent-read-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    appPrisma,
    `agent-read-other-${Date.now()}@example.com`,
  );
});

function enable(scope: "full" | "resume_v1" | "none") {
  if (scope === "none") return;
  process.env[AB_RUNTIME_FEATURE_ENV] = "true";
  process.env[AB_ROLLOUT_SCOPE_ENV] = scope;
}

async function createLegacyJob(ownerId: string, label: string, company: string) {
  const status = await appPrisma.jobStatus.findFirstOrThrow({ where: { value: "draft" } });
  const title = await appPrisma.jobTitle.create({
    data: { label, value: `${label}-${randomUUID()}`, createdBy: ownerId },
  });
  const companyRow = await appPrisma.company.create({
    data: { label: company, value: `${company}-${randomUUID()}`, createdBy: ownerId },
  });
  return appPrisma.job.create({
    data: {
      userId: ownerId,
      description: `${label} description that is long enough to read`,
      jobType: "FT",
      createdAt: new Date(),
      statusId: status.id,
      jobTitleId: title.id,
      companyId: companyRow.id,
    },
  });
}

async function createOpportunity(ownerId: string, description: string) {
  const company = await appPrisma.company.create({
    data: { label: "Acme", value: `acme-${randomUUID()}`, createdBy: ownerId },
  });
  const title = await appPrisma.jobTitle.create({
    data: { label: "Engineer", value: `eng-${randomUUID()}`, createdBy: ownerId },
  });
  const location = await appPrisma.location.create({
    data: { label: "Remote", value: `remote-${randomUUID()}`, createdBy: ownerId },
  });
  const source = await appPrisma.jobSource.findFirstOrThrow({ where: { createdBy: ownerId } });
  const status = await appPrisma.jobStatus.findFirstOrThrow({ where: { value: "draft" } });
  return createOpportunityFromJobForm(
    appPrisma,
    ownerId,
    {
      title: title.id,
      company: company.id,
      location: location.id,
      type: "FT",
      source: source.id,
      status: status.id,
      dueDate: new Date(),
      jobDescription: description,
      applied: false,
    },
  );
}

async function createLegacyResume(ownerId: string, title: string) {
  const profile = await appPrisma.profile.create({ data: { userId: ownerId } });
  return appPrisma.resume.create({ data: { profileId: profile.id, title } });
}

async function createVariant(
  ownerId: string,
  name: string,
  currentMarker: string,
  otherMarker: string,
) {
  const variant = await appPrisma.resumeVariant.create({
    data: { userId: ownerId, name },
  });
  const older = await appPrisma.resumeVariantVersion.create({
    data: { resumeVariantId: variant.id, versionNumber: 1, status: "DRAFT" },
  });
  const newer = await appPrisma.resumeVariantVersion.create({
    data: { resumeVariantId: variant.id, versionNumber: 2, status: "DRAFT" },
  });
  await addExpression(older.id, currentMarker);
  await addExpression(newer.id, otherMarker);
  await appPrisma.resumeVariant.update({
    where: { id: variant.id },
    data: { currentVersionId: older.id },
  });
  return { variant, currentVersionId: older.id };
}

async function addExpression(versionId: string, content: string) {
  const section = await appPrisma.resumeVariantSection.create({
    data: { resumeVariantVersionId: versionId, title: "Experience", sortOrder: 0 },
  });
  const item = await appPrisma.resumeVariantSectionItem.create({
    data: {
      resumeVariantSectionId: section.id,
      itemKind: "CUSTOM",
      sortOrder: 0,
    },
  });
  await appPrisma.resumeExpression.create({
    data: {
      resumeVariantSectionItemId: item.id,
      kind: "BULLET",
      content,
      sortOrder: 0,
    },
  });
}

const LONG = `${"Built production services and wrote design notes. ".repeat(8)}`;

describe("agent canonical job reads", () => {
  it("lists and gets a legacy job, and hides another user's job", async () => {
    const job = await createLegacyJob(userId, "Legacy Title", "Legacy Co");
    await createLegacyJob(otherUserId, "Other Title", "Other Co");

    const listed = await jobs.listJobsForAgent(userId);
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") return;
    expect(listed.jobs.map((row) => row.id)).toEqual([job.id]);
    expect(listed.jobs[0]).toMatchObject({
      title: "Legacy Title",
      company: "Legacy Co",
    });

    const loaded = await jobs.getJobForAgent(userId, job.id);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.job.id).toBe(job.id);
      expect(loaded.job.jobDescription).toContain("Legacy Title description");
    }
    expect(await jobs.getJobForAgent(userId, randomUUID())).toEqual({ status: "no_job" });
    expect((await jobs.listJobsForAgent(otherUserId)).status).toBe("ok");
    const other = await jobs.listJobsForAgent(userId);
    expect(other.status === "ok" && other.jobs.some((row) => row.company === "Other Co")).toBe(false);
  });

  it("returns an empty list when the caller has no jobs", async () => {
    const listed = await jobs.listJobsForAgent(userId);
    expect(listed).toMatchObject({ status: "ok", jobs: [], total: 0, truncated: false });
  });

  it("reads the A+B opportunity My Jobs can see, including from page context", async () => {
    enable("full");
    await activateFreshAbNative(appPrisma);
    const opportunity = await createOpportunity(userId, "Canonical posting for the agent");
    const page = await server.resolvePageContextItems(userId, { jobId: opportunity.id });
    expect(page.items[0]?.entityId).toBe(opportunity.id);

    const listed = await jobs.listJobsForAgent(userId);
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") return;
    expect(listed.jobs.map((row) => row.id)).toEqual([opportunity.id]);

    const loaded = await jobs.getJobForAgent(userId, listed.jobs[0].id);
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok") {
      expect(loaded.job.id).toBe(page.items[0].entityId);
      expect(loaded.job.jobDescription).toContain("Canonical posting");
      expect(loaded.job).not.toHaveProperty("abCompat");
    }
    expect(await legacyJobs.resolveJobForAgent(userId, opportunity.id)).toEqual({
      status: "no_job",
    });
    expect(await jobs.getJobForAgent(otherUserId, opportunity.id)).toEqual({ status: "no_job" });
  });

  it("reads opportunities when A+B is ready but disabled, and not the legacy row", async () => {
    enable("full");
    await activateFreshAbNative(appPrisma);
    const opportunity = await createOpportunity(userId, "Ready disabled posting");
    delete process.env[AB_RUNTIME_FEATURE_ENV];
    delete process.env[AB_ROLLOUT_SCOPE_ENV];
    const legacy = await createLegacyJob(userId, "Hidden Legacy", "Hidden Co");
    const listed = await jobs.listJobsForAgent(userId);
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") return;
    expect(listed.jobs.map((row) => row.id)).toEqual([opportunity.id]);
    expect(listed.jobs.some((row) => row.id === legacy.id)).toBe(false);
    const loaded = await jobs.getJobForAgent(userId, legacy.id);
    expect(loaded).toEqual({ status: "no_job" });
  });

  it("keeps resume_v1 job reads on the legacy family", async () => {
    enable("full");
    await activateFreshAbNative(appPrisma);
    const opportunity = await createOpportunity(userId, "Not the job list yet");
    const legacy = await createLegacyJob(userId, "Scoped Legacy", "Scoped Co");
    enable("resume_v1");
    const listed = await jobs.listJobsForAgent(userId);
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") return;
    expect(listed.jobs.map((row) => row.id)).toEqual([legacy.id]);
    expect(listed.jobs.some((row) => row.id === opportunity.id)).toBe(false);
  });

  it("does not fall back to a legacy job when the runtime is blocked", async () => {
    const legacy = await createLegacyJob(userId, "Blocked Title", "Blocked Co");
    await writeInstanceMigrationState(appPrisma, {
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
    });
    const listed = await jobs.listJobsForAgent(userId);
    expect(listed.status).toBe("unavailable");
    const loaded = await jobs.getJobForAgent(userId, legacy.id);
    expect(loaded.status).toBe("unavailable");
    expect(JSON.stringify(loaded)).not.toContain(legacy.id);
  });
});

describe("agent canonical resume reads", () => {
  it("reads a legacy resume when legacy is the resume family", async () => {
    const resume = await createLegacyResume(userId, "Legacy CV");
    const loaded = await resumes.resolveCanonicalResumeForAgent(userId, {});
    expect(loaded.status).toBe("ok");
    if (loaded.status === "ok" && loaded.family !== "ab") {
      expect(loaded.resume.id).toBe(resume.id);
      expect(loaded.source).toBe("only");
    }
  });

  it("reads the current resume variant version and ignores a legacy resume", async () => {
    enable("full");
    await activateFreshAbNative(appPrisma);
    const { variant, currentVersionId } = await createVariant(
      userId,
      "Campus Resume",
      `CURRENT_VERSION_MARKER ${LONG}`,
      `NEWER_VERSION_MARKER ${LONG}`,
    );
    const loaded = await resumes.resolveCanonicalResumeForAgent(userId, {});
    expect(loaded.status).toBe("ok");
    if (loaded.status !== "ok" || loaded.family !== "ab") {
      throw new Error("expected the A+B resume projection");
    }
    expect(loaded.id).toBe(variant.id);
    expect(loaded.versionId).toBe(currentVersionId);
    expect(loaded.text).toContain("CURRENT_VERSION_MARKER");
    expect(loaded.text).not.toContain("NEWER_VERSION_MARKER");
    const pre = await preprocessText(loaded.text);
    expect(pre.success).toBe(true);
    expect(await resumes.resolveResumeForAgent(userId, {})).toEqual({ status: "no_resumes" });
    expect(await resumes.resolveCanonicalResumeForAgent(otherUserId, {
      pageResumeId: variant.id,
    })).toEqual({ status: "no_resumes" });
  });

  it("asks which variant when several are visible", async () => {
    enable("resume_v1");
    await activateFreshAbNative(appPrisma);
    await createVariant(userId, "Alpha Resume", `ALPHA ${LONG}`, `ALPHA_OLD ${LONG}`);
    await createVariant(userId, "Beta Resume", `BETA ${LONG}`, `BETA_OLD ${LONG}`);
    const loaded = await resumes.resolveCanonicalResumeForAgent(userId, {});
    expect(loaded.status).toBe("needs_selection");
    if (loaded.status === "needs_selection") {
      expect(loaded.resumes.map((resume) => resume.title).sort()).toEqual([
        "Alpha Resume",
        "Beta Resume",
      ]);
    }
    const named = await resumes.resolveCanonicalResumeForAgent(userId, {
      title: "beta resume",
    });
    expect(named.status).toBe("ok");
    if (named.status === "ok" && named.family === "ab") {
      expect(named.title).toBe("Beta Resume");
      expect(named.text).toContain("BETA");
    }
  });

  it("does not read either resume family when the runtime is blocked", async () => {
    await createLegacyResume(userId, "Blocked CV");
    await writeInstanceMigrationState(appPrisma, {
      status: AB_MIGRATION_STATUS.IN_PROGRESS,
    });
    const loaded = await resumes.resolveCanonicalResumeForAgent(userId, {});
    expect(loaded.status).toBe("unavailable");
  });
});

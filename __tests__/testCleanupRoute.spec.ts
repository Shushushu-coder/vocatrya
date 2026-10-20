import type { PrismaClient } from "@prisma/client";
import { auth } from "@/auth";
import { makeTestDbUrl, pushSchema, seedAccount } from "./helpers/backupTestDb";

vi.mock("@/auth", () => ({
  auth: vi.fn(),
}));

type CleanupPost = (req: { json: () => Promise<unknown> }) => Promise<{
  status: number;
  json: () => Promise<{ success?: boolean; error?: string; code?: string }>;
}>;

let prisma: PrismaClient;
let POST: CleanupPost;

beforeAll(async () => {
  const made = makeTestDbUrl();
  pushSchema(made.url);
  process.env.DATABASE_URL = made.url;
  vi.resetModules();
  delete (globalThis as { prismaGlobal?: PrismaClient }).prismaGlobal;
  prisma = (await import("@/lib/db")).default;
  POST = (await import("@/app/api/test/cleanup/route")).POST as unknown as CleanupPost;
}, 180_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function post(userId: string | null, body: Record<string, unknown>) {
  vi.mocked(auth).mockResolvedValue(
    userId ? ({ user: { id: userId } } as never) : (null as never),
  );
  return POST({ json: async () => body });
}

async function library(
  userId: string,
  label: string,
  model: "company" | "location" | "jobTitle",
) {
  const value = label.trim().toLowerCase();
  if (model === "company") {
    return prisma.company.create({ data: { label, value, createdBy: userId } });
  }
  if (model === "location") {
    return prisma.location.create({ data: { label, value, createdBy: userId } });
  }
  return prisma.jobTitle.create({ data: { label, value, createdBy: userId } });
}

async function opportunityGraph(userId: string, label: string) {
  const company = await library(userId, `${label} company`, "company");
  const location = await library(userId, `${label} location`, "location");
  const title = await library(userId, `${label} title`, "jobTitle");
  const opportunity = await prisma.jobOpportunity.create({
    data: {
      userId,
      companyId: company.id,
      title: title.label,
      locationText: location.label,
    },
  });
  const version = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opportunity.id,
      versionNumber: 1,
      rawContent: `${label} description`,
      capturedAt: new Date(),
      contentHash: `hash-${opportunity.id}`,
    },
  });
  await prisma.jobOpportunity.update({
    where: { id: opportunity.id },
    data: { currentJdVersionId: version.id },
  });
  const attempt = await prisma.applicationAttempt.create({
    data: {
      userId,
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
      submittedAgainstJdVersionId: version.id,
    },
  });
  const step = await prisma.applicationProcessStep.create({
    data: {
      applicationAttemptId: attempt.id,
      category: "OTHER",
      label: `${label} step`,
      sortOrder: 10,
    },
  });
  return { company, location, title, opportunity, version, attempt, step };
}

async function legacyJob(userId: string, label: string) {
  const company = await library(userId, `${label} company`, "company");
  const location = await library(userId, `${label} location`, "location");
  const title = await library(userId, `${label} title`, "jobTitle");
  const status = await prisma.jobStatus.findFirstOrThrow();
  const job = await prisma.job.create({
    data: {
      userId,
      companyId: company.id,
      locationId: location.id,
      jobTitleId: title.id,
      statusId: status.id,
      description: `${label} description`,
      jobType: "FULL_TIME",
      createdAt: new Date(),
    },
  });
  return { company, location, title, job };
}

describe("POST /api/test/cleanup", () => {
  it("returns 404 in production", async () => {
    const env = process.env as { NODE_ENV?: string };
    const previous = env.NODE_ENV;
    env.NODE_ENV = "production";
    try {
      const response = await post("user", {});
      expect(response.status).toBe(404);
    } finally {
      env.NODE_ENV = previous;
    }
  });

  it("returns 401 when the caller is not authenticated", async () => {
    const response = await post(null, {});
    expect(response.status).toBe(401);
  });

  it("removes a legacy job and its unused library rows", async () => {
    const userId = await seedAccount(prisma, "legacy-cleanup@example.com");
    const created = await legacyJob(userId, "Legacy Role");
    const response = await post(userId, {
      jobIds: [created.job.id],
      titles: [created.title.label],
      companies: [created.company.label],
      locations: [created.location.label],
    });
    expect(response.status).toBe(200);
    expect(await prisma.job.count({ where: { id: created.job.id } })).toBe(0);
    expect(await prisma.company.count({ where: { id: created.company.id } })).toBe(0);
    expect(await prisma.location.count({ where: { id: created.location.id } })).toBe(0);
    expect(await prisma.jobTitle.count({ where: { id: created.title.id } })).toBe(0);
  });

  it("removes an owned opportunity, attempts, steps, and description versions", async () => {
    const userId = await seedAccount(prisma, "canonical-cleanup@example.com");
    const created = await opportunityGraph(userId, "Canonical Role");
    const body = {
      jobIds: [created.opportunity.id],
      titles: [created.title.label],
      companies: [created.company.label],
      locations: [created.location.label],
    };
    const first = await post(userId, body);
    expect(first.status).toBe(200);
    expect(await prisma.jobOpportunity.count({ where: { id: created.opportunity.id } })).toBe(0);
    expect(await prisma.applicationAttempt.count({ where: { id: created.attempt.id } })).toBe(0);
    expect(await prisma.applicationProcessStep.count({ where: { id: created.step.id } })).toBe(0);
    expect(await prisma.jobDescriptionVersion.count({ where: { id: created.version.id } })).toBe(0);
    expect(await prisma.company.count({ where: { id: created.company.id } })).toBe(0);
    expect(await prisma.location.count({ where: { id: created.location.id } })).toBe(0);
    expect(await prisma.jobTitle.count({ where: { id: created.title.id } })).toBe(0);

    const second = await post(userId, body);
    expect(second.status).toBe(200);
    expect(await prisma.jobOpportunity.count({ where: { userId } })).toBe(0);
    expect(await prisma.company.count({ where: { createdBy: userId } })).toBe(0);
  });

  it("keeps a company another owned opportunity still references", async () => {
    const userId = await seedAccount(prisma, "shared-company@example.com");
    const company = await library(userId, "Shared Co", "company");
    const first = await prisma.jobOpportunity.create({
      data: { userId, companyId: company.id, title: "First" },
    });
    const second = await prisma.jobOpportunity.create({
      data: { userId, companyId: company.id, title: "Second" },
    });
    const response = await post(userId, {
      jobIds: [first.id],
      companies: [company.label],
    });
    expect(response.status).toBe(200);
    expect(await prisma.jobOpportunity.count({ where: { id: first.id } })).toBe(0);
    expect(await prisma.jobOpportunity.count({ where: { id: second.id } })).toBe(1);
    expect(await prisma.company.count({ where: { id: company.id } })).toBe(1);
  });

  it("keeps a company a recruitment campaign still references", async () => {
    const userId = await seedAccount(prisma, "campaign-company@example.com");
    const company = await library(userId, "Campaign Co", "company");
    const campaign = await prisma.recruitmentCampaign.create({
      data: { userId, companyId: company.id, name: "2026" },
    });
    const response = await post(userId, { companies: [company.label] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(await prisma.company.count({ where: { id: company.id } })).toBe(1);
    expect(await prisma.recruitmentCampaign.count({ where: { id: campaign.id } })).toBe(1);
  });

  it("does not delete another user's rows", async () => {
    const ownerId = await seedAccount(prisma, "owner-cleanup@example.com");
    const otherId = await seedAccount(prisma, "other-cleanup@example.com");
    const owned = await opportunityGraph(ownerId, "Owned Role");
    const other = await opportunityGraph(otherId, "Owned Role");
    const response = await post(ownerId, {
      jobIds: [owned.opportunity.id, other.opportunity.id],
      titles: [owned.title.label, other.title.label],
      companies: [owned.company.label, other.company.label],
      locations: [owned.location.label, other.location.label],
    });
    expect(response.status).toBe(200);
    expect(await prisma.jobOpportunity.count({ where: { id: owned.opportunity.id } })).toBe(0);
    expect(await prisma.jobOpportunity.count({ where: { id: other.opportunity.id } })).toBe(1);
    expect(await prisma.applicationAttempt.count({ where: { id: other.attempt.id } })).toBe(1);
    expect(await prisma.applicationProcessStep.count({ where: { id: other.step.id } })).toBe(1);
    expect(await prisma.company.count({ where: { id: other.company.id } })).toBe(1);
    expect(await prisma.jobTitle.count({ where: { id: other.title.id } })).toBe(1);
    expect(await prisma.location.count({ where: { id: other.location.id } })).toBe(1);
  });

  it("rolls back when another user's attempt still references the opportunity", async () => {
    const ownerId = await seedAccount(prisma, "rollback-owner@example.com");
    const otherId = await seedAccount(prisma, "rollback-other@example.com");
    const owned = await opportunityGraph(ownerId, "Blocked Role");
    const legacy = await legacyJob(ownerId, "Blocked Legacy");
    const foreign = await prisma.applicationAttempt.create({
      data: {
        userId: otherId,
        jobOpportunityId: owned.opportunity.id,
        channelLabel: "USER",
      },
    });
    const response = await post(ownerId, {
      jobIds: [legacy.job.id, owned.opportunity.id],
      titles: [owned.title.label, legacy.title.label],
      companies: [owned.company.label, legacy.company.label],
      locations: [owned.location.label, legacy.location.label],
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: "Cleanup failed",
      code: "P2003",
    });
    expect(await prisma.job.count({ where: { id: legacy.job.id } })).toBe(1);
    expect(await prisma.jobOpportunity.count({ where: { id: owned.opportunity.id } })).toBe(1);
    expect(await prisma.applicationAttempt.count({ where: { id: owned.attempt.id } })).toBe(1);
    expect(await prisma.applicationProcessStep.count({ where: { id: owned.step.id } })).toBe(1);
    expect(await prisma.jobDescriptionVersion.count({ where: { id: owned.version.id } })).toBe(1);
    expect(
      await prisma.jobOpportunity.findUnique({
        where: { id: owned.opportunity.id },
        select: { currentJdVersionId: true },
      }),
    ).toEqual({ currentJdVersionId: owned.version.id });
    expect(await prisma.applicationAttempt.count({ where: { id: foreign.id } })).toBe(1);
    expect(await prisma.company.count({ where: { id: owned.company.id } })).toBe(1);
    expect(await prisma.company.count({ where: { id: legacy.company.id } })).toBe(1);
  });

  it("refuses to clear a resume variant or an external transfer pointer", async () => {
    const userId = await seedAccount(prisma, "blocked-owner@example.com");
    const owned = await opportunityGraph(userId, "Variant Role");
    const variant = await prisma.resumeVariant.create({
      data: {
        userId,
        name: "Targeted",
        targetJobOpportunityId: owned.opportunity.id,
      },
    });
    const variantResponse = await post(userId, {
      jobIds: [owned.opportunity.id],
      companies: [owned.company.label],
    });
    expect(variantResponse.status).toBe(500);
    expect(await variantResponse.json()).toMatchObject({ code: "CLEANUP_BLOCKED" });
    expect(await prisma.jobOpportunity.count({ where: { id: owned.opportunity.id } })).toBe(1);
    expect(
      await prisma.resumeVariant.findUnique({
        where: { id: variant.id },
        select: { targetJobOpportunityId: true },
      }),
    ).toEqual({ targetJobOpportunityId: owned.opportunity.id });

    await prisma.resumeVariant.delete({ where: { id: variant.id } });
    const elsewhere = await prisma.jobOpportunity.create({
      data: { userId, companyId: owned.company.id, title: "Elsewhere" },
    });
    const external = await prisma.applicationAttempt.create({
      data: {
        userId,
        jobOpportunityId: elsewhere.id,
        channelLabel: "USER",
        transferredFromAttemptId: owned.attempt.id,
      },
    });
    const transferResponse = await post(userId, { jobIds: [owned.opportunity.id] });
    expect(transferResponse.status).toBe(500);
    expect(await transferResponse.json()).toMatchObject({ code: "CLEANUP_BLOCKED" });
    expect(await prisma.applicationAttempt.count({ where: { id: owned.attempt.id } })).toBe(1);
    expect(
      await prisma.applicationAttempt.findUnique({
        where: { id: external.id },
        select: { transferredFromAttemptId: true },
      }),
    ).toEqual({ transferredFromAttemptId: owned.attempt.id });
  });
});

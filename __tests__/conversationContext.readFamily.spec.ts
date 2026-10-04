// @vitest-environment node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { AIBusinessError } from "@/lib/ai/connections";
import {
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
} from "@/lib/career";
import { createOpportunityFromJobForm } from "@/lib/career/jobOpportunityAdapter";
import { parseConversationContext } from "@/lib/agent/conversationContext";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};
const ctx = makeTestDbUrl();

// The assistant module binds the process singleton. Point it at this
// disposable file before that module is imported.
process.env.DATABASE_URL = ctx.url;
delete process.env[AB_RUNTIME_FEATURE_ENV];
delete process.env[AB_ROLLOUT_SCOPE_ENV];

type ContextServer = typeof import("@/lib/agent/conversationContext.server");

let appPrisma: PrismaClient;
let server: ContextServer;
let userId: string;
let otherUserId: string;

beforeAll(async () => {
  pushSchema(ctx.url);
  const dbMod = await import("@/lib/db");
  appPrisma = dbMod.default;
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
  userId = await seedAccount(appPrisma, `ctx-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    appPrisma,
    `ctx-other-${Date.now()}@example.com`,
  );
});

async function createLegacyJob(ownerId: string, label: string, company: string) {
  const status = await appPrisma.jobStatus.findFirstOrThrow({
    where: { value: "draft" },
  });
  const title = await appPrisma.jobTitle.create({
    data: {
      label,
      value: `${label}-${randomUUID()}`,
      createdBy: ownerId,
    },
  });
  const companyRow = await appPrisma.company.create({
    data: {
      label: company,
      value: `${company}-${randomUUID()}`,
      createdBy: ownerId,
    },
  });
  return appPrisma.job.create({
    data: {
      userId: ownerId,
      description: "Legacy description long enough",
      jobType: "FT",
      createdAt: new Date(),
      statusId: status.id,
      jobTitleId: title.id,
      companyId: companyRow.id,
    },
  });
}

async function createOpportunity(ownerId: string) {
  const company = await appPrisma.company.create({
    data: {
      label: "Acme",
      value: `acme-${randomUUID()}`,
      createdBy: ownerId,
    },
  });
  const title = await appPrisma.jobTitle.create({
    data: {
      label: "Engineer",
      value: `eng-${randomUUID()}`,
      createdBy: ownerId,
    },
  });
  const location = await appPrisma.location.create({
    data: {
      label: "Remote",
      value: `remote-${randomUUID()}`,
      createdBy: ownerId,
    },
  });
  const source = await appPrisma.jobSource.findFirstOrThrow({
    where: { createdBy: ownerId },
  });
  const status = await appPrisma.jobStatus.findFirstOrThrow({
    where: { value: "draft" },
  });
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
      jobDescription: "Role description",
      applied: false,
    },
    FEATURE_ON,
  );
}

describe("assistant job context read family", () => {
  it("resolves a legacy Job id and omits an id outside that family", async () => {
    const job = await createLegacyJob(userId, "Legacy Title", "Legacy Co");
    const page = await server.resolvePageContextItems(userId, { jobId: job.id });
    expect(page).toEqual({
      version: 1,
      items: [
        {
          kind: "job",
          entityId: job.id,
          labelSnapshot: "Legacy Title · Legacy Co",
          source: "AUTO",
        },
      ],
    });
    expect(parseConversationContext(JSON.stringify(page))).toEqual(page);

    const owned = await server.resolveOwnedContext(userId, [
      { kind: "job", entityId: job.id, source: "MANUAL" },
    ]);
    expect(owned.version).toBe(1);
    expect(owned.items[0]).toMatchObject({
      kind: "job",
      entityId: job.id,
      labelSnapshot: "Legacy Title · Legacy Co",
      source: "MANUAL",
    });

    const missing = randomUUID();
    expect(
      await server.resolvePageContextItems(userId, { jobId: missing }),
    ).toEqual({ version: 1, items: [] });
    await expect(
      server.resolveOwnedContext(userId, [
        { kind: "job", entityId: missing, source: "MANUAL" },
      ]),
    ).rejects.toBeInstanceOf(AIBusinessError);

    const options = await server.listOwnedContextOptions(userId);
    expect(options.jobs.map((item) => item.id)).toEqual([job.id]);
    expect(options.jobs[0]).toMatchObject({
      kind: "job",
      label: "Legacy Title",
      secondary: "Legacy Co",
    });
  });

  it("resolves an A+B opportunity id and does not fall back to a legacy Job", async () => {
    await activateFreshAbNative(appPrisma);
    const opportunity = await createOpportunity(userId);

    const page = await server.resolvePageContextItems(userId, {
      jobId: opportunity.id,
    });
    expect(page.items).toEqual([
      {
        kind: "job",
        entityId: opportunity.id,
        labelSnapshot: "Engineer · Acme",
        source: "AUTO",
      },
    ]);
    expect(page.items[0].labelSnapshot).not.toMatch(/JobOpportunity|legacy/i);
    expect(parseConversationContext(JSON.stringify(page))).toEqual(page);

    expect(
      await server.resolvePageContextItems(userId, { jobId: randomUUID() }),
    ).toEqual({ version: 1, items: [] });
    expect(
      await server.resolvePageContextItems(otherUserId, {
        jobId: opportunity.id,
      }),
    ).toEqual({ version: 1, items: [] });

    await expect(
      server.resolveOwnedContext(otherUserId, [
        { kind: "job", entityId: opportunity.id, source: "MANUAL" },
      ]),
    ).rejects.toMatchObject({
      code: "AGENT_TOOL_ARGUMENT_INVALID",
    });

    const options = await server.listOwnedContextOptions(userId);
    expect(options.jobs.map((item) => item.id)).toEqual([opportunity.id]);
    expect(options.jobs[0].label).toBe("Engineer");
  });

  it("resolves the same opportunity when A+B full scope is the read family", async () => {
    process.env[AB_RUNTIME_FEATURE_ENV] = "true";
    process.env[AB_ROLLOUT_SCOPE_ENV] = "full";
    await activateFreshAbNative(appPrisma);
    const opportunity = await createOpportunity(userId);
    const owned = await server.resolveOwnedContext(userId, [
      { kind: "job", entityId: opportunity.id, source: "MANUAL" },
    ]);
    expect(owned).toEqual({
      version: 1,
      items: [
        {
          kind: "job",
          entityId: opportunity.id,
          labelSnapshot: "Engineer · Acme",
          source: "MANUAL",
        },
      ],
    });
    expect(
      await server.resolvePageContextItems(userId, { jobId: randomUUID() }),
    ).toEqual({ version: 1, items: [] });
  });
});

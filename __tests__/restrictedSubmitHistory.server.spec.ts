// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ApplicationService,
  OpportunityService,
  ResumeVariantService,
  writeInstanceMigrationState,
} from "@/lib/career";
import {
  LEGACY,
  PHASE3_MIGRATION_VERSION,
  TARGET,
} from "@/lib/legacy-migration/identities";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";
import * as mapping from "@/lib/career/legacyJobOpportunityMapping";

const FEATURE_FULL = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};
const FEATURE_RESUME = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "resume_v1",
};
const FEATURE_NONE = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "none",
};

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
});

vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

vi.mock("@/utils/user.utils", () => ({
  getCurrentUser: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { getCurrentUser } from "@/utils/user.utils";
import {
  getSubmittedResumeBindings,
  attachAttemptResumeVersion,
} from "@/actions/application.actions";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
let otherUserId: string;
let companyId: string;
const mockedUser = vi.mocked(getCurrentUser);

function setScope(scope: "full" | "resume_v1" | "none") {
  process.env[AB_RUNTIME_FEATURE_ENV] = "true";
  process.env[AB_ROLLOUT_SCOPE_ENV] = scope;
}

function applications(owner = userId, env = FEATURE_FULL) {
  return new ApplicationService(prisma, owner, env);
}

function opportunities(owner = userId, env = FEATURE_FULL) {
  return new OpportunityService(prisma, owner, env);
}

function variants(owner = userId, env = FEATURE_RESUME) {
  return new ResumeVariantService(prisma, owner, env);
}

async function seedLegacyJob(input?: {
  id?: string;
  owner?: string;
  company?: string;
}) {
  const owner = input?.owner ?? userId;
  const ownerCompanyId =
    input?.company ??
    (owner === userId
      ? companyId
      : (
          await prisma.company.create({
            data: {
              label: "Foreign Co",
              value: `foreign-legacy-${Date.now()}-${Math.random()}`,
              createdBy: owner,
            },
          })
        ).id);
  const title = await prisma.jobTitle.create({
    data: {
      label: "Legacy Role",
      value: `legacy-role-${Date.now()}-${Math.random()}`,
      createdBy: owner,
    },
  });
  const statusId = (
    await prisma.jobStatus.findFirstOrThrow({ where: { value: "applied" } })
  ).id;
  return prisma.job.create({
    data: {
      ...(input?.id ? { id: input.id } : {}),
      userId: owner,
      description: "Legacy job",
      jobType: "full-time",
      createdAt: new Date(),
      applied: true,
      statusId,
      jobTitleId: title.id,
      companyId: ownerCompanyId,
    },
  });
}

async function writeJobOpportunityMap(input: {
  legacyJobId: string;
  opportunityId: string;
  owner?: string;
}) {
  return prisma.legacyMigrationMap.create({
    data: {
      userId: input.owner ?? userId,
      legacyEntityType: LEGACY.JOB,
      legacyEntityId: input.legacyJobId,
      targetEntityType: TARGET.JOB_OPPORTUNITY,
      targetEntityId: input.opportunityId,
      migrationVersion: PHASE3_MIGRATION_VERSION,
      mappingReason: "TEST_CANONICAL_MAP",
    },
  });
}

async function writeUnmappedJobMap(input: {
  legacyJobId: string;
  owner?: string;
}) {
  return prisma.legacyMigrationMap.create({
    data: {
      userId: input.owner ?? userId,
      legacyEntityType: LEGACY.JOB,
      legacyEntityId: input.legacyJobId,
      targetEntityType: TARGET.UNMAPPED_UNKNOWN_STATUS,
      targetEntityId: input.legacyJobId,
      migrationVersion: PHASE3_MIGRATION_VERSION,
      mappingReason: "TEST_UNMAPPED",
    },
  });
}

afterAll(async () => {
  await prisma.$disconnect();
  delete process.env[AB_RUNTIME_FEATURE_ENV];
  delete process.env[AB_ROLLOUT_SCOPE_ENV];
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(
    prisma,
    `restricted-submit-${Date.now()}-${Math.random()}@example.com`,
  );
  otherUserId = await seedAccount(
    prisma,
    `restricted-submit-other-${Date.now()}-${Math.random()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-restricted-submit-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
  mockedUser.mockResolvedValue({
    id: userId,
    name: "Test",
    email: "t@example.com",
  } as never);
  setScope("resume_v1");
});

describe("restricted submitted resume read/bind", () => {
  it("returns an empty binding DTO when the job has no owned attempt", async () => {
    const beforeAttempts = await prisma.applicationAttempt.count({
      where: { userId },
    });
    const data = await applications(
      userId,
      FEATURE_RESUME,
    ).getSubmittedResumeBindingsForLegacyJob("missing-job");
    expect(data).toEqual({ opportunityId: null, attempts: [] });
    expect(await prisma.applicationAttempt.count({ where: { userId } })).toBe(
      beforeAttempts,
    );

    const action = await getSubmittedResumeBindings("missing-job");
    expect(action.success).toBe(true);
    expect(action.success ? action.data : null).toEqual({
      opportunityId: null,
      attempts: [],
    });
  });

  it("returns the unbound owned attempt without process steps", async () => {
    const opportunity = await opportunities().create({
      companyId,
      title: "Intern",
    });
    const attempt = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const data = await applications(userId, FEATURE_RESUME).getSubmittedResumeBindings(
      opportunity.id,
    );
    expect(data.opportunityId).toBe(opportunity.id);
    expect(data.attempts).toEqual([
      {
        id: attempt.id,
        channelLabel: "USER",
        createdAt: attempt.createdAt.toISOString(),
        submittedAt: null,
        submittedResume: null,
      },
    ]);
    expect(data.attempts[0]).not.toHaveProperty("steps");
    expect(data.attempts[0]).not.toHaveProperty("currentStageCategory");
    expect(data.attempts[0]).not.toHaveProperty("outcome");
  });

  it("binds an existing attempt under resume_v1 without extra mutations", async () => {
    const opportunity = await opportunities().create({
      companyId,
      title: "Intern",
    });
    const attempt = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const variant = await variants().createVariant({ name: "Campus" });
    const versionId = variant.currentVersionId!;
    const attemptCountBefore = await prisma.applicationAttempt.count({
      where: { userId },
    });
    const stepCountBefore = await prisma.applicationProcessStep.count({
      where: { applicationAttempt: { userId } },
    });
    const opportunityCountBefore = await prisma.jobOpportunity.count({
      where: { userId },
    });

    const bound = await applications(userId, FEATURE_RESUME).bindSubmittedResumeVersion({
      attemptId: attempt.id,
      submittedResumeVersionId: versionId,
    });
    expect(bound.submittedResumeVersionId).toBe(versionId);
    expect(bound.id).toBe(attempt.id);

    const version = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(version.status).toBe("SUBMITTED");
    expect(await prisma.applicationAttempt.count({ where: { userId } })).toBe(
      attemptCountBefore,
    );
    expect(
      await prisma.applicationProcessStep.count({
        where: { applicationAttempt: { userId } },
      }),
    ).toBe(stepCountBefore);
    expect(await prisma.jobOpportunity.count({ where: { userId } })).toBe(
      opportunityCountBefore,
    );

    const history = await applications(userId, FEATURE_RESUME).getSubmittedResumeBindings(
      opportunity.id,
    );
    expect(history.attempts[0].submittedResume).toEqual({
      id: versionId,
      title: "Campus",
      versionNumber: 1,
      resumeVariantId: variant.id,
      resumeVariantVersionId: versionId,
    });
  });

  it("keeps archived-variant history readable on the restricted DTO", async () => {
    const opportunity = await opportunities().create({
      companyId,
      title: "Intern",
    });
    const attempt = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const variant = await variants().createVariant({ name: "Campus" });
    const versionId = variant.currentVersionId!;
    await applications(userId, FEATURE_RESUME).bindSubmittedResumeVersion({
      attemptId: attempt.id,
      submittedResumeVersionId: versionId,
    });
    await variants().archiveVariant(variant.id);

    const listed = await variants().listVariants();
    expect(listed.map((row) => row.id)).not.toContain(variant.id);

    const history = await applications(userId, FEATURE_RESUME).getSubmittedResumeBindings(
      opportunity.id,
    );
    expect(history.attempts[0].submittedResume).toEqual({
      id: versionId,
      title: "Campus",
      versionNumber: 1,
      resumeVariantId: variant.id,
      resumeVariantVersionId: versionId,
    });
  });

  it("rejects the narrow bind action when scope is none", async () => {
    const opportunity = await opportunities().create({
      companyId,
      title: "Intern",
    });
    const attempt = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const variant = await variants().createVariant({ name: "Campus" });
    setScope("none");
    const action = await attachAttemptResumeVersion({
      attemptId: attempt.id,
      submittedResumeVersionId: variant.currentVersionId!,
    });
    expect(action.success).toBe(false);
    await expect(
      applications(userId, FEATURE_NONE).bindSubmittedResumeVersion({
        attemptId: attempt.id,
        submittedResumeVersionId: variant.currentVersionId!,
      }),
    ).rejects.toMatchObject({ code: "CAREER_WRITE_NOT_ENABLED" });
    await expect(
      applications(userId, FEATURE_NONE).getSubmittedResumeBindings(
        opportunity.id,
      ),
    ).rejects.toMatchObject({ code: "CAREER_READ_NOT_ENABLED" });
    await expect(
      applications(userId, FEATURE_NONE).getSubmittedResumeBindingsForLegacyJob(
        opportunity.id,
      ),
    ).rejects.toMatchObject({ code: "CAREER_READ_NOT_ENABLED" });
  });

  it("does not leak a foreign attempt through the restricted read", async () => {
    const foreignCompanyId = (
      await prisma.company.create({
        data: {
          label: "Other Co",
          value: `other-restricted-submit-${Date.now()}`,
          createdBy: otherUserId,
        },
      })
    ).id;
    const opportunity = await opportunities(otherUserId).create({
      companyId: foreignCompanyId,
      title: "Foreign",
    });
    await applications(otherUserId).createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const data = await applications(userId, FEATURE_RESUME).getSubmittedResumeBindings(
      opportunity.id,
    );
    expect(data).toEqual({ opportunityId: null, attempts: [] });
  });

  it("keeps full-scope timeline DTO including process steps", async () => {
    const opportunity = await opportunities().create({
      companyId,
      title: "Intern",
    });
    await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const timeline = await applications(userId, FEATURE_FULL).getTimeline(
      opportunity.id,
    );
    expect(timeline.attempts[0]).toHaveProperty("steps");
    expect(timeline.attempts[0]).toHaveProperty("submittedResume");
  });
});

describe("restricted submitted resume canonical mapping", () => {
  it("returns owned attempts through a canonical map when ids differ", async () => {
    const opportunity = await opportunities().create({
      companyId,
      title: "Mapped Intern",
    });
    const attempt = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Campus",
    });
    const legacyJob = await seedLegacyJob({ id: "legacy-job-123" });
    expect(legacyJob.id).not.toBe(opportunity.id);
    await writeJobOpportunityMap({
      legacyJobId: legacyJob.id,
      opportunityId: opportunity.id,
    });

    const data = await applications(
      userId,
      FEATURE_RESUME,
    ).getSubmittedResumeBindingsForLegacyJob(legacyJob.id);
    expect(data.opportunityId).toBe(opportunity.id);
    expect(data.attempts).toEqual([
      {
        id: attempt.id,
        channelLabel: "Campus",
        createdAt: attempt.createdAt.toISOString(),
        submittedAt: null,
        submittedResume: null,
      },
    ]);

    const action = await getSubmittedResumeBindings(legacyJob.id);
    expect(action.success).toBe(true);
    expect(action.success ? action.data : null).toEqual(data);
  });

  it("returns a safe empty DTO when the owned legacy job has no canonical map", async () => {
    const opportunity = await opportunities().create({
      companyId,
      title: "Unrelated",
    });
    await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const legacyJob = await seedLegacyJob();
    await writeUnmappedJobMap({ legacyJobId: legacyJob.id });
    const beforeMaps = await prisma.legacyMigrationMap.count({
      where: { userId },
    });
    const beforeOpps = await prisma.jobOpportunity.count({ where: { userId } });
    const beforeAttempts = await prisma.applicationAttempt.count({
      where: { userId },
    });
    const data = await applications(
      userId,
      FEATURE_RESUME,
    ).getSubmittedResumeBindingsForLegacyJob(legacyJob.id);
    expect(data).toEqual({ opportunityId: null, attempts: [] });
    expect(await prisma.legacyMigrationMap.count({ where: { userId } })).toBe(
      beforeMaps,
    );
    expect(await prisma.jobOpportunity.count({ where: { userId } })).toBe(
      beforeOpps,
    );
    expect(await prisma.applicationAttempt.count({ where: { userId } })).toBe(
      beforeAttempts,
    );
  });

  it("fails closed for a foreign legacy job", async () => {
    const foreignCompany = (
      await prisma.company.create({
        data: {
          label: "Foreign Co",
          value: `foreign-legacy-${Date.now()}`,
          createdBy: otherUserId,
        },
      })
    ).id;
    const foreignOpp = await opportunities(otherUserId).create({
      companyId: foreignCompany,
      title: "Foreign mapped",
    });
    await applications(otherUserId).createAttempt({
      jobOpportunityId: foreignOpp.id,
      channelLabel: "USER",
    });
    const foreignJob = await seedLegacyJob({
      owner: otherUserId,
      company: foreignCompany,
    });
    await writeJobOpportunityMap({
      legacyJobId: foreignJob.id,
      opportunityId: foreignOpp.id,
      owner: otherUserId,
    });
    const data = await applications(
      userId,
      FEATURE_RESUME,
    ).getSubmittedResumeBindingsForLegacyJob(foreignJob.id);
    expect(data).toEqual({ opportunityId: null, attempts: [] });
    expect(JSON.stringify(data)).not.toContain(foreignOpp.id);
    expect(JSON.stringify(data)).not.toContain(foreignJob.id);
  });

  it("fails closed without leaking a foreign mapped opportunity", async () => {
    const foreignCompany = (
      await prisma.company.create({
        data: {
          label: "Other Co",
          value: `other-map-${Date.now()}`,
          createdBy: otherUserId,
        },
      })
    ).id;
    const foreignOpp = await opportunities(otherUserId).create({
      companyId: foreignCompany,
      title: "Foreign target",
    });
    const legacyJob = await seedLegacyJob();
    await writeJobOpportunityMap({
      legacyJobId: legacyJob.id,
      opportunityId: foreignOpp.id,
    });
    const data = await applications(
      userId,
      FEATURE_RESUME,
    ).getSubmittedResumeBindingsForLegacyJob(legacyJob.id);
    expect(data).toEqual({ opportunityId: null, attempts: [] });
    expect(JSON.stringify(data)).not.toContain(foreignOpp.id);
  });

  it("does not match an unrelated opportunity that shares the legacy job id", async () => {
    const coincidentalId = "coincidental-job-opp-id";
    await prisma.jobOpportunity.create({
      data: {
        id: coincidentalId,
        userId,
        companyId,
        title: "Unrelated coincidence",
        status: "UNKNOWN",
        createdVia: "SEED",
      },
    });
    await applications().createAttempt({
      jobOpportunityId: coincidentalId,
      channelLabel: "USER",
    });
    const legacyJob = await seedLegacyJob({ id: coincidentalId });
    await writeUnmappedJobMap({ legacyJobId: legacyJob.id });
    expect(
      await mapping.resolveOwnedMappedOpportunityId({
        db: prisma,
        userId,
        legacyJobId: coincidentalId,
      }),
    ).toBeNull();
    const data = await applications(
      userId,
      FEATURE_RESUME,
    ).getSubmittedResumeBindingsForLegacyJob(coincidentalId);
    expect(data).toEqual({ opportunityId: null, attempts: [] });
  });

  it("returns every owned attempt on a mapped opportunity in deterministic order", async () => {
    const opportunity = await opportunities().create({
      companyId,
      title: "Multi attempt",
    });
    const attemptC = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Channel C",
    });
    const attemptA = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Channel A",
    });
    const attemptB = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Channel B",
    });
    const legacyJob = await seedLegacyJob({ id: "legacy-job-multi" });
    expect(legacyJob.id).not.toBe(opportunity.id);
    await writeJobOpportunityMap({
      legacyJobId: legacyJob.id,
      opportunityId: opportunity.id,
    });
    await prisma.applicationAttempt.update({
      where: { id: attemptA.id },
      data: { createdAt: new Date("2026-01-01T00:00:00.000Z") },
    });
    await prisma.applicationAttempt.update({
      where: { id: attemptB.id },
      data: { createdAt: new Date("2026-02-01T00:00:00.000Z") },
    });
    await prisma.applicationAttempt.update({
      where: { id: attemptC.id },
      data: { createdAt: new Date("2026-03-01T00:00:00.000Z") },
    });

    const data = await applications(
      userId,
      FEATURE_RESUME,
    ).getSubmittedResumeBindingsForLegacyJob(legacyJob.id);
    expect(data.opportunityId).toBe(opportunity.id);
    expect(data.attempts.map((row) => row.id)).toEqual([
      attemptA.id,
      attemptB.id,
      attemptC.id,
    ]);
    expect(data.attempts.map((row) => row.channelLabel)).toEqual([
      "Channel A",
      "Channel B",
      "Channel C",
    ]);
  });

  it("binds only the chosen attempt on a mapped multi-attempt opportunity", async () => {
    const opportunity = await opportunities().create({
      companyId,
      title: "Bind one",
    });
    const attemptA = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "A",
    });
    const attemptB = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "B",
    });
    const legacyJob = await seedLegacyJob();
    await writeJobOpportunityMap({
      legacyJobId: legacyJob.id,
      opportunityId: opportunity.id,
    });
    const variant = await variants().createVariant({ name: "Campus" });
    const versionId = variant.currentVersionId!;
    await applications(userId, FEATURE_RESUME).bindSubmittedResumeVersion({
      attemptId: attemptA.id,
      submittedResumeVersionId: versionId,
    });
    const variantB = await variants().createVariant({ name: "Referral" });
    const versionB = variantB.currentVersionId!;

    await applications(userId, FEATURE_RESUME).bindSubmittedResumeVersion({
      attemptId: attemptB.id,
      submittedResumeVersionId: versionB,
    });

    const afterA = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attemptA.id },
    });
    const afterB = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attemptB.id },
    });
    expect(afterA.submittedResumeVersionId).toBe(versionId);
    expect(afterB.submittedResumeVersionId).toBe(versionB);

    const history = await applications(
      userId,
      FEATURE_RESUME,
    ).getSubmittedResumeBindingsForLegacyJob(legacyJob.id);
    const byId = new Map(history.attempts.map((row) => [row.id, row]));
    expect(byId.get(attemptA.id)?.submittedResume?.resumeVariantVersionId).toBe(
      versionId,
    );
    expect(byId.get(attemptB.id)?.submittedResume?.resumeVariantVersionId).toBe(
      versionB,
    );
  });

  it("does not consult the canonical map when resume_v1 is not readable", async () => {
    const spy = vi.spyOn(mapping, "resolveOwnedMappedOpportunityId");
    setScope("none");
    await expect(
      applications(userId, FEATURE_NONE).getSubmittedResumeBindingsForLegacyJob(
        "legacy-job-123",
      ),
    ).rejects.toMatchObject({ code: "CAREER_READ_NOT_ENABLED" });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

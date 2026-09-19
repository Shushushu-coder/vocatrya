// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  CAREER_RUNTIME_MODE,
  CandidateProfileService,
  CareerMaterialService,
  MatchAnalysisService,
  OpportunityService,
  PROCESS_STEP_CATEGORY,
  ResumeVariantService,
  activateFreshAbNative,
  assertCareerDataReadable,
  assertFullAbWritable,
  assertLegacyCareerWriteAllowed,
  assertResumeV1Writable,
  isFullAbCapabilityEnabled,
  isRestrictedResumeBindingSurfaceEnabled,
  isResumeV1CapabilityEnabled,
  resolveAbRolloutScope,
  resolveCareerRuntimeMode,
} from "@/lib/career";
import { listJobs } from "@/lib/career/jobsReadDispatch";
import { createJobRecord } from "@/lib/jobs/createJobRecord";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

function envFor(scope: "none" | "resume_v1" | "full" | "missing") {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [AB_RUNTIME_FEATURE_ENV]: "true",
  };
  if (scope === "missing") delete env[AB_ROLLOUT_SCOPE_ENV];
  else env[AB_ROLLOUT_SCOPE_ENV] = scope;
  return env;
}

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let companyId: string;
let titleId: string;
let statusId: string;

beforeAll(() => {
  pushSchema(ctx.url);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
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
    `cap-iso-${Date.now()}-${Math.random()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-cap-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  titleId = (
    await prisma.jobTitle.create({
      data: {
        label: "Engineer",
        value: `eng-cap-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  statusId = (
    await prisma.jobStatus.findFirstOrThrow({ where: { value: "draft" } })
  ).id;
});

describe("runtime mode + rollout scope matrix", () => {
  it("LEGACY_ONLY ignores any scope", async () => {
    for (const scope of ["none", "resume_v1", "full"] as const) {
      const env = envFor(scope);
      const runtime = await resolveCareerRuntimeMode(prisma, { env });
      expect(runtime.mode).toBe(CAREER_RUNTIME_MODE.LEGACY_ONLY);
      expect(isResumeV1CapabilityEnabled(runtime.mode, resolveAbRolloutScope(env))).toBe(
        false,
      );
      expect(isFullAbCapabilityEnabled(runtime.mode, resolveAbRolloutScope(env))).toBe(
        false,
      );
      expect(
        isRestrictedResumeBindingSurfaceEnabled(
          runtime.mode,
          resolveAbRolloutScope(env),
        ),
      ).toBe(false);
      await expect(assertResumeV1Writable(prisma, env)).rejects.toMatchObject({
        code: "AB_WRITES_NOT_ENABLED",
      });
      await expect(assertFullAbWritable(prisma, env)).rejects.toMatchObject({
        code: "AB_WRITES_NOT_ENABLED",
      });
    }
  });

  it("AB_READY_DISABLED ignores any scope", async () => {
    await activateFreshAbNative(prisma);
    const env = {
      ...process.env,
      [AB_RUNTIME_FEATURE_ENV]: "false",
      [AB_ROLLOUT_SCOPE_ENV]: "full",
    };
    const runtime = await resolveCareerRuntimeMode(prisma, { env });
    expect(runtime.mode).toBe(CAREER_RUNTIME_MODE.AB_READY_DISABLED);
    expect(isResumeV1CapabilityEnabled(runtime.mode, "full")).toBe(false);
    await expect(assertResumeV1Writable(prisma, env)).rejects.toMatchObject({
      code: "AB_WRITES_NOT_ENABLED",
    });
  });

  it("BLOCKED dominates any scope", async () => {
    await activateFreshAbNative(prisma);
    await prisma.job.create({
      data: {
        userId,
        description: "pollution",
        jobType: "full-time",
        createdAt: new Date(),
        statusId,
        jobTitleId: titleId,
        companyId,
      },
    });
    const env = envFor("full");
    const runtime = await resolveCareerRuntimeMode(prisma, { env });
    expect(runtime.mode).toBe(CAREER_RUNTIME_MODE.BLOCKED);
    await expect(assertResumeV1Writable(prisma, env)).rejects.toMatchObject({
      code: "AB_WRITES_NOT_ENABLED",
    });
    await expect(assertFullAbWritable(prisma, env)).rejects.toMatchObject({
      code: "AB_WRITES_NOT_ENABLED",
    });
  });

  it("AB_ENABLED + missing/invalid scope is none", async () => {
    await activateFreshAbNative(prisma);
    const missing = envFor("missing");
    const runtime = await resolveCareerRuntimeMode(prisma, { env: missing });
    expect(runtime.mode).toBe(CAREER_RUNTIME_MODE.AB_ENABLED);
    expect(resolveAbRolloutScope(missing)).toBe("none");
    await expect(assertCareerDataReadable(prisma, missing)).rejects.toMatchObject({
      code: "CAREER_READ_NOT_ENABLED",
    });
    await expect(assertResumeV1Writable(prisma, missing)).rejects.toMatchObject({
      code: "CAREER_WRITE_NOT_ENABLED",
    });
    await expect(assertFullAbWritable(prisma, missing)).rejects.toMatchObject({
      code: "AB_WRITES_NOT_ENABLED",
    });
  });
});

describe("resume_v1 bundle vs full isolation", () => {
  it("enables resume bundle and preserves legacy jobs, denying full A-side", async () => {
    await activateFreshAbNative(prisma);
    const resumeEnv = envFor("resume_v1");
    await expect(assertResumeV1Writable(prisma, resumeEnv)).resolves.toBe(
      CAREER_RUNTIME_MODE.AB_ENABLED,
    );
    expect(
      isRestrictedResumeBindingSurfaceEnabled(
        CAREER_RUNTIME_MODE.AB_ENABLED,
        "resume_v1",
      ),
    ).toBe(true);
    expect(
      isRestrictedResumeBindingSurfaceEnabled(CAREER_RUNTIME_MODE.AB_ENABLED, "full"),
    ).toBe(false);
    expect(
      isRestrictedResumeBindingSurfaceEnabled(CAREER_RUNTIME_MODE.AB_ENABLED, "none"),
    ).toBe(false);
    await expect(assertFullAbWritable(prisma, resumeEnv)).rejects.toMatchObject({
      code: "AB_WRITES_NOT_ENABLED",
    });

    const profiles = new CandidateProfileService(prisma, userId, resumeEnv);
    const materials = new CareerMaterialService(prisma, userId, resumeEnv);
    const variants = new ResumeVariantService(prisma, userId, resumeEnv);
    await profiles.upsertCandidateProfile(userId, {
      fullName: "Restricted User",
      email: "restricted@example.com",
    });
    const material = await materials.create({
      type: "EDUCATION",
      title: "Uni",
      detail: { institution: "Uni" },
    });
    const variant = await variants.createVariant({ name: "Campus" });
    expect(variant.id).toBeTruthy();
    expect(material.id).toBeTruthy();

    await expect(
      new OpportunityService(prisma, userId, resumeEnv).create({
        companyId,
        title: "Should not create",
      }),
    ).rejects.toMatchObject({ code: "AB_WRITES_NOT_ENABLED" });
    await expect(
      new ApplicationService(prisma, userId, resumeEnv).createAttempt({
        jobOpportunityId: "missing",
        channelLabel: "USER",
      }),
    ).rejects.toMatchObject({ code: "AB_WRITES_NOT_ENABLED" });
    await expect(
      new MatchAnalysisService(prisma, userId, resumeEnv).listAnalysesForOpportunity(
        "missing",
      ),
    ).rejects.toMatchObject({ code: "AB_WRITES_NOT_ENABLED" });

    await expect(assertLegacyCareerWriteAllowed(prisma, resumeEnv)).resolves.toBeUndefined();
    const previousRuntime = process.env[AB_RUNTIME_FEATURE_ENV];
    const previousScope = process.env[AB_ROLLOUT_SCOPE_ENV];
    process.env[AB_RUNTIME_FEATURE_ENV] = "true";
    process.env[AB_ROLLOUT_SCOPE_ENV] = "resume_v1";
    let job: { id: string };
    try {
      job = await createJobRecord(
        {
          jobTitleId: titleId,
          companyId,
          statusId,
          description: "legacy still works",
          jobType: "full-time",
          userId,
        },
        prisma,
      );
    } finally {
      if (previousRuntime === undefined) delete process.env[AB_RUNTIME_FEATURE_ENV];
      else process.env[AB_RUNTIME_FEATURE_ENV] = previousRuntime;
      if (previousScope === undefined) delete process.env[AB_ROLLOUT_SCOPE_ENV];
      else process.env[AB_ROLLOUT_SCOPE_ENV] = previousScope;
    }
    expect(job.id).toBeTruthy();
    expect(await prisma.jobOpportunity.count()).toBe(0);
    expect(await prisma.resumeVariant.count({ where: { userId } })).toBe(1);

    const listed = await listJobs(prisma, userId, {}, resumeEnv);
    expect(listed.blocked).toBe(false);
    if (!listed.blocked) {
      expect(listed.data.map((row) => row.id)).toContain(job.id);
    }
  });

  it("full scope keeps Opportunity writes and blocks legacy Job writes", async () => {
    await activateFreshAbNative(prisma);
    const fullEnv = envFor("full");
    await expect(assertLegacyCareerWriteAllowed(prisma, fullEnv)).rejects.toMatchObject({
      code: "LEGACY_WRITE_BLOCKED",
    });
    const opportunity = await new OpportunityService(prisma, userId, fullEnv).create({
      companyId,
      title: "Full A-side role",
    });
    expect(opportunity.id).toBeTruthy();
    const applications = new ApplicationService(prisma, userId, fullEnv);
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const step = await applications.createUserProcessStep({
      jobOpportunityId: opportunity.id,
      category: PROCESS_STEP_CATEGORY.INTERVIEW,
      label: "Round 1",
    });
    expect(attempt.id).toBeTruthy();
    expect(step.id).toBeTruthy();
  });

  it("downgrade resume_v1 to none hides without deleting, then restore", async () => {
    await activateFreshAbNative(prisma);
    const resumeEnv = envFor("resume_v1");
    const variant = await new ResumeVariantService(prisma, userId, resumeEnv).createVariant({
      name: "Keep me",
    });
    const noneEnv = envFor("none");
    await expect(assertCareerDataReadable(prisma, noneEnv)).rejects.toMatchObject({
      code: "CAREER_READ_NOT_ENABLED",
    });
    expect(await prisma.resumeVariant.count({ where: { id: variant.id } })).toBe(1);
    await expect(assertCareerDataReadable(prisma, resumeEnv)).resolves.toBe(
      CAREER_RUNTIME_MODE.AB_ENABLED,
    );
    const restored = await new ResumeVariantService(prisma, userId, resumeEnv).getVariant(
      variant.id,
    );
    expect(restored?.name).toBe("Keep me");
  });

  it("full to resume_v1 keeps resume data and denies A-side mutations without deleting", async () => {
    await activateFreshAbNative(prisma);
    const fullEnv = envFor("full");
    const variant = await new ResumeVariantService(prisma, userId, fullEnv).createVariant({
      name: "Shared",
    });
    const opportunity = await new OpportunityService(prisma, userId, fullEnv).create({
      companyId,
      title: "Hidden later",
    });
    const resumeEnv = envFor("resume_v1");
    const kept = await new ResumeVariantService(prisma, userId, resumeEnv).getVariant(
      variant.id,
    );
    expect(kept?.name).toBe("Shared");
    await expect(
      new OpportunityService(prisma, userId, resumeEnv).updateSafe(opportunity.id, {
        title: "Nope",
      }),
    ).rejects.toMatchObject({ code: "AB_WRITES_NOT_ENABLED" });
    expect(
      await prisma.jobOpportunity.findUnique({ where: { id: opportunity.id } }),
    ).not.toBeNull();
  });

  it("resume_v1 to full does not duplicate or rewrite resume rows", async () => {
    await activateFreshAbNative(prisma);
    const resumeEnv = envFor("resume_v1");
    const created = await new ResumeVariantService(prisma, userId, resumeEnv).createVariant({
      name: "Upgrade me",
    });
    const fullEnv = envFor("full");
    const listed = await new ResumeVariantService(prisma, userId, fullEnv).listVariants();
    expect(listed.map((row) => row.id)).toEqual([created.id]);
    expect(await prisma.resumeVariant.count({ where: { userId } })).toBe(1);
  });

  it("binds an existing attempt under resume_v1 without opening attempt creation", async () => {
    await activateFreshAbNative(prisma);
    const fullEnv = envFor("full");
    const opportunity = await new OpportunityService(prisma, userId, fullEnv).create({
      companyId,
      title: "Existing attempt host",
    });
    const attempt = await new ApplicationService(prisma, userId, fullEnv).createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "USER",
    });
    const resumeEnv = envFor("resume_v1");
    const variant = await new ResumeVariantService(prisma, userId, resumeEnv).createVariant({
      name: "Bind me",
    });
    await expect(
      new ApplicationService(prisma, userId, resumeEnv).createAttempt({
        jobOpportunityId: opportunity.id,
        channelLabel: "USER",
      }),
    ).rejects.toMatchObject({ code: "AB_WRITES_NOT_ENABLED" });
    const bound = await new ApplicationService(
      prisma,
      userId,
      resumeEnv,
    ).bindSubmittedResumeVersion({
      attemptId: attempt.id,
      submittedResumeVersionId: variant.currentVersionId!,
    });
    expect(bound.submittedResumeVersionId).toBe(variant.currentVersionId);
    const version = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: variant.currentVersionId! },
    });
    expect(version.status).toBe("SUBMITTED");
  });
});

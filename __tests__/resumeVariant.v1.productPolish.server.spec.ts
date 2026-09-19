// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  ApplicationService,
  CareerRuntimeError,
  OpportunityService,
  ResumeVariantService,
  writeInstanceMigrationState,
} from "@/lib/career";
import {
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };

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
import { resolveResumeVariantWorkspaceVersion } from "@/actions/resumeVariant.actions";

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
let userId: string;
let otherUserId: string;
let companyId: string;
const mockedUser = vi.mocked(getCurrentUser);

function setFeature(on: boolean, scope = "full") {
  if (on) {
    process.env[AB_RUNTIME_FEATURE_ENV] = "true";
    process.env[AB_ROLLOUT_SCOPE_ENV] = scope;
  } else {
    delete process.env[AB_RUNTIME_FEATURE_ENV];
    delete process.env[AB_ROLLOUT_SCOPE_ENV];
  }
}

function variants(owner = userId) {
  return new ResumeVariantService(prisma, owner, FEATURE_ON);
}

function applications(owner = userId) {
  return new ApplicationService(prisma, owner, FEATURE_ON);
}

function opportunities(owner = userId) {
  return new OpportunityService(prisma, owner, FEATURE_ON);
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
    `rv1-polish-${Date.now()}-${Math.random()}@example.com`,
  );
  otherUserId = await seedAccount(
    prisma,
    `rv1-polish-other-${Date.now()}-${Math.random()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-rv1-polish-${Date.now()}`,
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
  setFeature(true);
});

describe("Resume Variant V1 historical deep-link ownership", () => {
  it("allows an owned version on its own variant, including after archive", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "Campus" });
    const versionId = variant.currentVersionId!;
    const opportunity = await opportunities().create({
      companyId,
      title: "Intern",
    });
    const attempt = await applications().createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Campus",
    });
    await applications().markSubmitted({
      attemptId: attempt.id,
      submittedResumeVersionId: versionId,
    });
    await service.archiveVariant(variant.id);

    await expect(
      service.resolveWorkspaceVersion(variant.id, versionId),
    ).resolves.toEqual({ variantId: variant.id, versionId });

    const listed = await service.listVariants();
    expect(listed.map((row) => row.id)).not.toContain(variant.id);

    const action = await resolveResumeVariantWorkspaceVersion({
      variantId: variant.id,
      versionId,
    });
    expect(action.success).toBe(true);
    expect(action.success ? action.data : null).toEqual({
      variantId: variant.id,
      versionId,
    });

    const timeline = await applications().getTimeline(opportunity.id);
    expect(timeline.attempts[0].submittedResume).toEqual({
      id: versionId,
      title: "Campus",
      versionNumber: 1,
      resumeVariantId: variant.id,
      resumeVariantVersionId: versionId,
    });
  });

  it("rejects a version that belongs to a different owned variant", async () => {
    const service = variants();
    const first = await service.createVariant({ name: "A" });
    const second = await service.createVariant({ name: "B" });
    await expect(
      service.resolveWorkspaceVersion(first.id, second.currentVersionId!),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });

    const action = await resolveResumeVariantWorkspaceVersion({
      variantId: first.id,
      versionId: second.currentVersionId!,
    });
    expect(action.success).toBe(false);
  });

  it("rejects a foreign user's version", async () => {
    const own = await variants().createVariant({ name: "Mine" });
    const foreign = await variants(otherUserId).createVariant({ name: "Theirs" });
    await expect(
      variants().resolveWorkspaceVersion(own.id, foreign.currentVersionId!),
    ).rejects.toBeInstanceOf(CareerRuntimeError);
    await expect(
      variants().resolveWorkspaceVersion(own.id, foreign.currentVersionId!),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });

    const action = await resolveResumeVariantWorkspaceVersion({
      variantId: own.id,
      versionId: foreign.currentVersionId!,
    });
    expect(action.success).toBe(false);
  });

  it("denies historical resolution when career data is not readable", async () => {
    const variant = await variants().createVariant({ name: "Campus" });
    setFeature(false);
    const action = await resolveResumeVariantWorkspaceVersion({
      variantId: variant.id,
      versionId: variant.currentVersionId!,
    });
    expect(action.success).toBe(false);
  });
});

// @vitest-environment node
import fs from "node:fs";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  OpportunityService,
  RESUME_VERSION_STATUS,
  ResumeVariantService,
  writeInstanceMigrationState,
} from "@/lib/career";
import { isResumeVersionNumberConflict } from "@/lib/career/resumeVariantService";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true" };

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let companyId: string;

beforeAll(() => {
  pushSchema(ctx.url);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup is a known flake.
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `rv1-hard-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-rv1-hard-${Date.now()}`,
        createdBy: userId,
      },
    })
  ).id;
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function variants(owner = userId) {
  return new ResumeVariantService(prisma, owner, FEATURE_ON);
}

function applications(owner = userId) {
  return new ApplicationService(prisma, owner, FEATURE_ON);
}

function opportunities(owner = userId) {
  return new OpportunityService(prisma, owner, FEATURE_ON);
}

function p2002(target?: unknown) {
  const meta =
    target === undefined ? {} : ({ target } as Record<string, unknown>);
  return new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
    code: "P2002",
    clientVersion: "test",
    meta,
  });
}

describe("R1 version-number P2002 detection", () => {
  it("accepts the resumeVariantId + versionNumber field pair in any order", () => {
    expect(
      isResumeVersionNumberConflict(
        p2002(["resumeVariantId", "versionNumber"]),
      ),
    ).toBe(true);
    expect(
      isResumeVersionNumberConflict(
        p2002(["versionNumber", "resumeVariantId"]),
      ),
    ).toBe(true);
  });

  it("accepts the Prisma unique index name from schema/migrations", () => {
    expect(
      isResumeVersionNumberConflict(
        p2002("ResumeVariantVersion_resumeVariantId_versionNumber_key"),
      ),
    ).toBe(true);
    expect(
      isResumeVersionNumberConflict(
        p2002(["ResumeVariantVersion_resumeVariantId_versionNumber_key"]),
      ),
    ).toBe(true);
  });

  it("rejects unrelated, missing, and malformed P2002 targets", () => {
    expect(isResumeVersionNumberConflict(p2002(["someOtherUniqueField"]))).toBe(
      false,
    );
    expect(
      isResumeVersionNumberConflict(
        p2002("ResumeVariantVersion_resumeVariantId_versionNumber_key_extra"),
      ),
    ).toBe(false);
    expect(
      isResumeVersionNumberConflict(p2002("looks_like_versionNumber_conflict")),
    ).toBe(false);
    expect(isResumeVersionNumberConflict(p2002())).toBe(false);
    expect(isResumeVersionNumberConflict(p2002(null))).toBe(false);
    expect(isResumeVersionNumberConflict(p2002({ fields: ["versionNumber"] }))).toBe(
      false,
    );
    expect(
      isResumeVersionNumberConflict({
        code: "P2002",
      }),
    ).toBe(false);
    expect(
      isResumeVersionNumberConflict({
        code: "P2003",
        meta: { target: ["resumeVariantId", "versionNumber"] },
      }),
    ).toBe(false);
  });

  it("classifies the live SQLite unique violation as a version-number conflict", async () => {
    const variant = await variants().createVariant({ name: "General" });
    try {
      await prisma.resumeVariantVersion.create({
        data: { resumeVariantId: variant.id, versionNumber: 1 },
      });
      throw new Error("expected P2002");
    } catch (error) {
      expect(error).toMatchObject({ code: "P2002" });
      expect(isResumeVersionNumberConflict(error)).toBe(true);
    }
  });
});

describe("R1 version-number retry scope", () => {
  async function freezeCurrent(service: ResumeVariantService, variantId: string) {
    const variant = await prisma.resumeVariant.findUniqueOrThrow({
      where: { id: variantId },
    });
    await service.freeze(variant.currentVersionId!);
  }

  function spyStaleLatestVersionNumber(staleReads: number) {
    const originalFindFirst = prisma.resumeVariantVersion.findFirst.bind(
      prisma.resumeVariantVersion,
    );
    let remaining = staleReads;
    return vi.spyOn(prisma.resumeVariantVersion, "findFirst").mockImplementation(((
      args: {
        select?: { versionNumber?: boolean };
        orderBy?: { versionNumber?: string };
      },
    ) => {
      const isLatestRead =
        args?.select?.versionNumber === true &&
        args?.orderBy?.versionNumber === "desc";
      if (isLatestRead && remaining > 0) {
        remaining -= 1;
        return Promise.resolve({ versionNumber: 1 });
      }
      return originalFindFirst(args as never);
    }) as typeof prisma.resumeVariantVersion.findFirst);
  }

  function spyTransactionCount() {
    const original = prisma.$transaction.bind(prisma) as (
      ...args: unknown[]
    ) => Promise<unknown>;
    let count = 0;
    vi.spyOn(prisma, "$transaction").mockImplementation(((...args: unknown[]) => {
      count += 1;
      return original(...args);
    }) as typeof prisma.$transaction);
    return { getCount: () => count };
  }

  it("retries once on a live resumeVariantId+versionNumber collision and allocates the next number", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    await freezeCurrent(service, variant.id);
    await prisma.resumeVariantVersion.create({
      data: {
        resumeVariantId: variant.id,
        versionNumber: 2,
        status: RESUME_VERSION_STATUS.FROZEN,
        frozenAt: new Date(),
      },
    });

    spyStaleLatestVersionNumber(1);
    const tx = spyTransactionCount();

    const blank = await service.createBlankDraft(variant.id);
    expect(tx.getCount()).toBe(2);
    expect(blank.versionNumber).toBe(3);
    expect(blank.status).toBe(RESUME_VERSION_STATUS.DRAFT);
    const current = await prisma.resumeVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(current.currentVersionId).toBe(blank.id);
  });

  it("does not retry an unrelated P2002", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    await freezeCurrent(service, variant.id);

    let txCount = 0;
    vi.spyOn(prisma, "$transaction").mockImplementation(async () => {
      txCount += 1;
      throw p2002(["someOtherUniqueField"]);
    });

    await expect(service.createBlankDraft(variant.id)).rejects.toMatchObject({
      code: "P2002",
      meta: { target: ["someOtherUniqueField"] },
    });
    expect(txCount).toBe(1);
    const current = await prisma.resumeVariant.findUniqueOrThrow({
      where: { id: variant.id },
    });
    expect(current.currentVersionId).toBe(variant.currentVersionId);
  });

  it("does not retry a P2002 with a missing or malformed target", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    await freezeCurrent(service, variant.id);

    let txCount = 0;
    vi.spyOn(prisma, "$transaction").mockImplementation(async () => {
      txCount += 1;
      throw p2002();
    });

    await expect(service.createBlankDraft(variant.id)).rejects.toMatchObject({
      code: "P2002",
    });
    expect(txCount).toBe(1);
  });

  it("propagates the second version-number collision without a third attempt", async () => {
    const service = variants();
    const variant = await service.createVariant({ name: "General" });
    await freezeCurrent(service, variant.id);
    await prisma.resumeVariantVersion.create({
      data: {
        resumeVariantId: variant.id,
        versionNumber: 2,
        status: RESUME_VERSION_STATUS.FROZEN,
        frozenAt: new Date(),
      },
    });

    spyStaleLatestVersionNumber(2);
    const tx = spyTransactionCount();

    await expect(service.createBlankDraft(variant.id)).rejects.toMatchObject({
      code: "P2002",
    });
    expect(tx.getCount()).toBe(2);
  });
});

describe("R2 archived variant cannot bind to a new attempt", () => {
  async function seedOpportunityAndAttempts() {
    const opportunity = await opportunities().create({
      companyId,
      title: "Staff Engineer",
    });
    const apps = applications();
    const attemptA = await apps.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers",
    });
    const attemptB = await apps.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Referral",
    });
    return { opportunity, apps, attemptA, attemptB };
  }

  it("rejects binding an archived SUBMITTED version to a new attempt and keeps history", async () => {
    const service = variants();
    const { opportunity, apps, attemptA, attemptB } =
      await seedOpportunityAndAttempts();
    const variant = await service.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;

    const submitted = await apps.markSubmitted({
      attemptId: attemptA.id,
      submittedResumeVersionId: versionId,
    });
    expect(submitted.submittedResumeVersionId).toBe(versionId);

    await service.archiveVariant(variant.id);

    await expect(
      apps.markSubmitted({
        attemptId: attemptB.id,
        submittedResumeVersionId: versionId,
      }),
    ).rejects.toMatchObject({ code: "VARIANT_ARCHIVED" });

    const afterA = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attemptA.id },
    });
    const afterB = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attemptB.id },
    });
    const version = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(afterA.submittedResumeVersionId).toBe(versionId);
    expect(afterB.submittedResumeVersionId).toBeNull();
    expect(version.status).toBe(RESUME_VERSION_STATUS.SUBMITTED);

    const timeline = await apps.getTimeline(opportunity.id);
    const historical = timeline.attempts.find((row) => row.id === attemptA.id);
    expect(historical?.submittedResume).toEqual({
      id: versionId,
      title: "General",
      versionNumber: 1,
      resumeVariantId: variant.id,
      resumeVariantVersionId: versionId,
    });
    const readable = await service.getVersion(versionId);
    expect(readable.id).toBe(versionId);
    expect(readable.resumeVariant.archivedAt).not.toBeNull();
  });

  it("rejects binding an archived FROZEN version to a new attempt", async () => {
    const service = variants();
    const { apps, attemptB } = await seedOpportunityAndAttempts();
    const variant = await service.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;
    await service.freeze(versionId);
    await service.archiveVariant(variant.id);

    await expect(
      apps.markSubmitted({
        attemptId: attemptB.id,
        submittedResumeVersionId: versionId,
      }),
    ).rejects.toMatchObject({ code: "VARIANT_ARCHIVED" });

    const version = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(version.status).toBe(RESUME_VERSION_STATUS.FROZEN);
    const afterB = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attemptB.id },
    });
    expect(afterB.submittedResumeVersionId).toBeNull();
  });

  it("rejects binding an archived DRAFT version before markSubmitted", async () => {
    const service = variants();
    const { apps, attemptB } = await seedOpportunityAndAttempts();
    const variant = await service.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;
    await service.archiveVariant(variant.id);

    await expect(
      apps.markSubmitted({
        attemptId: attemptB.id,
        submittedResumeVersionId: versionId,
      }),
    ).rejects.toMatchObject({ code: "VARIANT_ARCHIVED" });

    const version = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: versionId },
    });
    expect(version.status).toBe(RESUME_VERSION_STATUS.DRAFT);
    const afterB = await prisma.applicationAttempt.findUniqueOrThrow({
      where: { id: attemptB.id },
    });
    expect(afterB.submittedResumeVersionId).toBeNull();
  });

  it("keeps active-variant submit and reuse of an already SUBMITTED version", async () => {
    const service = variants();
    const { apps, attemptA, attemptB } = await seedOpportunityAndAttempts();
    const variant = await service.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;

    const first = await apps.markSubmitted({
      attemptId: attemptA.id,
      submittedResumeVersionId: versionId,
    });
    expect(first.submittedResumeVersionId).toBe(versionId);
    expect(
      (await prisma.resumeVariantVersion.findUniqueOrThrow({ where: { id: versionId } }))
        .status,
    ).toBe(RESUME_VERSION_STATUS.SUBMITTED);

    const second = await apps.markSubmitted({
      attemptId: attemptB.id,
      submittedResumeVersionId: versionId,
    });
    expect(second.submittedResumeVersionId).toBe(versionId);
    expect(
      (await prisma.resumeVariantVersion.findUniqueOrThrow({ where: { id: versionId } }))
        .status,
    ).toBe(RESUME_VERSION_STATUS.SUBMITTED);
  });
});

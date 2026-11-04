// @vitest-environment node
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  ApplicationService,
  OpportunityService,
  ResumeVariantService,
  writeInstanceMigrationState,
} from "@/lib/career";
import { getJobConnections } from "@/lib/career/jobOpportunityAdapter";
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
const FEATURE_RESTRICTED = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "resume_v1",
};

const ctx = makeTestDbUrl();
const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;
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
  userId = await seedAccount(prisma, `jc-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `jc-other-${Date.now()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-jc-${Date.now()}`,
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

function services(ownerId = userId) {
  return {
    opportunities: new OpportunityService(prisma, ownerId, FEATURE_ON),
    applications: new ApplicationService(prisma, ownerId, FEATURE_ON),
    variants: new ResumeVariantService(prisma, ownerId, FEATURE_ON),
  };
}

async function createOpportunity() {
  const { opportunities } = services();
  return opportunities.create({ companyId, title: "Staff Engineer" });
}

async function createJdVersion(
  opportunityId: string,
  versionNumber: number,
  options: { current?: boolean } = {},
) {
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opportunityId,
      versionNumber,
      rawContent: `JD v${versionNumber} raw content`,
      contentHash: `jdhash-${opportunityId}-${versionNumber}`,
      capturedAt: new Date(`2024-0${versionNumber + 5}-15T00:00:00.000Z`),
    },
  });
  if (options.current !== false) {
    await prisma.jobOpportunity.update({
      where: { id: opportunityId },
      data: { currentJdVersionId: jd.id },
    });
  }
  return jd;
}

async function createArtifact(
  resumeVariantVersionId: string,
  fileName: string,
) {
  return prisma.resumeArtifact.create({
    data: {
      resumeVariantVersionId,
      kind: "EXPORT",
      format: "PDF",
      storageKey: `resume-artifacts/${randomUUID()}/${fileName}`,
      fileName,
      sha256: `sha256-${fileName}`,
      byteSize: fileName.length * 100,
    },
  });
}

async function createSession(input: {
  jobOpportunityId?: string | null;
  jobDescriptionVersionId?: string | null;
  userId?: string;
}) {
  return prisma.interviewSession.create({
    data: {
      userId: input.userId ?? userId,
      coachingMode: "PRACTICE",
      feedbackReleasePolicy: "IMMEDIATE",
      knowledgeBaseVersion: "v1.0",
      jobOpportunityId: input.jobOpportunityId ?? null,
      jobDescriptionVersionId: input.jobDescriptionVersionId ?? null,
    },
  });
}

describe("getJobConnections", () => {
  it("rejects a cross-user opportunity", async () => {
    const opportunity = await createOpportunity();
    await expect(
      getJobConnections(prisma, otherUserId, opportunity.id, FEATURE_ON),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
  });

  it("denies the read under a restricted (non-full) rollout scope", async () => {
    const opportunity = await createOpportunity();
    await expect(
      getJobConnections(prisma, userId, opportunity.id, FEATURE_RESTRICTED),
    ).rejects.toMatchObject({ code: "APPLICATION_TIMELINE_UNAVAILABLE" });
  });

  it("returns an empty aggregation when nothing is bound", async () => {
    const opportunity = await createOpportunity();
    const view = await getJobConnections(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    expect(view).toEqual({
      opportunityId: opportunity.id,
      currentJdVersion: null,
      plannedResumeVariants: [],
      practiceSessions: { total: 0, byJdVersion: [] },
      attemptMaterials: [],
    });
  });

  it("lists planned variants, including archived ones flagged", async () => {
    const { variants } = services();
    const opportunity = await createOpportunity();
    const planned = await variants.createVariant({
      name: "Targeted",
      targetJobOpportunityId: opportunity.id,
    });
    const unrelated = await variants.createVariant({ name: "Unrelated" });
    const archived = await variants.createVariant({
      name: "Archived target",
      targetJobOpportunityId: opportunity.id,
    });
    await variants.archiveVariant(archived.id);

    const view = await getJobConnections(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    const ids = view.plannedResumeVariants.map((row) => row.id);
    expect(ids).toEqual(
      expect.arrayContaining([planned.id, archived.id]),
    );
    expect(ids).not.toContain(unrelated.id);
    const plannedRow = view.plannedResumeVariants.find(
      (row) => row.id === planned.id,
    );
    expect(plannedRow).toMatchObject({
      name: "Targeted",
      archivedAt: null,
      currentVersion: { versionNumber: 1, status: "DRAFT" },
    });
    const archivedRow = view.plannedResumeVariants.find(
      (row) => row.id === archived.id,
    );
    expect(archivedRow?.archivedAt).toEqual(expect.any(String));
  });

  it("reports each attempt's bound artifact and submitted JD version", async () => {
    const { applications, variants } = services();
    const opportunity = await createOpportunity();
    const jd = await createJdVersion(opportunity.id, 1);
    const variant = await variants.createVariant({ name: "General" });
    const artifact = await createArtifact(
      variant.currentVersionId!,
      "general.pdf",
    );
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Referral",
    });
    await applications.submitApplication({
      attemptId: attempt.id,
      submittedResumeVersionId: variant.currentVersionId,
      submittedResumeArtifactId: artifact.id,
      submittedAgainstJdVersionId: jd.id,
    });

    const view = await getJobConnections(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    expect(view.attemptMaterials).toHaveLength(1);
    expect(view.attemptMaterials[0]).toEqual({
      attemptId: attempt.id,
      submittedArtifact: {
        id: artifact.id,
        kind: "EXPORT",
        format: "PDF",
        fileName: "general.pdf",
        sha256: `sha256-general.pdf`,
        byteSize: "general.pdf".length * 100,
      },
      submittedAgainstJdVersion: {
        id: jd.id,
        versionNumber: 1,
        capturedAt: jd.capturedAt.toISOString(),
      },
    });
    expect(view.currentJdVersion).toEqual({ id: jd.id, versionNumber: 1 });
  });

  it("keeps per-attempt materials independent across attempts", async () => {
    const { applications, variants } = services();
    const opportunity = await createOpportunity();
    const jd = await createJdVersion(opportunity.id, 1);
    const variantA = await variants.createVariant({ name: "A" });
    const variantB = await variants.createVariant({ name: "B" });
    const artifactA = await createArtifact(
      variantA.currentVersionId!,
      "a.pdf",
    );
    const artifactB = await createArtifact(
      variantB.currentVersionId!,
      "b.pdf",
    );
    const attemptA = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "A",
    });
    const attemptB = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "B",
    });
    await applications.submitApplication({
      attemptId: attemptA.id,
      submittedResumeVersionId: variantA.currentVersionId,
      submittedResumeArtifactId: artifactA.id,
      submittedAgainstJdVersionId: jd.id,
    });
    await applications.submitApplication({
      attemptId: attemptB.id,
      submittedResumeVersionId: variantB.currentVersionId,
      submittedResumeArtifactId: artifactB.id,
      submittedAgainstJdVersionId: jd.id,
    });

    const view = await getJobConnections(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    const materials = new Map(
      view.attemptMaterials.map((row) => [row.attemptId, row]),
    );
    expect(materials.get(attemptA.id)?.submittedArtifact?.id).toBe(
      artifactA.id,
    );
    expect(materials.get(attemptB.id)?.submittedArtifact?.id).toBe(
      artifactB.id,
    );
    expect(
      materials.get(attemptA.id)?.submittedAgainstJdVersion?.versionNumber,
    ).toBe(1);
    expect(
      materials.get(attemptB.id)?.submittedAgainstJdVersion?.versionNumber,
    ).toBe(1);
  });

  it("does not rewrite submission facts when the JD or resume moves on", async () => {
    const { applications, variants } = services();
    const opportunity = await createOpportunity();
    const jdV1 = await createJdVersion(opportunity.id, 1);
    const variant = await variants.createVariant({ name: "General" });
    const artifact = await createArtifact(
      variant.currentVersionId!,
      "frozen.pdf",
    );
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers",
    });
    await applications.submitApplication({
      attemptId: attempt.id,
      submittedResumeVersionId: variant.currentVersionId,
      submittedResumeArtifactId: artifact.id,
      submittedAgainstJdVersionId: jdV1.id,
    });

    // The plan and the JD both move on after the submission.
    await createJdVersion(opportunity.id, 2);
    await variants.createBlankDraft(variant.id);
    await variants.updateTargetJob(variant.currentVersionId!, null);

    const view = await getJobConnections(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    const materials = view.attemptMaterials.find(
      (row) => row.attemptId === attempt.id,
    );
    expect(materials?.submittedAgainstJdVersion?.id).toBe(jdV1.id);
    expect(materials?.submittedArtifact?.id).toBe(artifact.id);
    expect(view.currentJdVersion?.versionNumber).toBe(2);
    // Planned binding is the mutable side of the comparison: untargeting the
    // variant removes it from the planned list without touching the facts.
    expect(view.plannedResumeVariants).toHaveLength(0);
  });

  it("counts linked practice sessions by JD and ignores other sessions", async () => {
    const opportunity = await createOpportunity();
    const jdV1 = await createJdVersion(opportunity.id, 1);
    const jdV2 = await createJdVersion(opportunity.id, 2);
    const otherOpportunity = await createOpportunity();
    const otherJd = await createJdVersion(otherOpportunity.id, 1);

    await createSession({
      jobOpportunityId: opportunity.id,
      jobDescriptionVersionId: jdV1.id,
    });
    await createSession({
      jobOpportunityId: opportunity.id,
      jobDescriptionVersionId: jdV1.id,
    });
    await createSession({
      jobOpportunityId: opportunity.id,
      jobDescriptionVersionId: jdV2.id,
    });
    // Sessions on another job and unlinked sessions never leak into the count.
    await createSession({
      jobOpportunityId: otherOpportunity.id,
      jobDescriptionVersionId: otherJd.id,
    });
    await createSession({});

    const view = await getJobConnections(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    expect(view.practiceSessions.total).toBe(3);
    expect(view.practiceSessions.byJdVersion).toEqual([
      { jdVersionId: jdV1.id, versionNumber: 1, count: 2 },
      { jdVersionId: jdV2.id, versionNumber: 2, count: 1 },
    ]);
  });

  it("stays readable on an archived opportunity", async () => {
    const { applications, opportunities, variants } = services();
    const opportunity = await createOpportunity();
    const jd = await createJdVersion(opportunity.id, 1);
    const variant = await variants.createVariant({
      name: "Targeted",
      targetJobOpportunityId: opportunity.id,
    });
    const artifact = await createArtifact(
      variant.currentVersionId!,
      "frozen.pdf",
    );
    const attempt = await applications.createAttempt({
      jobOpportunityId: opportunity.id,
      channelLabel: "Careers",
    });
    await applications.submitApplication({
      attemptId: attempt.id,
      submittedResumeVersionId: variant.currentVersionId,
      submittedResumeArtifactId: artifact.id,
      submittedAgainstJdVersionId: jd.id,
    });
    await createSession({
      jobOpportunityId: opportunity.id,
      jobDescriptionVersionId: jd.id,
    });
    await opportunities.archive(opportunity.id);

    const view = await getJobConnections(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    expect(view.plannedResumeVariants).toHaveLength(1);
    expect(view.attemptMaterials).toHaveLength(1);
    expect(view.practiceSessions.total).toBe(1);
  });
});

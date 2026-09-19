// @vitest-environment node
import fs from "node:fs";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  CareerMaterialService,
  MATCH_ANALYSIS_TYPE,
  MATCH_STALE_REASON,
  MatchAnalysisService,
  OpportunityService,
  ResumeVariantService,
  hashEvidenceContent,
  hashMatchInput,
  buildDeepMatchHashInput,
  buildFastScreeningHashInput,
  writeInstanceMigrationState,
} from "@/lib/career";
import {
  makeTestDbUrl,
  pushSchema,
  resetDisposableDb,
  seedAccount,
} from "./helpers/backupTestDb";

const FEATURE_ON = { ...process.env, [AB_RUNTIME_FEATURE_ENV]: "true", [AB_ROLLOUT_SCOPE_ENV]: "full" };

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
  userId = await seedAccount(prisma, `match-${Date.now()}@example.com`);
  otherUserId = await seedAccount(prisma, `match-other-${Date.now()}@example.com`);
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-match-${Date.now()}`, createdBy: userId },
    })
  ).id;
  await writeInstanceMigrationState(prisma, {
    status: AB_MIGRATION_STATUS.COMPLETED,
    completedAt: new Date(),
    verifiedAt: new Date(),
  });
});

function services(owner = userId) {
  return {
    opportunities: new OpportunityService(prisma, owner, FEATURE_ON),
    variants: new ResumeVariantService(prisma, owner, FEATURE_ON),
    materials: new CareerMaterialService(prisma, owner, FEATURE_ON),
    match: new MatchAnalysisService(prisma, owner, FEATURE_ON),
  };
}

async function createParse(opportunityId: string, content = "Build widgets.") {
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opportunityId,
      versionNumber: 1,
      rawContent: content,
      capturedAt: new Date(),
      contentHash: `hash-${content}`,
    },
  });
  const parse = await prisma.jobDescriptionParse.create({
    data: {
      jobDescriptionVersionId: jd.id,
      schemaVersion: "1",
      parserVersion: "test",
      structuredData: "{}",
      parseStatus: "SUCCEEDED",
      inputHash: `parse-${content}`,
    },
  });
  return { jd, parse };
}

describe("MatchAnalysis input hashes", () => {
  it("hashes Fast Screening inputs independently of key insertion order", () => {
    const left = hashMatchInput(
      buildFastScreeningHashInput({
        analysisSchemaVersion: "1",
        jobOpportunityId: "opp",
        jobDescriptionVersionId: "jd",
        jobDescriptionParseId: "parse",
        parseInputHash: "p",
        jdContentHash: "j",
        preferenceSnapshot: { city: "SF", role: "EM" },
        careerMaterialSnapshot: { items: [{ title: "Acme" }] },
      }),
    );
    const right = hashMatchInput(
      buildFastScreeningHashInput({
        jdContentHash: "j",
        parseInputHash: "p",
        jobDescriptionParseId: "parse",
        jobDescriptionVersionId: "jd",
        jobOpportunityId: "opp",
        analysisSchemaVersion: "1",
        careerMaterialSnapshot: { items: [{ title: "Acme" }] },
        preferenceSnapshot: { role: "EM", city: "SF" },
      }),
    );
    expect(left).toBe(right);
  });

  it("changes when a relevant Fast Screening input changes", () => {
    const base = {
      analysisSchemaVersion: "1",
      jobOpportunityId: "opp",
      jobDescriptionVersionId: "jd",
      jobDescriptionParseId: "parse",
      parseInputHash: "p",
      jdContentHash: "j",
      careerMaterialSnapshot: { items: [{ title: "Acme" }] },
      preferenceSnapshot: { city: "SF" },
    };
    const original = hashMatchInput(buildFastScreeningHashInput(base));
    expect(
      hashMatchInput(
        buildFastScreeningHashInput({
          ...base,
          careerMaterialSnapshot: { items: [{ title: "Other" }] },
        }),
      ),
    ).not.toBe(original);
    expect(
      hashMatchInput(
        buildFastScreeningHashInput({ ...base, preferenceSnapshot: { city: "NYC" } }),
      ),
    ).not.toBe(original);
    expect(
      hashMatchInput(buildFastScreeningHashInput({ ...base, jdContentHash: "other" })),
    ).not.toBe(original);
  });

  it("does not include a resume version in Fast Screening hash input", () => {
    const hashed = buildFastScreeningHashInput({
      analysisSchemaVersion: "1",
      jobOpportunityId: "opp",
      jobDescriptionVersionId: "jd",
      jobDescriptionParseId: "parse",
      parseInputHash: "p",
      jdContentHash: "j",
      careerMaterialSnapshot: {},
      preferenceSnapshot: {},
    });
    expect(hashed).not.toHaveProperty("resumeVariantVersionId");
  });

  it("hashes Deep Match inputs deterministically and includes resume version", () => {
    const left = hashMatchInput(
      buildDeepMatchHashInput({
        analysisSchemaVersion: "1",
        resumeVariantVersionId: "rv",
        jobOpportunityId: "opp",
        jobDescriptionParseId: "parse",
        jobDescriptionVersionId: "jd",
        parseInputHash: "p",
        jdContentHash: "j",
      }),
    );
    const right = hashMatchInput(
      buildDeepMatchHashInput({
        jdContentHash: "j",
        parseInputHash: "p",
        jobDescriptionVersionId: "jd",
        jobDescriptionParseId: "parse",
        jobOpportunityId: "opp",
        resumeVariantVersionId: "rv",
        analysisSchemaVersion: "1",
      }),
    );
    expect(left).toBe(right);
    expect(
      hashMatchInput(
        buildDeepMatchHashInput({
          analysisSchemaVersion: "1",
          resumeVariantVersionId: "other",
          jobOpportunityId: "opp",
          jobDescriptionParseId: "parse",
          jobDescriptionVersionId: "jd",
          parseInputHash: "p",
          jdContentHash: "j",
        }),
      ),
    ).not.toBe(left);
  });
});

describe("MatchAnalysis runtime", () => {
  it("creates Fast Screening without a resume version and persists snapshot + hash", async () => {
    const { opportunities, match } = services();
    const opportunity = await opportunities.create({
      companyId,
      title: "Staff Engineer",
    });
    const { jd, parse } = await createParse(opportunity.id);
    const careerMaterialSnapshot = { items: [{ title: "Acme" }] };
    const preferenceSnapshot = { city: "SF" };

    const created = await match.createFastScreening({
      jobOpportunityId: opportunity.id,
      jobDescriptionParseId: parse.id,
      careerMaterialSnapshot,
      preferenceSnapshot,
      payload: { verdict: "PASS", reasons: "core overlap" },
    });

    expect(created.analysisType).toBe(MATCH_ANALYSIS_TYPE.FAST_SCREENING);
    expect(created.resumeVariantVersionId).toBeNull();
    expect(created.fastScreeningDetail?.verdict).toBe("PASS");
    expect(created.fastScreeningDetail?.inputSnapshot).toContain("Acme");
    const expectedHash = hashMatchInput(
      buildFastScreeningHashInput({
        analysisSchemaVersion: created.analysisSchemaVersion,
        jobOpportunityId: opportunity.id,
        jobDescriptionVersionId: jd.id,
        jobDescriptionParseId: parse.id,
        parseInputHash: parse.inputHash,
        jdContentHash: jd.contentHash,
        careerMaterialSnapshot,
        preferenceSnapshot,
      }),
    );
    expect(created.inputHash).toBe(expectedHash);

    await expect(
      match.createFastScreening({
        jobOpportunityId: opportunity.id,
        jobDescriptionParseId: parse.id,
        careerMaterialSnapshot,
        preferenceSnapshot,
        resumeVariantVersionId: "should-not-bind",
        payload: { verdict: "PASS" },
      }),
    ).rejects.toMatchObject({ code: "FAST_SCREENING_FORBIDS_RESUME" });

    const second = await match.createFastScreening({
      jobOpportunityId: opportunity.id,
      jobDescriptionParseId: parse.id,
      careerMaterialSnapshot,
      preferenceSnapshot,
      payload: { verdict: "PASS" },
    });
    expect(second.id).not.toBe(created.id);
    const listed = await match.listAnalysesForOpportunity(opportunity.id, {
      analysisType: MATCH_ANALYSIS_TYPE.FAST_SCREENING,
    });
    expect(listed.map((row) => row.id).sort()).toEqual([created.id, second.id].sort());
  });

  it("requires an owned resume version for Deep Match and retains history", async () => {
    const { opportunities, variants, match } = services();
    const opportunity = await opportunities.create({
      companyId,
      title: "Staff Engineer",
    });
    const { jd, parse } = await createParse(opportunity.id);
    const variant = await variants.createVariant({ name: "General" });
    const versionId = variant.currentVersionId!;

    await expect(
      match.createDeepMatch({
        jobOpportunityId: opportunity.id,
        jobDescriptionParseId: parse.id,
        resumeVariantVersionId: "",
        payload: { overallSummary: "fit" },
      }),
    ).rejects.toMatchObject({ code: "DEEP_MATCH_REQUIRES_RESUME" });

    const otherVariant = await services(otherUserId).variants.createVariant({
      name: "Foreign",
    });
    await expect(
      match.createDeepMatch({
        jobOpportunityId: opportunity.id,
        jobDescriptionParseId: parse.id,
        resumeVariantVersionId: otherVariant.currentVersionId!,
        payload: { overallSummary: "fit" },
      }),
    ).rejects.toMatchObject({ code: "VERSION_NOT_FOUND" });

    const first = await match.createDeepMatch({
      jobOpportunityId: opportunity.id,
      jobDescriptionParseId: parse.id,
      resumeVariantVersionId: versionId,
      payload: { overallSummary: "strong fit", overallScore: 82 },
    });
    expect(first.resumeVariantVersionId).toBe(versionId);
    expect(first.deepMatchDetail?.overallSummary).toBe("strong fit");
    const expectedHash = hashMatchInput(
      buildDeepMatchHashInput({
        analysisSchemaVersion: first.analysisSchemaVersion,
        jobOpportunityId: opportunity.id,
        jobDescriptionVersionId: jd.id,
        jobDescriptionParseId: parse.id,
        parseInputHash: parse.inputHash,
        jdContentHash: jd.contentHash,
        resumeVariantVersionId: versionId,
      }),
    );
    expect(first.inputHash).toBe(expectedHash);

    const second = await match.createDeepMatch({
      jobOpportunityId: opportunity.id,
      jobDescriptionParseId: parse.id,
      resumeVariantVersionId: versionId,
      payload: { overallSummary: "still a fit" },
    });
    expect(second.id).not.toBe(first.id);
    expect(second.inputHash).toBe(first.inputHash);
    const listed = await match.listAnalysesForOpportunity(opportunity.id, {
      analysisType: MATCH_ANALYSIS_TYPE.DEEP_MATCH,
    });
    expect(listed).toHaveLength(2);
  });

  it("marks stale idempotently without rewriting history", async () => {
    const { opportunities, match } = services();
    const opportunity = await opportunities.create({
      companyId,
      title: "Staff Engineer",
    });
    const { parse } = await createParse(opportunity.id);
    const created = await match.createFastScreening({
      jobOpportunityId: opportunity.id,
      jobDescriptionParseId: parse.id,
      careerMaterialSnapshot: { items: [] },
      preferenceSnapshot: { city: "SF" },
      payload: { verdict: "PASS", reasons: "keep me" },
    });
    const originalHash = created.inputHash;
    const originalSnapshot = created.fastScreeningDetail?.inputSnapshot;
    const originalReasons = created.fastScreeningDetail?.reasons;

    const stale = await match.markStale(created.id, [MATCH_STALE_REASON.JD_CHANGED]);
    expect(stale.isStale).toBe(true);
    expect(stale.staleAt).toBeInstanceOf(Date);
    expect(stale.staleReasonCodes).toBe(
      JSON.stringify([MATCH_STALE_REASON.JD_CHANGED]),
    );
    expect(stale.inputHash).toBe(originalHash);
    expect(stale.fastScreeningDetail?.inputSnapshot).toBe(originalSnapshot);
    expect(stale.fastScreeningDetail?.reasons).toBe(originalReasons);

    const again = await match.markStale(created.id, [
      MATCH_STALE_REASON.CAREER_MATERIAL_CHANGED,
    ]);
    expect(again.staleAt?.getTime()).toBe(stale.staleAt?.getTime());
    expect(again.staleReasonCodes).toBe(stale.staleReasonCodes);
    expect(again.inputHash).toBe(originalHash);

    const bulk = await match.markAnalysesStaleForInputChange({
      jobOpportunityId: opportunity.id,
      analysisType: MATCH_ANALYSIS_TYPE.FAST_SCREENING,
      reasonCodes: [MATCH_STALE_REASON.PREFERENCE_CHANGED],
    });
    expect(bulk).toHaveLength(0);

    const replacement = await match.createFastScreening({
      jobOpportunityId: opportunity.id,
      jobDescriptionParseId: parse.id,
      careerMaterialSnapshot: { items: [{ title: "New" }] },
      preferenceSnapshot: { city: "SF" },
      payload: { verdict: "BORDERLINE" },
    });
    expect(replacement.id).not.toBe(created.id);
    expect(replacement.isStale).toBe(false);
    const reread = await prisma.matchAnalysis.findUniqueOrThrow({
      where: { id: created.id },
      include: { fastScreeningDetail: true },
    });
    expect(reread.isStale).toBe(true);
    expect(reread.fastScreeningDetail?.verdict).toBe("PASS");
  });

  it("protects match evidence ownership", async () => {
    const { opportunities, materials, match } = services();
    const opportunity = await opportunities.create({
      companyId,
      title: "Staff Engineer",
    });
    const { parse } = await createParse(opportunity.id);
    const analysis = await match.createFastScreening({
      jobOpportunityId: opportunity.id,
      jobDescriptionParseId: parse.id,
      careerMaterialSnapshot: {},
      preferenceSnapshot: {},
      payload: { verdict: "PASS" },
    });
    const item = await materials.create({
      type: "SKILL",
      title: "SQL",
      detail: { skillName: "SQL" },
    });
    const evidence = await materials.addEvidence({
      materialItemId: item.id,
      kind: "SKILL_USAGE",
      content: "Used SQL",
    });
    const linked = await match.linkMatchEvidence({
      matchAnalysisId: analysis.id,
      requirementKey: "REQ-001",
      requirementTextSnapshot: "SQL",
      careerEvidenceId: evidence.id,
      judgement: "MATCHED",
    });
    expect(linked.evidenceContentSnapshot).toBe("Used SQL");
    expect(linked.evidenceHashSnapshot).toBe(hashEvidenceContent("Used SQL"));

    const foreignMaterials = services(otherUserId).materials;
    const foreignItem = await foreignMaterials.create({
      type: "SKILL",
      title: "Go",
      detail: { skillName: "Go" },
    });
    const foreignEvidence = await foreignMaterials.addEvidence({
      materialItemId: foreignItem.id,
      kind: "SKILL_USAGE",
      content: "Used Go",
    });
    await expect(
      match.linkMatchEvidence({
        matchAnalysisId: analysis.id,
        requirementKey: "REQ-002",
        requirementTextSnapshot: "Go",
        careerEvidenceId: foreignEvidence.id,
        judgement: "MATCHED",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_NOT_FOUND" });

    const foreignVariant = await services(otherUserId).variants.createVariant({
      name: "Other",
    });
    await expect(
      services(otherUserId).match.createDeepMatch({
        jobOpportunityId: opportunity.id,
        jobDescriptionParseId: parse.id,
        resumeVariantVersionId: foreignVariant.currentVersionId!,
        payload: { overallSummary: "nope" },
      }),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
  });
});

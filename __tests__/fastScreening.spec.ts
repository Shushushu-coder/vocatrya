// @vitest-environment node
/**
 * Canonical minimal match chain (RM-MATCH): runFastScreening end-to-end
 * at the service layer — material snapshot → deterministic JD parse →
 * MATCH_ANALYSIS resolution → structured TEXT_ONLY execution (fetchImpl)
 * → MatchAnalysisService persistence → stale marking + history reads.
 *
 * Failure paths assert the honest contract: insufficient material, missing
 * JD, NOT_CONFIGURED and INVALID_ASSIGNMENT never reach the model, and a
 * failed run persists no MatchAnalysis row.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  CareerMaterialService,
  JobSearchPreferenceService,
  MATCH_ANALYSIS_STATUS,
  MATCH_ANALYSIS_TYPE,
  MATCH_STALE_REASON,
  OpportunityService,
  sha256Utf8,
  writeInstanceMigrationState,
} from "@/lib/career";
import { FAST_SCREENING_ERROR_CODES } from "@/lib/career/fastScreeningContract";
import {
  loadFastScreeningPreflight,
  listFastScreeningAnalyses,
  runFastScreening,
} from "@/lib/career/fastScreening";
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

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

let userId: string;
let otherUserId: string;
let companyId: string;

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
  userId = await seedAccount(prisma, `match-run-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `match-run-other-${Date.now()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: { label: "Acme", value: `acme-${randomUUID()}`, createdBy: userId },
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
    materials: new CareerMaterialService(prisma, owner, FEATURE_ON),
    preferences: new JobSearchPreferenceService(prisma, owner, FEATURE_ON),
  };
}

async function createOpportunity(title = "Staff Engineer") {
  return services().opportunities.create({ companyId, title });
}

async function setJd(opportunityId: string, content: string, versionNumber = 1) {
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opportunityId,
      versionNumber,
      rawContent: content,
      rawContentFormat: "PLAIN_TEXT",
      capturedAt: new Date(),
      contentHash: sha256Utf8(content),
    },
  });
  await prisma.jobOpportunity.update({
    where: { id: opportunityId },
    data: { currentJdVersionId: jd.id },
  });
  return jd;
}

async function createSkillMaterial(title = "TypeScript", content = "5 years production TS") {
  const item = await services().materials.create({
    type: "SKILL",
    title,
    detail: { skillName: title },
  });
  await services().materials.addEvidence({
    materialItemId: item.id,
    kind: "SKILL_USAGE",
    content,
  });
  return item;
}

async function makeConnection(overrides: Record<string, unknown> = {}) {
  return prisma.aIConnection.create({
    data: {
      userId,
      provider: "DEVIN",
      backendKind: "DEVIN_RUNTIME",
      displayName: "Devin",
      status: "CONNECTED",
      runtimeProfileRef: `rp_${randomUUID()}`,
      ...overrides,
    },
  });
}

async function assignMatch(connectionId: string, model = "test-model") {
  return prisma.aIBusinessAssignment.create({
    data: { userId, purpose: "MATCH_ANALYSIS", connectionId, model },
  });
}

function okResponse(payload: Record<string, unknown>) {
  return new Response(
    JSON.stringify({
      ok: true,
      text: JSON.stringify(payload),
      durationMs: 5,
      structuredStrategy: "PROMPT_AND_VALIDATE",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function failResponse(code: string) {
  return new Response(JSON.stringify({ ok: false, code }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const VERDICT = {
  verdict: "PASS",
  reasons: "Core stack and seniority align.",
  hardRequirements: "Meets the stated requirements.",
  coreMatch: "Strong overlap on backend work.",
  preferenceMatch: "Role is in the preferred cities.",
};

function depsForFetch(fetchImpl: typeof fetch) {
  return {
    dbClient: prisma as never,
    execUrl: "http://127.0.0.1:9999",
    internalToken: "test-token",
    fetchImpl,
  };
}

async function run(source: Parameters<typeof runFastScreening>[2]["source"] = {
  kind: "career-profile",
}, opportunityId: string, fetchImpl: typeof fetch) {
  return runFastScreening(
    prisma,
    userId,
    { jobOpportunityId: opportunityId, source },
    depsForFetch(fetchImpl),
    FEATURE_ON,
  );
}

describe("runFastScreening", () => {
  it("persists a completed FAST_SCREENING analysis with connection snapshots", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "Build TypeScript services at scale.");
    await createSkillMaterial();
    await services().preferences.upsertJobSearchPreference(userId, {
      preferredCities: "Shanghai",
    });
    const connection = await makeConnection();
    await assignMatch(connection.id, "screen-model");

    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return okResponse(VERDICT);
    };

    const result = await run({ kind: "career-profile" }, opportunity.id, fetchImpl);

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.analysis.analysisType).toBe(MATCH_ANALYSIS_TYPE.FAST_SCREENING);
    expect(result.analysis.status).toBe(MATCH_ANALYSIS_STATUS.COMPLETED);
    expect(result.analysis.provider).toBe("DEVIN");
    expect(result.analysis.model).toBe("screen-model");
    expect(result.analysis.fastScreeningDetail?.verdict).toBe("PASS");
    expect(result.analysis.fastScreeningDetail?.reasons).toBe(VERDICT.reasons);
    expect(result.analysis.isStale).toBe(false);

    // The deterministic raw-text parse anchors the analysis and is reused.
    const persisted = await prisma.matchAnalysis.findUniqueOrThrow({
      where: { id: result.analysis.id },
      include: { jobDescriptionParse: true },
    });
    expect(persisted.resolvedConnectionId).toBe(connection.id);
    expect(persisted.jobDescriptionParse.parserVersion).toBe("jd-raw-text-v1");
    expect(persisted.jobDescriptionParse.parseStatus).toBe("SUCCEEDED");
    const version = await prisma.jobDescriptionVersion.findUniqueOrThrow({
      where: { id: persisted.jobDescriptionParse.jobDescriptionVersionId },
    });
    expect(version.currentParseId).toBe(persisted.jobDescriptionParseId);

    // The wire prompt carries the JD, the material text and preferences —
    // and the structured contract — never an executable/env/cwd.
    expect(bodies).toHaveLength(1);
    const prompt = String(bodies[0].prompt);
    expect(prompt).toContain("Build TypeScript services at scale.");
    expect(prompt).toContain("TypeScript");
    expect(prompt).toContain("5 years production TS");
    expect(prompt).toContain("Shanghai");
    expect(bodies[0].permissionScope).toBe("TEXT_ONLY");
    expect(bodies[0].structuredOutput).toMatchObject({
      schemaName: "vocatrya_fast_screening_v1",
    });
    for (const forbidden of ["executable", "args", "env", "cwd"]) {
      expect(bodies[0]).not.toHaveProperty(forbidden);
    }
  });

  it("reuses the same parse row on a second run against unchanged JD", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "Same JD.");
    await createSkillMaterial();
    const connection = await makeConnection();
    await assignMatch(connection.id, "m");

    const fetchImpl: typeof fetch = async () => okResponse(VERDICT);
    const first = await run({ kind: "career-profile" }, opportunity.id, fetchImpl);
    const second = await run({ kind: "career-profile" }, opportunity.id, fetchImpl);

    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    if (first.kind !== "ok" || second.kind !== "ok") return;
    expect(second.analysis.id).not.toBe(first.analysis.id);

    const parses = await prisma.jobDescriptionParse.findMany();
    expect(parses).toHaveLength(1);

    // Identical inputs → the earlier analysis is NOT stale.
    const listed = await listFastScreeningAnalyses(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    expect(listed).toHaveLength(2);
    expect(listed.every((row) => !row.isStale)).toBe(true);
  });

  it("marks the superseded analysis stale when material changed, with reason codes", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "JD v1");
    await createSkillMaterial("TypeScript", "5 years production TS");
    const connection = await makeConnection();
    await assignMatch(connection.id, "m");
    const fetchImpl: typeof fetch = async () => okResponse(VERDICT);

    const first = await run({ kind: "career-profile" }, opportunity.id, fetchImpl);
    expect(first.kind).toBe("ok");

    await createSkillMaterial("Go", "Built Go microservices");
    const second = await run({ kind: "career-profile" }, opportunity.id, fetchImpl);
    expect(second.kind).toBe("ok");
    if (first.kind !== "ok") return;

    const stale = await prisma.matchAnalysis.findUniqueOrThrow({
      where: { id: first.analysis.id },
    });
    expect(stale.isStale).toBe(true);
    expect(stale.staleReasonCodes).toBe(
      JSON.stringify([MATCH_STALE_REASON.CAREER_MATERIAL_CHANGED]),
    );
  });

  it("marks stale with JD_CHANGED when the job description changed", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "JD v1");
    await createSkillMaterial();
    const connection = await makeConnection();
    await assignMatch(connection.id, "m");
    const fetchImpl: typeof fetch = async () => okResponse(VERDICT);

    const first = await run({ kind: "career-profile" }, opportunity.id, fetchImpl);
    expect(first.kind).toBe("ok");

    await setJd(opportunity.id, "JD v2 — different content", 2);
    const second = await run({ kind: "career-profile" }, opportunity.id, fetchImpl);
    expect(second.kind).toBe("ok");
    if (first.kind !== "ok") return;

    const stale = await prisma.matchAnalysis.findUniqueOrThrow({
      where: { id: first.analysis.id },
    });
    expect(stale.isStale).toBe(true);
    expect(stale.staleReasonCodes).toBe(
      JSON.stringify([MATCH_STALE_REASON.JD_CHANGED]),
    );
  });

  it("refuses honestly when the selected material is empty — no execution, no rows", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "JD exists");
    const connection = await makeConnection();
    await assignMatch(connection.id, "m");
    const fetchImpl = vi.fn(async () => okResponse(VERDICT));

    const result = await run(
      { kind: "career-profile" },
      opportunity.id,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({
      kind: "failed",
      code: FAST_SCREENING_ERROR_CODES.INSUFFICIENT_MATERIAL,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await prisma.matchAnalysis.count()).toBe(0);
    expect(await prisma.jobDescriptionParse.count()).toBe(0);
  });

  it("refuses when the job has no JD version", async () => {
    const opportunity = await createOpportunity();
    const connection = await makeConnection();
    await assignMatch(connection.id, "m");
    const fetchImpl = vi.fn(async () => okResponse(VERDICT));

    const result = await run(
      { kind: "career-profile" },
      opportunity.id,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({
      kind: "failed",
      code: FAST_SCREENING_ERROR_CODES.JD_MISSING,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports NOT_CONFIGURED without executing when nothing is assigned", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "JD exists");
    await createSkillMaterial();
    const fetchImpl = vi.fn(async () => okResponse(VERDICT));

    const result = await run(
      { kind: "career-profile" },
      opportunity.id,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result).toEqual({
      kind: "failed",
      code: FAST_SCREENING_ERROR_CODES.NOT_CONFIGURED,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await prisma.matchAnalysis.count()).toBe(0);
  });

  it("fails a broken assignment without fallback or execution", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "JD exists");
    await createSkillMaterial();
    const broken = await makeConnection({ status: "DISCONNECTED" });
    const healthy = await makeConnection({ displayName: "Other" });
    await assignMatch(broken.id, "m-broken");
    await prisma.aIBusinessAssignment.create({
      data: {
        userId,
        purpose: "GLOBAL_DEFAULT",
        connectionId: healthy.id,
        model: "m-healthy",
      },
    });
    const fetchImpl = vi.fn(async () => okResponse(VERDICT));

    const result = await run(
      { kind: "career-profile" },
      opportunity.id,
      fetchImpl as unknown as typeof fetch,
    );

    expect(result.kind).toBe("failed");
    if (result.kind !== "failed") return;
    expect(result.code).toBe("CONNECTION_DISCONNECTED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(await prisma.matchAnalysis.count()).toBe(0);
  });

  it("surfaces an execution failure as retryable and persists nothing", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "JD exists");
    await createSkillMaterial();
    const connection = await makeConnection();
    await assignMatch(connection.id, "m");

    const failFetch: typeof fetch = async () =>
      failResponse("CONNECTION_DISCONNECTED");
    const failed = await run({ kind: "career-profile" }, opportunity.id, failFetch);
    expect(failed.kind).toBe("failed");
    if (failed.kind !== "failed") return;
    expect(failed.code).toBe("CONNECTION_DISCONNECTED");
    expect(await prisma.matchAnalysis.count()).toBe(0);

    // Retry after the connection recovers — fresh operation identity, same inputs.
    const okFetch: typeof fetch = async () => okResponse(VERDICT);
    const retried = await run({ kind: "career-profile" }, opportunity.id, okFetch);
    expect(retried.kind).toBe("ok");
    expect(await prisma.matchAnalysis.count()).toBe(1);
  });

  it("rejects a foreign opportunity", async () => {
    const opportunity = await services(otherUserId).opportunities.create({
      companyId: (
        await prisma.company.create({
          data: {
            label: "Foreign",
            value: `foreign-${randomUUID()}`,
            createdBy: otherUserId,
          },
        })
      ).id,
      title: "Nope",
    });
    await expect(
      runFastScreening(
        prisma,
        userId,
        { jobOpportunityId: opportunity.id, source: { kind: "career-profile" } },
        depsForFetch(async () => okResponse(VERDICT)),
        FEATURE_ON,
      ),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
  });
});

describe("match history + preflight", () => {
  it("lists analyses newest-first for reload-and-review", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "JD exists");
    await createSkillMaterial();
    const connection = await makeConnection();
    await assignMatch(connection.id, "screen-model");
    const fetchImpl: typeof fetch = async () => okResponse(VERDICT);

    const first = await run({ kind: "career-profile" }, opportunity.id, fetchImpl);
    const second = await run({ kind: "career-profile" }, opportunity.id, fetchImpl);
    if (first.kind !== "ok" || second.kind !== "ok") {
      throw new Error("expected ok runs");
    }

    const listed = await listFastScreeningAnalyses(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    expect(listed).toHaveLength(2);
    expect(listed[0].id).toBe(second.analysis.id);
    expect(listed[1].id).toBe(first.analysis.id);
    expect(listed[0].fastScreeningDetail?.verdict).toBe("PASS");
    expect(listed[0].provider).toBe("DEVIN");
    expect(listed[0].model).toBe("screen-model");

    // A foreign user cannot read the history.
    await expect(
      listFastScreeningAnalyses(
        prisma,
        otherUserId,
        opportunity.id,
        FEATURE_ON,
      ),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });
  });

  it("reports material counts, resume options and assignment state in preflight", async () => {
    const opportunity = await createOpportunity();
    await setJd(opportunity.id, "JD exists");
    await createSkillMaterial();
    const connection = await makeConnection();
    await assignMatch(connection.id, "screen-model");

    const preflight = await loadFastScreeningPreflight(
      prisma,
      userId,
      opportunity.id,
      FEATURE_ON,
    );
    expect(preflight.hasJobDescription).toBe(true);
    expect(preflight.materialsCount).toBe(1);
    expect(preflight.hasPreference).toBe(false);
    expect(preflight.assignment).toEqual({
      status: "RESOLVED",
      provider: "DEVIN",
      model: "screen-model",
    });
    expect(preflight.resumeVersions).toEqual([]);

    // No assignment at all → honest NOT_CONFIGURED preview.
    const otherOpp = await services(otherUserId).opportunities.create({
      companyId: (
        await prisma.company.create({
          data: {
            label: "OtherCo",
            value: `other-${randomUUID()}`,
            createdBy: otherUserId,
          },
        })
      ).id,
      title: "Role",
    });
    const empty = await loadFastScreeningPreflight(
      prisma,
      otherUserId,
      otherOpp.id,
      FEATURE_ON,
    );
    expect(empty.hasJobDescription).toBe(false);
    expect(empty.materialsCount).toBe(0);
    expect(empty.assignment).toEqual({ status: "NOT_CONFIGURED" });
  });
});

// @vitest-environment node
/**
 * Harness DEEP_MATCH task invariants against an isolated SQLite/Prisma
 * database — no mocks for persistence or concurrency:
 *
 *   create-request dedupe + ownership/capability gates
 *   claim CAS, epoch fencing, lease renew/loss
 *   cancel intent → CANCELLING → terminal, terminal immutability
 *   step checkpointing, mid-step interruption and recovery on the pinned
 *   connection/model/material (recovery never re-resolves or swaps in
 *   newer inputs)
 *   single bound result across failure/retry/recovery — the analysis row,
 *   the task SUCCEEDED state and the success event commit atomically
 *   trace events carry ids/codes/hashes/durations, never raw material
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import {
  AB_MIGRATION_STATUS,
  AB_RUNTIME_FEATURE_ENV,
  AB_ROLLOUT_SCOPE_ENV,
  MATCH_ANALYSIS_TYPE,
  MATCH_STALE_REASON,
  OpportunityService,
  ResumeVariantService,
  sha256Utf8,
  writeInstanceMigrationState,
} from "@/lib/career";
import {
  claimHarnessTask,
  createDeepMatchTask,
  failClaimedTask,
  finalizeCancelledTask,
  getHarnessTask,
  guardedTaskUpdate,
  renewHarnessLease,
  requestTaskCancel,
  requestTaskRetry,
  sweepHarnessTasks,
  toDeepMatchTaskDTO,
} from "@/lib/harness/taskService";
import { executeDeepMatchTask } from "@/lib/harness/deepMatch";
import { harnessRunnerTick } from "@/lib/harness/runner";
import { HarnessOwnershipLost } from "@/lib/harness/types";
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
  [AB_ROLLOUT_SCOPE_ENV]: "none",
};

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/backupTestDb");
  const { url, dir } = helpers.makeTestDbUrl();
  helpers.pushSchema(url);
  return { url, dir };
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
  userId = await seedAccount(prisma, `harness-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `harness-other-${Date.now()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-harness-${randomUUID()}`,
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

const JD_TEXT = "Build TypeScript services at scale for the payments platform.";
const RESUME_HEADLINE = "Senior TypeScript Engineer";

const DEEP_RESULT = {
  overallSummary: "Strong senior fit on the TypeScript services work.",
  overallScore: 84,
  hardRequirements: "Meets the stated requirements.",
  responsibilityAlignment: "Owned similar services.",
  experienceRelevance: "Directly relevant platform work.",
  skillCoverage: "Covers the required stack.",
  educationExperienceFit: null,
  strengths: "Deep production TypeScript experience.",
  gaps: "No payments-domain exposure stated.",
  resumeOptimizationOpportunities: "Quantify service scale.",
  nonFixableGaps: null,
};

async function createOpportunity() {
  return new OpportunityService(prisma, userId, FEATURE_ON).create({
    companyId,
    title: "Staff Engineer",
  });
}

async function setJd(opportunityId: string, content = JD_TEXT) {
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opportunityId,
      versionNumber: 1,
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

async function updateJd(opportunityId: string, content: string) {
  const latest = await prisma.jobDescriptionVersion.findFirst({
    where: { jobOpportunityId: opportunityId },
    orderBy: { versionNumber: "desc" },
    select: { versionNumber: true },
  });
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: opportunityId,
      versionNumber: (latest?.versionNumber ?? 0) + 1,
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

async function createResumeVersion(headline = RESUME_HEADLINE) {
  const variant = await new ResumeVariantService(
    prisma,
    userId,
    FEATURE_ON,
  ).createVariant({
    name: "General",
    headerSnapshot: JSON.stringify({
      fullName: "Ada Tester",
      headline,
    }),
  });
  return variant.currentVersionId!;
}

async function makeConnection(suffix = "a") {
  return prisma.aIConnection.create({
    data: {
      userId,
      provider: "DEVIN",
      backendKind: "DEVIN_RUNTIME",
      displayName: `Devin ${suffix}`,
      status: "CONNECTED",
      runtimeProfileRef: `rp_${randomUUID()}`,
    },
  });
}

async function assignMatch(connectionId: string, model = "deep-model-1") {
  return prisma.aIBusinessAssignment.upsert({
    where: { userId_purpose: { userId, purpose: "MATCH_ANALYSIS" } },
    update: { connectionId, model },
    create: { userId, purpose: "MATCH_ANALYSIS", connectionId, model },
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

function depsForFetch(fetchImpl: typeof fetch) {
  return {
    dbClient: prisma as never,
    execUrl: "http://127.0.0.1:9999",
    internalToken: "test-token",
    fetchImpl,
  };
}

const OWNER = "runner-test";

async function createTask(versionId: string, requestKey = `req-${randomUUID()}`) {
  const opportunity = await createOpportunity();
  await setJd(opportunity.id);
  const { task, created } = await createDeepMatchTask(
    prisma,
    userId,
    {
      jobOpportunityId: opportunity.id,
      resumeVariantVersionId: versionId,
      requestKey,
    },
    FEATURE_ON,
  );
  return { opportunity, task, created };
}

async function claim(taskId: string, leaseMs = 60_000) {
  const c = await claimHarnessTask(prisma, {
    taskId,
    owner: OWNER,
    leaseMs,
  });
  if (!c) throw new Error("claim failed");
  return c;
}

async function expireLease(taskId: string) {
  await prisma.harnessTask.update({
    where: { id: taskId },
    data: { leaseUntil: new Date(Date.now() - 1_000) },
  });
}

async function countDeepMatchAnalyses() {
  return prisma.matchAnalysis.count({
    where: { userId, analysisType: MATCH_ANALYSIS_TYPE.DEEP_MATCH },
  });
}

describe("createDeepMatchTask", () => {
  it("dedupes a retransmitted create and rejects key reuse with different inputs", async () => {
    const versionId = await createResumeVersion();
    const { task } = await createTask(versionId, "req-dedupe");
    const again = await createDeepMatchTask(
      prisma,
      userId,
      {
        jobOpportunityId: task.jobOpportunityId!,
        resumeVariantVersionId: versionId,
        requestKey: "req-dedupe",
      },
      FEATURE_ON,
    );
    expect(again.created).toBe(false);
    expect(again.task.id).toBe(task.id);
    expect(await prisma.harnessTask.count()).toBe(1);

    const version2 = await createResumeVersion();
    await expect(
      createDeepMatchTask(
        prisma,
        userId,
        {
          jobOpportunityId: task.jobOpportunityId!,
          resumeVariantVersionId: version2,
          requestKey: "req-dedupe",
        },
        FEATURE_ON,
      ),
    ).rejects.toMatchObject({ code: "DEEP_MATCH_REQUEST_CONFLICT" });

    // Same inputs under a new intent while the first is still active
    // return the live task — no duplicate run.
    const coalesced = await createDeepMatchTask(
      prisma,
      userId,
      {
        jobOpportunityId: task.jobOpportunityId!,
        resumeVariantVersionId: versionId,
        requestKey: `req-${randomUUID()}`,
      },
      FEATURE_ON,
    );
    expect(coalesced.created).toBe(false);
    expect(coalesced.task.id).toBe(task.id);
  });

  it("enforces user isolation and the capability gate without writes", async () => {
    const versionId = await createResumeVersion();
    const foreignCompany = (
      await prisma.company.create({
        data: {
          label: "ForeignCo",
          value: `foreign-${randomUUID()}`,
          createdBy: otherUserId,
        },
      })
    ).id;
    const foreign = await new OpportunityService(
      prisma,
      otherUserId,
      FEATURE_ON,
    ).create({ companyId: foreignCompany, title: "Foreign" });
    await expect(
      createDeepMatchTask(
        prisma,
        userId,
        { jobOpportunityId: foreign.id, resumeVariantVersionId: versionId, requestKey: "r1" },
        FEATURE_ON,
      ),
    ).rejects.toMatchObject({ code: "OPPORTUNITY_NOT_FOUND" });

    const foreignVersion = await new ResumeVariantService(
      prisma,
      otherUserId,
      FEATURE_ON,
    )
      .createVariant({ name: "Foreign", headerSnapshot: '{"fullName":"X"}' })
      .then((v) => v.currentVersionId!);
    const opportunity = await createOpportunity();
    await setJd(opportunity.id);
    await expect(
      createDeepMatchTask(
        prisma,
        userId,
        { jobOpportunityId: opportunity.id, resumeVariantVersionId: foreignVersion, requestKey: "r2" },
        FEATURE_ON,
      ),
    ).rejects.toMatchObject({ code: "DEEP_RESUME_VERSION_MISSING" });

    await expect(
      createDeepMatchTask(
        prisma,
        userId,
        { jobOpportunityId: opportunity.id, resumeVariantVersionId: versionId, requestKey: "r3" },
        FEATURE_RESTRICTED,
      ),
    ).rejects.toMatchObject({ code: "AB_WRITES_NOT_ENABLED" });
    expect(await prisma.harnessTask.count()).toBe(0);
  });
});

describe("claim, lease and epoch fencing", () => {
  it("grants a single claim, fences stale epochs and reclaims expired leases", async () => {
    const versionId = await createResumeVersion();
    const { task } = await createTask(versionId);

    const first = await claim(task.id);
    expect(first.epoch).toBe(1);
    // A second claim while the lease is live loses the CAS race.
    expect(
      await claimHarnessTask(prisma, { taskId: task.id, owner: "runner-b", leaseMs: 60_000 }),
    ).toBeNull();

    await expireLease(task.id);
    const second = await claimHarnessTask(prisma, {
      taskId: task.id,
      owner: "runner-b",
      leaseMs: 60_000,
    });
    expect(second?.epoch).toBe(2);

    // The superseded epoch can no longer write, renew or fail the task.
    await expect(
      guardedTaskUpdate(prisma, first, { currentStep: "RUN_ANALYSIS" }),
    ).rejects.toBeInstanceOf(HarnessOwnershipLost);
    expect((await renewHarnessLease(prisma, first, 60_000)).ok).toBe(false);
    expect(
      await failClaimedTask(prisma, first, { code: "LATE_WRITE" }),
    ).toBe(false);
    const row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("RUNNING");
    expect(row.claimEpoch).toBe(2);

    expect((await renewHarnessLease(prisma, second!, 60_000)).ok).toBe(true);
  });

  it("never claims a QUEUED task the user already cancelled", async () => {
    const versionId = await createResumeVersion();
    const { task } = await createTask(versionId);
    const result = await requestTaskCancel(prisma, userId, task.id);
    expect(result.status).toBe("CANCELLED");
    expect(
      await claimHarnessTask(prisma, { taskId: task.id, owner: OWNER, leaseMs: 60_000 }),
    ).toBeNull();
  });

  it("refuses renew, writes and commit on an expired lease even before takeover", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    const { task } = await createTask(versionId);
    const holder = await claim(task.id);

    // The holder stalls past its deadline; nobody has reclaimed yet —
    // ownership is still forfeit.
    await expireLease(task.id);
    expect((await renewHarnessLease(prisma, holder, 60_000)).ok).toBe(false);
    await expect(
      guardedTaskUpdate(prisma, holder, { lastHeartbeatAt: new Date() }),
    ).rejects.toBeInstanceOf(HarnessOwnershipLost);

    // A full execution attempt under the dead claim cannot commit either —
    // the very first guarded write (PIN's step marker) loses ownership.
    await executeDeepMatchTask(prisma, holder, {
      deps: depsForFetch(async () => okResponse(DEEP_RESULT)),
      env: FEATURE_ON,
    });
    let row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("RUNNING");
    expect(row.resultAnalysisId).toBeNull();
    expect(await countDeepMatchAnalyses()).toBe(0);
    const leaseLost = await prisma.harnessTaskEvent.findMany({
      where: { taskId: task.id, type: "LEASE_LOST" },
    });
    expect(leaseLost.length).toBeGreaterThan(0);

    // The next claim round reclaims the expired row and finishes — still
    // exactly one bound result.
    const second = await claim(task.id);
    expect(second.epoch).toBe(2);
    await executeDeepMatchTask(prisma, second, {
      deps: depsForFetch(async () => okResponse(DEEP_RESULT)),
      env: FEATURE_ON,
    });
    row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("SUCCEEDED");
    expect(await countDeepMatchAnalyses()).toBe(1);
  });
});

describe("cancel, sweep and retry", () => {
  it("settles RUNNING cancels through CANCELLING and keeps terminal rows immutable", async () => {
    const versionId = await createResumeVersion();
    const { task } = await createTask(versionId);
    const holder = await claim(task.id);

    const cancelled = await requestTaskCancel(prisma, userId, task.id);
    expect(cancelled.status).toBe("CANCELLING");

    // The holder settles it; the sweeper settles rows whose holder died.
    expect(await finalizeCancelledTask(prisma, { taskId: task.id, epoch: holder.epoch })).toBe(true);
    const row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("CANCELLED");

    // Terminal state is immutable: late writes and cancels are refused.
    expect(await failClaimedTask(prisma, holder, { code: "LATE" })).toBe(false);
    const again = await requestTaskCancel(prisma, userId, task.id);
    expect(again.status).toBe("CANCELLED");
  });

  it("sweeps a CANCELLING task whose holder vanished", async () => {
    const versionId = await createResumeVersion();
    const { task } = await createTask(versionId);
    await claim(task.id);
    await requestTaskCancel(prisma, userId, task.id);
    await expireLease(task.id);
    expect(await sweepHarnessTasks(prisma)).toBe(1);
    const row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("CANCELLED");
  });

  it("retries FAILED/CANCELLED as a new attempt and refuses terminal SUCCEEDED", async () => {
    const versionId = await createResumeVersion();
    const { task } = await createTask(versionId);
    const holder = await claim(task.id);
    expect(
      await failClaimedTask(prisma, holder, { code: "AI_EXECUTION_FAILED" }),
    ).toBe(true);

    const retried = await requestTaskRetry(prisma, userId, task.id);
    expect(retried.status).toBe("QUEUED");
    expect(retried.attemptCount).toBe(1);
    expect(retried.failureCode).toBeNull();

    await prisma.harnessTask.update({
      where: { id: task.id },
      data: { status: "SUCCEEDED", completedAt: new Date() },
    });
    await expect(requestTaskRetry(prisma, userId, task.id)).rejects.toMatchObject({
      code: "TASK_NOT_RETRYABLE",
    });
    await expect(
      getHarnessTask(prisma, otherUserId, task.id),
    ).rejects.toMatchObject({ code: "TASK_NOT_FOUND" });
  });
});

describe("executeDeepMatchTask", () => {
  it("runs the pinned chain and commits exactly one bound analysis", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    const { task } = await createTask(versionId);

    const bodies: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return okResponse(DEEP_RESULT);
    };
    const holder = await claim(task.id);
    await executeDeepMatchTask(prisma, holder, {
      deps: depsForFetch(fetchImpl),
      env: FEATURE_ON,
    });

    const row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("SUCCEEDED");
    expect(row.resultAnalysisId).not.toBeNull();
    expect(bodies).toHaveLength(1);
    expect(bodies[0].connectionId).toBe(connection.id);
    expect(bodies[0].model).toBe("deep-model-1");
    expect(String(bodies[0].prompt)).toContain(RESUME_HEADLINE);
    expect(String(bodies[0].prompt)).toContain(JD_TEXT.slice(0, 30));

    const analysis = await prisma.matchAnalysis.findUniqueOrThrow({
      where: { id: row.resultAnalysisId! },
      include: { deepMatchDetail: true },
    });
    expect(analysis.analysisType).toBe(MATCH_ANALYSIS_TYPE.DEEP_MATCH);
    expect(analysis.resumeVariantVersionId).toBe(versionId);
    expect(analysis.resolvedConnectionId).toBe(connection.id);
    expect(analysis.model).toBe("deep-model-1");
    expect(analysis.deepMatchDetail?.overallScore).toBe(84);
    expect(await countDeepMatchAnalyses()).toBe(1);

    // Trace: lifecycle + model-call records exist and carry no raw text.
    const events = await prisma.harnessTaskEvent.findMany({
      where: { taskId: task.id },
      orderBy: { seq: "asc" },
    });
    const types = events.map((event) => event.type);
    expect(types).toContain("TASK_CREATED");
    expect(types).toContain("TASK_CLAIMED");
    expect(types).toContain("MODEL_CALL_STARTED");
    expect(types).toContain("MODEL_CALL_FINISHED");
    expect(types).toContain("TASK_SUCCEEDED");
    for (const event of events) {
      const payload = event.payloadJson ?? "";
      expect(payload).not.toContain(RESUME_HEADLINE);
      expect(payload).not.toContain(JD_TEXT.slice(0, 30));
      expect(payload).not.toContain("Ada Tester");
    }
  });

  it("recovers a mid-step interruption on the pinned inputs and commits one result", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection("a");
    const replacement = await makeConnection("b");
    await assignMatch(connection.id, "deep-model-1");
    const { task } = await createTask(versionId);

    // First epoch dies inside RUN_ANALYSIS — the model call fails.
    const first = await claim(task.id);
    await executeDeepMatchTask(prisma, first, {
      deps: depsForFetch(async () => {
        throw new Error("channel gone");
      }),
      env: FEATURE_ON,
    });
    let row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.currentStep).toBe("RUN_ANALYSIS");

    // Meanwhile the user repoints the assignment and publishes a newer
    // resume version — recovery must NOT pick either up.
    await assignMatch(replacement.id, "deep-model-2");
    const variant = await prisma.resumeVariantVersion.findUniqueOrThrow({
      where: { id: versionId },
      select: { resumeVariantId: true },
    });
    await prisma.resumeVariantVersion.create({
      data: {
        resumeVariantId: variant.resumeVariantId,
        versionNumber: 2,
        status: "DRAFT",
        createdVia: "USER",
        headerSnapshot: JSON.stringify({ fullName: "Ada", headline: "NEW HEADLINE" }),
      },
    });

    const retried = await requestTaskRetry(prisma, userId, task.id);
    expect(retried.attemptCount).toBe(1);

    const bodies: Record<string, unknown>[] = [];
    const second = await claim(task.id);
    expect(second.epoch).toBe(2);
    await executeDeepMatchTask(prisma, second, {
      deps: depsForFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return okResponse(DEEP_RESULT);
      }),
      env: FEATURE_ON,
    });

    row = await prisma.harnessTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("SUCCEEDED");
    expect(await countDeepMatchAnalyses()).toBe(1);
    expect(bodies).toHaveLength(1);
    // Pinned connection/model/material — not the newer ones.
    expect(bodies[0].connectionId).toBe(connection.id);
    expect(bodies[0].model).toBe("deep-model-1");
    expect(String(bodies[0].prompt)).toContain(RESUME_HEADLINE);
    expect(String(bodies[0].prompt)).not.toContain("NEW HEADLINE");
  });

  it("settles a cancel requested during the model call without persisting a result", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    const { task } = await createTask(versionId);

    const holder = await claim(task.id);
    await executeDeepMatchTask(prisma, holder, {
      deps: depsForFetch(async () => {
        await requestTaskCancel(prisma, userId, task.id);
        return okResponse(DEEP_RESULT);
      }),
      env: FEATURE_ON,
    });

    const row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("CANCELLED");
    expect(row.resultAnalysisId).toBeNull();
    expect(await countDeepMatchAnalyses()).toBe(0);
  });

  it("fails a model call as retryable and a retry commits the only result", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    const { task } = await createTask(versionId);

    const first = await claim(task.id);
    await executeDeepMatchTask(prisma, first, {
      deps: depsForFetch(async () =>
        new Response(JSON.stringify({ ok: false, code: "AI_EXECUTION_FAILED" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
      env: FEATURE_ON,
    });
    let row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.failureCode).toBe("AI_EXECUTION_FAILED");
    const dto = await toDeepMatchTaskDTO(prisma, row);
    expect(dto.inputLost).toBe(false);

    await requestTaskRetry(prisma, userId, task.id);
    const second = await claim(task.id);
    await executeDeepMatchTask(prisma, second, {
      deps: depsForFetch(async () => okResponse(DEEP_RESULT)),
      env: FEATURE_ON,
    });
    row = await prisma.harnessTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("SUCCEEDED");
    expect(await countDeepMatchAnalyses()).toBe(1);
  });

  it("fails honestly at the commit boundary and retries commit without a second model call", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    const { task, opportunity } = await createTask(versionId);

    // The job is archived while the model call is in flight — the analysis
    // payload checkpoints, then COMMIT hits the business write gate.
    let modelCalls = 0;
    const first = await claim(task.id);
    await executeDeepMatchTask(prisma, first, {
      deps: depsForFetch(async () => {
        modelCalls += 1;
        await prisma.jobOpportunity.update({
          where: { id: opportunity.id },
          data: { archivedAt: new Date() },
        });
        return okResponse(DEEP_RESULT);
      }),
      env: FEATURE_ON,
    });
    let row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.failureCode).toBe("OPPORTUNITY_ARCHIVED");
    expect((await toDeepMatchTaskDTO(prisma, row)).inputLost).toBe(true);
    expect(await countDeepMatchAnalyses()).toBe(0);

    // Restore and retry: COMMIT re-runs from the checkpoint — no second
    // billable call, and exactly one bound result lands.
    await prisma.jobOpportunity.update({
      where: { id: opportunity.id },
      data: { archivedAt: null },
    });
    await requestTaskRetry(prisma, userId, task.id);
    const second = await claim(task.id);
    await executeDeepMatchTask(prisma, second, {
      deps: depsForFetch(async () => {
        modelCalls += 1;
        return okResponse(DEEP_RESULT);
      }),
      env: FEATURE_ON,
    });
    row = await prisma.harnessTask.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("SUCCEEDED");
    expect(modelCalls).toBe(1);
    expect(await countDeepMatchAnalyses()).toBe(1);
  });

  it("fails explicitly on a corrupted or step-inconsistent checkpoint", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    const { task } = await createTask(versionId);

    // A real run dies inside the model call — a valid checkpoint exists.
    const first = await claim(task.id);
    await executeDeepMatchTask(prisma, first, {
      deps: depsForFetch(async () => {
        throw new Error("channel gone");
      }),
      env: FEATURE_ON,
    });
    let row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.currentStep).toBe("RUN_ANALYSIS");
    const goodPinned = row.pinnedJson!;

    // Corrupt the checkpoint's nested structure: retry must refuse the
    // payload explicitly instead of trusting half of it.
    await prisma.harnessTask.update({
      where: { id: task.id },
      data: {
        pinnedJson: JSON.stringify({
          v: "1",
          inputs: { jobDescriptionParseId: "x" },
        }),
      },
    });
    await requestTaskRetry(prisma, userId, task.id);
    const second = await claim(task.id);
    await executeDeepMatchTask(prisma, second, {
      deps: depsForFetch(async () => okResponse(DEEP_RESULT)),
      env: FEATURE_ON,
    });
    row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.failureCode).toBe("DEEP_MATCH_STATE_CONFLICT");
    expect((await toDeepMatchTaskDTO(prisma, row)).inputLost).toBe(true);
    expect(await countDeepMatchAnalyses()).toBe(0);

    // A structurally valid analysis artifact sitting on the wrong step is
    // damage too — without the check the task would idle-reclaim forever.
    const pinned = JSON.parse(goodPinned) as Record<string, unknown>;
    pinned.analysis = {
      payload: { ...DEEP_RESULT },
      provider: "DEVIN",
      model: "deep-model-1",
      resolvedConnectionId: connection.id,
      managedAiProvenance: null,
      attemptCount: 1,
      retried: false,
    };
    await prisma.harnessTask.update({
      where: { id: task.id },
      data: { pinnedJson: JSON.stringify(pinned), currentStep: "RUN_ANALYSIS" },
    });
    await requestTaskRetry(prisma, userId, task.id);
    const third = await claim(task.id);
    await executeDeepMatchTask(prisma, third, {
      deps: depsForFetch(async () => okResponse(DEEP_RESULT)),
      env: FEATURE_ON,
    });
    row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.failureCode).toBe("DEEP_MATCH_STATE_CONFLICT");
  });

  it("marks the just-committed result stale when the JD changed mid-run", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    const { task, opportunity } = await createTask(versionId);

    const holder = await claim(task.id);
    await executeDeepMatchTask(prisma, holder, {
      deps: depsForFetch(async () => {
        // The user saves a newer JD version while the model is thinking —
        // the task still commits its pinned-v1 result, but it must not
        // pose as the current analysis.
        await updateJd(
          opportunity.id,
          "Updated JD — now requires Go services experience.",
        );
        return okResponse(DEEP_RESULT);
      }),
      env: FEATURE_ON,
    });

    const row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("SUCCEEDED");
    const analysis = await prisma.matchAnalysis.findUniqueOrThrow({
      where: { id: row.resultAnalysisId! },
    });
    expect(analysis.isStale).toBe(true);
    expect(JSON.parse(analysis.staleReasonCodes ?? "[]")).toContain(
      MATCH_STALE_REASON.JD_CHANGED,
    );
    expect(await countDeepMatchAnalyses()).toBe(1);
  });

  it("pins the dual-track preference context with the material — read-only, replayed verbatim", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    await prisma.jobSearchPreference.create({
      data: { userId, preferredCities: "上海" },
    });
    await prisma.userMemoryEntry.create({
      data: {
        userId,
        category: "career_goal",
        key: "cities",
        content: "杭州",
      },
    });
    await prisma.userMemoryEntry.create({
      data: {
        userId,
        category: "collaboration_habit",
        key: "style",
        content: "不属于求职偏好",
      },
    });
    const { task } = await createTask(versionId);

    const preferencesBefore =
      await prisma.jobSearchPreference.findUniqueOrThrow({
        where: { userId },
      });
    const bodies: Record<string, unknown>[] = [];
    const holder = await claim(task.id);
    await executeDeepMatchTask(prisma, holder, {
      deps: depsForFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return okResponse(DEEP_RESULT);
      }),
      env: FEATURE_ON,
    });

    const row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("SUCCEEDED");
    expect(bodies).toHaveLength(1);
    const prompt = String(bodies[0].prompt);
    expect(prompt).toContain("CANDIDATE JOB-SEARCH PREFERENCES");
    expect(prompt).toContain("上海");
    expect(prompt).toContain("杭州");
    expect(prompt).toContain("对话沉淀偏好");
    expect(prompt).not.toContain("不属于求职偏好");

    // The preference context lives inside the pinned material — recovery
    // replays exactly this snapshot and never re-resolves the tables.
    const pinned = JSON.parse(row.pinnedJson!) as {
      promptVersion?: string;
      material: {
        preferenceText?: string | null;
        preferenceSnapshot?: Record<string, unknown>;
      };
    };
    expect(pinned.promptVersion).toBe("deep-match-v2");
    expect(pinned.material.preferenceText).toContain("杭州");
    expect(pinned.material.preferenceSnapshot).toMatchObject({
      preferredCities: "上海",
    });
    const analysis = await prisma.matchAnalysis.findUniqueOrThrow({
      where: { id: row.resultAnalysisId! },
    });
    expect(analysis.promptVersion).toBe("deep-match-v2");

    // The business table was read, never written.
    const preferencesAfter =
      await prisma.jobSearchPreference.findUniqueOrThrow({
        where: { userId },
      });
    expect(preferencesAfter).toEqual(preferencesBefore);
  });

  it("master switch off → the prompt carries structured fields but never memory notes", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    await prisma.jobSearchPreference.create({
      data: { userId, preferredCities: "上海" },
    });
    await prisma.userMemoryEntry.create({
      data: {
        userId,
        category: "career_goal",
        key: "cities",
        content: "杭州",
      },
    });
    const settings = JSON.stringify({
      settings: { general: { agent: { longTermMemoryEnabled: false } } },
    });
    await prisma.userSettings.create({
      data: { userId, settings },
    });
    const { task } = await createTask(versionId);

    const bodies: Record<string, unknown>[] = [];
    const holder = await claim(task.id);
    await executeDeepMatchTask(prisma, holder, {
      deps: depsForFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return okResponse(DEEP_RESULT);
      }),
      env: FEATURE_ON,
    });

    expect(bodies).toHaveLength(1);
    const prompt = String(bodies[0].prompt);
    expect(prompt).toContain("上海");
    expect(prompt).not.toContain("杭州");
    expect(prompt).not.toContain("对话沉淀偏好");
  });

  it("replays a pre-M2.2 checkpoint carrying no preference fields", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    // Preference + memory exist now — a checkpoint written before M2.2
    // never saw them and must replay the v1 prompt shape verbatim.
    await prisma.jobSearchPreference.create({
      data: { userId, preferredCities: "上海" },
    });
    await prisma.userMemoryEntry.create({
      data: {
        userId,
        category: "career_goal",
        key: "cities",
        content: "杭州",
      },
    });
    const { task } = await createTask(versionId);

    const first = await claim(task.id);
    await executeDeepMatchTask(prisma, first, {
      deps: depsForFetch(async () => {
        throw new Error("channel gone");
      }),
      env: FEATURE_ON,
    });
    let row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.currentStep).toBe("RUN_ANALYSIS");

    // Rewrite the checkpoint into the pre-M2.2 shape: no preference fields.
    const pinned = JSON.parse(row.pinnedJson!) as {
      promptVersion?: string;
      material: Record<string, unknown>;
    };
    delete pinned.material.preferenceText;
    delete pinned.material.preferenceSnapshot;
    pinned.promptVersion = "deep-match-v1";
    await prisma.harnessTask.update({
      where: { id: task.id },
      data: { pinnedJson: JSON.stringify(pinned) },
    });

    await requestTaskRetry(prisma, userId, task.id);
    const bodies: Record<string, unknown>[] = [];
    const second = await claim(task.id);
    await executeDeepMatchTask(prisma, second, {
      deps: depsForFetch(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return okResponse(DEEP_RESULT);
      }),
      env: FEATURE_ON,
    });

    row = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(row.status).toBe("SUCCEEDED");
    expect(bodies).toHaveLength(1);
    // The recovered run replayed the checkpoint's own material — the newly
    // saved preference rows were NOT re-resolved into the prompt.
    expect(String(bodies[0].prompt)).not.toContain("杭州");
    expect(String(bodies[0].prompt)).not.toContain("对话沉淀偏好");
    expect(await countDeepMatchAnalyses()).toBe(1);
  });

  it("marks the superseded deep analysis PREFERENCE_CHANGED when the pinned preference context changed", async () => {
    const versionId = await createResumeVersion();
    const connection = await makeConnection();
    await assignMatch(connection.id, "deep-model-1");
    await prisma.userMemoryEntry.create({
      data: {
        userId,
        category: "career_goal",
        key: "cities",
        content: "杭州",
      },
    });
    const { task, opportunity } = await createTask(versionId);
    const fetchImpl: typeof fetch = async () => okResponse(DEEP_RESULT);

    const first = await claim(task.id);
    await executeDeepMatchTask(prisma, first, {
      deps: depsForFetch(fetchImpl),
      env: FEATURE_ON,
    });
    const firstRow = await prisma.harnessTask.findUniqueOrThrow({
      where: { id: task.id },
    });
    expect(firstRow.status).toBe("SUCCEEDED");

    // The memory note changes — same JD, same resume version.
    await prisma.userMemoryEntry.updateMany({
      where: { userId, category: "career_goal", key: "cities" },
      data: { content: "深圳" },
    });

    const { task: secondTask } = await createDeepMatchTask(
      prisma,
      userId,
      {
        jobOpportunityId: opportunity.id,
        resumeVariantVersionId: versionId,
        requestKey: `req-${randomUUID()}`,
      },
      FEATURE_ON,
    );
    const secondClaim = await claim(secondTask.id);
    await executeDeepMatchTask(prisma, secondClaim, {
      deps: depsForFetch(fetchImpl),
      env: FEATURE_ON,
    });

    const stale = await prisma.matchAnalysis.findUniqueOrThrow({
      where: { id: firstRow.resultAnalysisId! },
    });
    expect(stale.isStale).toBe(true);
    expect(JSON.parse(stale.staleReasonCodes ?? "[]")).toEqual([
      MATCH_STALE_REASON.PREFERENCE_CHANGED,
    ]);
    expect(await countDeepMatchAnalyses()).toBe(2);
  });
});

describe("harnessRunnerTick — heartbeat and cancel linkage", () => {
  it(
    "renews the lease on heartbeat while a long model call runs",
    { timeout: 20_000 },
    async () => {
      const versionId = await createResumeVersion();
      const connection = await makeConnection();
      await assignMatch(connection.id, "deep-model-1");
      const { task } = await createTask(versionId);

      let observedHeartbeat: Date | null = null;
      let fetchStart = 0;
      await harnessRunnerTick(
        prisma,
        depsForFetch(async () => {
          fetchStart = Date.now();
          // Long enough for at least one 5s heartbeat tick.
          await new Promise((r) => setTimeout(r, 5_600));
          const mid = await prisma.harnessTask.findUniqueOrThrow({
            where: { id: task.id },
          });
          observedHeartbeat = mid.lastHeartbeatAt;
          return okResponse(DEEP_RESULT);
        }),
        FEATURE_ON,
      );

      const row = await prisma.harnessTask.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(row.status).toBe("SUCCEEDED");
      // The heartbeat wrote a heartbeat timestamp strictly newer than the
      // step-start write that ran just before the model call began.
      expect(observedHeartbeat).not.toBeNull();
      expect(observedHeartbeat!.getTime()).toBeGreaterThan(fetchStart + 3_000);
    },
  );

  it(
    "aborts the in-flight model call when a cancel lands mid-run",
    { timeout: 20_000 },
    async () => {
      const versionId = await createResumeVersion();
      const connection = await makeConnection();
      await assignMatch(connection.id, "deep-model-1");
      const { task } = await createTask(versionId);

      let abortObserved = false;
      await harnessRunnerTick(
        prisma,
        depsForFetch(async (_url, init) => {
          await requestTaskCancel(prisma, userId, task.id);
          // Wait for the runner's heartbeat-driven abort (≈5s) or bail.
          await new Promise<void>((r) => {
            const timer = setTimeout(r, 9_000);
            init?.signal?.addEventListener(
              "abort",
              () => {
                abortObserved = true;
                clearTimeout(timer);
                r();
              },
              { once: true },
            );
          });
          return okResponse(DEEP_RESULT);
        }),
        FEATURE_ON,
      );

      expect(abortObserved).toBe(true);
      const row = await prisma.harnessTask.findUniqueOrThrow({
        where: { id: task.id },
      });
      expect(row.status).toBe("CANCELLED");
      expect(row.resultAnalysisId).toBeNull();
      expect(await countDeepMatchAnalyses()).toBe(0);
      const cancelled = await prisma.harnessTaskEvent.findMany({
        where: { taskId: task.id, type: "TASK_CANCELLED" },
      });
      expect(cancelled.length).toBe(1);
    },
  );
});

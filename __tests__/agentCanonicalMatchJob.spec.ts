// @vitest-environment node
/**
 * Canonical fresh-native match_job (AGENT-CAPABILITIES): the durable,
 * approval-gated tool that runs FAST_SCREENING against the session-bound
 * job and persists a MatchAnalysis through the canonical service.
 *
 * The durable invariants under test:
 *   - identity comes from the persisted originating user turn, never the
 *     client requestId or the model toolCallId;
 *   - one execution settles at most one analysis (DB-level unique binding,
 *     committed atomically with the analysis);
 *   - same-turn retries/resumes replays or resumes the same operationKey,
 *     a new explicit user turn mints a new analysis;
 *   - every post-reservation outcome is recorded and replays verbatim.
 */
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import {
  AB_ROLLOUT_SCOPE_ENV,
  AB_RUNTIME_FEATURE_ENV,
  activateFreshAbNative,
  CareerMaterialService,
  hashCanonical,
  OpportunityService,
  ResumeVariantService,
  sha256Utf8,
} from "@/lib/career";
import { RESUME_VERSION_STATUS } from "@/lib/career/identities";
import {
  admitConversationRequest,
  cancelConversationRequest,
  type ConversationRequest,
} from "@/lib/agent/conversationRequest";
import { acquireMatchJobExecution } from "@/lib/agent/toolExecution";
import { buildCanonicalMatchJobTool } from "@/lib/agent/tools/canonicalMatchJob";
import { executeStructuredForAssignment } from "@/lib/ai/structured-execution";
import { runFastScreening } from "@/lib/career/fastScreening";
import { MatchAnalysisService } from "@/lib/career/matchAnalysisService";
import { backupCoverageStatus, BACKUP_COVERAGE_STATUS } from "@/lib/backup/coverage";
import { BackupDataSchema } from "@/lib/backup/schema";
import {
  makeAbTestDbUrl,
  migrateDeploy,
  preparePrismaProject,
} from "./helpers/abSchemaTestDb";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

vi.mock("@/lib/ai/structured-execution", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/ai/structured-execution")
  >();
  return {
    ...actual,
    executeStructuredForAssignment: vi.fn(actual.executeStructuredForAssignment),
  };
});

const ctx = await vi.hoisted(async () => {
  const helpers = await import("./helpers/abSchemaTestDb");
  const url = helpers.makeAbTestDbUrl();
  return url;
});

// The business-assignment resolver and several service internals read through
// the default client — point it at the disposable DB too.
vi.mock("@/lib/db", async () => {
  const { PrismaClient } = await import("@prisma/client");
  return {
    default: new PrismaClient({ datasources: { db: { url: ctx.url } } }),
  };
});

const FEATURE_ON = {
  ...process.env,
  [AB_RUNTIME_FEATURE_ENV]: "true",
  [AB_ROLLOUT_SCOPE_ENV]: "full",
};

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });
const structuredSpy = vi.mocked(executeStructuredForAssignment);

let userId: string;
let otherUserId: string;
let companyId: string;

beforeAll(() => {
  migrateDeploy(ctx.url, preparePrismaProject(ctx.dir));
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
  vi.clearAllMocks();
  await resetDisposableDb(prisma);
  userId = await seedAccount(prisma, `agent-match-${Date.now()}@example.com`);
  otherUserId = await seedAccount(
    prisma,
    `agent-match-other-${Date.now()}@example.com`,
  );
  companyId = (
    await prisma.company.create({
      data: {
        label: "Acme",
        value: `acme-${randomUUID()}`,
        createdBy: userId,
      },
    })
  ).id;
  await activateFreshAbNative(prisma);
});

const VERDICT = {
  verdict: "PASS",
  reasons: "Core stack and seniority align.",
  hardRequirements: "Meets the stated requirements.",
  coreMatch: "Strong overlap on backend work.",
  preferenceMatch: null,
};

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

function userMessage(id: string): UIMessage {
  return {
    id,
    role: "user",
    parts: [{ type: "text", text: "分析这个职位的匹配度" }],
  } as UIMessage;
}

function proposalMessage(
  id: string,
  toolCallId: string,
  approvalId: string,
  input: Record<string, unknown>,
): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "tool-match_job",
        toolCallId,
        state: "approval-requested",
        input,
        approval: { id: approvalId },
      },
    ],
  } as unknown as UIMessage;
}

async function seedConversation(messages: UIMessage[]) {
  return prisma.chatConversation.create({
    data: { userId, messages: JSON.stringify(messages) },
  });
}

async function admitApproval(
  conversationId: string,
  approvalId: string,
): Promise<ConversationRequest> {
  const row = await prisma.chatConversation.findUniqueOrThrow({
    where: { id: conversationId },
  });
  const request = await admitConversationRequest(
    {
      userId,
      conversationId,
      requestId: `req-${randomUUID()}`,
      expectedRevision: row.revision,
      operation: "approval",
      approvalId,
      decision: true,
    },
    prisma,
  );
  request.responseMessageId = (
    JSON.parse(row.messages) as UIMessage[]
  ).at(-1)!.id;
  return request;
}

function buildTool(input: {
  request?: ConversationRequest;
  pageJobId?: string | null;
  fetchImpl?: typeof fetch;
}) {
  return buildCanonicalMatchJobTool({
    userId,
    pageJobId: input.pageJobId,
    request: input.request,
    guard: { running: false },
    db: prisma,
    env: FEATURE_ON,
    execDeps: {
      execUrl: "http://127.0.0.1:9999",
      internalToken: "test-token",
      fetchImpl: input.fetchImpl ?? (async () => okResponse(VERDICT)),
      dbClient: prisma as never,
    },
  });
}

async function execute(
  tool: ReturnType<typeof buildCanonicalMatchJobTool>,
  input: Record<string, unknown>,
  toolCallId: string,
) {
  return (await tool.execute!(input as never, {
    toolCallId,
    messages: [],
  } as never)) as Record<string, unknown>;
}

async function setJd(opportunityId: string, content: string) {
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

async function createOpportunity(title = "Staff Engineer") {
  return new OpportunityService(prisma, userId, FEATURE_ON).create({
    companyId,
    title,
  });
}

async function makeConnection() {
  return prisma.aIConnection.create({
    data: {
      userId,
      provider: "DEVIN",
      backendKind: "DEVIN_RUNTIME",
      displayName: "Devin",
      status: "CONNECTED",
      runtimeProfileRef: `rp_${randomUUID()}`,
    },
  });
}

async function assignMatch(connectionId: string, model = "screen-model") {
  return prisma.aIBusinessAssignment.create({
    data: { userId, purpose: "MATCH_ANALYSIS", connectionId, model },
  });
}

async function createMaterial() {
  const materials = new CareerMaterialService(prisma, userId, FEATURE_ON);
  const item = await materials.create({
    type: "SKILL",
    title: "TypeScript",
    detail: { skillName: "TypeScript" },
  });
  await materials.addEvidence({
    materialItemId: item.id,
    kind: "SKILL_USAGE",
    content: "5 years production TS",
  });
}

async function setupMatchable() {
  const opportunity = await createOpportunity();
  await setJd(opportunity.id, "Build TypeScript services at scale.");
  await createMaterial();
  const connection = await makeConnection();
  await assignMatch(connection.id);
  return { opportunity, connection };
}

const lastExecutionCall = () =>
  structuredSpy.mock.calls.at(-1)?.[0] as
    | { operationId?: string; managedResource?: { resourceKey?: string } }
    | undefined;

describe("canonical match_job — durable admission boundary", () => {
  it("refuses to execute without an admitted approval carrying this toolCall", async () => {
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);
    // No request at all — a bare execute has no persisted turn to bind to.
    await expect(
      execute(buildTool({}), {}, "call-1"),
    ).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });

    // An admitted approval for a DIFFERENT toolCall must not carry this call.
    const request = await admitApproval(convo.id, "ap-1");
    await expect(
      execute(buildTool({ request }), {}, "call-other"),
    ).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });
    expect(request.failure?.code).toBe("CONVERSATION_TURN_CONFLICT");
    expect(await prisma.agentToolExecution.count()).toBe(0);
  });

  it("always requires approval (needsApproval is constant true)", async () => {
    const tool = buildTool({});
    expect(tool.needsApproval).toBe(true);
  });
});

describe("canonical match_job — run", () => {
  it("screens the session-bound job on career-profile material and persists history + execution + receipt", async () => {
    const { opportunity, connection } = await setupMatchable();
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);
    const request = await admitApproval(convo.id, "ap-1");
    const prompts: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      prompts.push(
        String((JSON.parse(String(init?.body)) as { prompt: string }).prompt),
      );
      return okResponse(VERDICT);
    };

    const result = (await execute(
      buildTool({ request, pageJobId: opportunity.id, fetchImpl }),
      {},
      "call-1",
    )) as {
      status: string;
      analysisId: string;
      jobId: string;
      verdict: string;
      source: { kind: string };
      historyCount: number;
    };

    expect(result.status).toBe("ok");
    expect(result.jobId).toBe(opportunity.id);
    expect(result.verdict).toBe("PASS");
    expect(result.source).toEqual({ kind: "career-profile" });
    expect(result.historyCount).toBe(1);

    const analysis = await prisma.matchAnalysis.findUniqueOrThrow({
      where: { id: result.analysisId },
      include: { fastScreeningDetail: true },
    });
    expect(analysis.analysisType).toBe("FAST_SCREENING");
    expect(analysis.resolvedConnectionId).toBe(connection.id);
    expect(analysis.fastScreeningDetail?.verdict).toBe("PASS");

    // The durable execution is bound 1:1 to the analysis.
    const execution = await prisma.agentToolExecution.findFirstOrThrow({
      where: { matchAnalysisId: analysis.id },
    });
    expect(execution.status).toBe("COMPLETED");
    expect(execution.conversationId).toBe(convo.id);
    expect(execution.turnKey).toBe("u1");
    expect(execution.resultJson).toEqual(expect.any(String));
    expect(JSON.parse(execution.resultJson!)).toMatchObject({
      status: "ok",
      analysisId: analysis.id,
    });
    expect(lastExecutionCall()?.operationId).toBe(execution.operationKey);
    expect(lastExecutionCall()?.managedResource?.resourceKey).toBe(
      execution.operationKey,
    );

    // The receipt was committed to the persisted transcript.
    const row = await prisma.chatConversation.findUniqueOrThrow({
      where: { id: convo.id },
    });
    const messages = JSON.parse(row.messages) as UIMessage[];
    const part = messages
      .flatMap((m) => m.parts)
      .find(
        (p) =>
          typeof p === "object" &&
          p !== null &&
          (p as { toolCallId?: string }).toolCallId === "call-1",
      ) as { state?: string; output?: { status?: string } } | undefined;
    expect(part?.state).toBe("output-available");
    expect(part?.output?.status).toBe("ok");

    // Career-profile material reached the prompt; no resume bound.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("TypeScript");
    expect(prompts[0]).toContain("5 years production TS");
    await cancelConversationRequest(userId, convo.id, request.requestId, prisma);
  });

  it("runs against a named resume variant's submittable version", async () => {
    const { opportunity } = await setupMatchable();
    const variants = new ResumeVariantService(prisma, userId, FEATURE_ON);
    const variant = await variants.createVariant({
      name: "通用简历",
      headerSnapshot: JSON.stringify({
        fullName: "张三",
        headline: "后端工程师",
      }),
    });
    const versionId = variant.currentVersionId!;
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", { resumeTitle: "通用简历" }),
    ]);
    const request = await admitApproval(convo.id, "ap-1");
    const prompts: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      prompts.push(String(JSON.parse(String(init?.body)).prompt));
      return okResponse(VERDICT);
    };

    const result = (await execute(
      buildTool({ request, pageJobId: opportunity.id, fetchImpl }),
      { resumeTitle: "通用简历" },
      "call-1",
    )) as {
      status: string;
      source: {
        kind: string;
        variantId: string;
        versionId: string;
        versionNumber: number;
      };
    };

    expect(result.status).toBe("ok");
    expect(result.source.kind).toBe("resume-version");
    expect(result.source.variantId).toBe(variant.id);
    expect(result.source.versionId).toBe(versionId);
    // The resume text — not the career profile — fed this run.
    expect(prompts[0]).toContain("张三");
    await cancelConversationRequest(userId, convo.id, request.requestId, prisma);
  });
});

describe("canonical match_job — job binding and source validation", () => {
  it("returns no_job for a missing, foreign, or absent session job — never the model's choice", async () => {
    await setupMatchable();
    // A foreign opportunity owned by another user must not leak or run.
    const otherCompany = await prisma.company.create({
      data: {
        label: "Other",
        value: `other-${randomUUID()}`,
        createdBy: otherUserId,
      },
    });
    const foreign = await new OpportunityService(
      prisma,
      otherUserId,
      FEATURE_ON,
    ).create({ companyId: otherCompany.id, title: "Foreign" });

    // No pageJobId at all.
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);
    const request = await admitApproval(convo.id, "ap-1");
    const first = await execute(
      buildTool({ request, pageJobId: null }),
      {},
      "call-1",
    );
    expect(first).toMatchObject({ status: "no_job" });
    expect(await prisma.matchAnalysis.count()).toBe(0);
    await cancelConversationRequest(userId, convo.id, request.requestId, prisma);

    // A foreign session job id is indistinguishable from no job.
    const convo2 = await seedConversation([
      userMessage("u2"),
      proposalMessage("a1", "call-9", "ap-9", {}),
    ]);
    const request2 = await admitApproval(convo2.id, "ap-9");
    const second = await execute(
      buildTool({ request: request2, pageJobId: foreign.id }),
      {},
      "call-9",
    );
    expect(second).toMatchObject({ status: "no_job" });
    expect(await prisma.matchAnalysis.count()).toBe(0);
    await cancelConversationRequest(userId, convo2.id, request2.requestId, prisma);
  });

  it("rejects an archived session job before any parse or AI work", async () => {
    const { opportunity } = await setupMatchable();
    await prisma.jobOpportunity.update({
      where: { id: opportunity.id },
      data: { archivedAt: new Date() },
    });
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);
    const request = await admitApproval(convo.id, "ap-1");
    const fetchSpy = vi.fn(async () => okResponse(VERDICT));
    const result = await execute(
      buildTool({ request, pageJobId: opportunity.id, fetchImpl: fetchSpy }),
      {},
      "call-1",
    );
    expect(result).toMatchObject({
      status: "unavailable",
      code: "OPPORTUNITY_ARCHIVED",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(structuredSpy).not.toHaveBeenCalled();
    expect(await prisma.matchAnalysis.count()).toBe(0);
    expect(await prisma.jobDescriptionParse.count()).toBe(0);
    await cancelConversationRequest(userId, convo.id, request.requestId, prisma);
  });

  it("returns needs_selection for an unknown resume title and no_resumes when none exist", async () => {
    const { opportunity } = await setupMatchable();
    const variants = new ResumeVariantService(prisma, userId, FEATURE_ON);
    await variants.createVariant({ name: "通用简历" });
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", { resumeTitle: "不存在的简历" }),
    ]);
    const request = await admitApproval(convo.id, "ap-1");
    const result = await execute(
      buildTool({ request, pageJobId: opportunity.id }),
      { resumeTitle: "不存在的简历" },
      "call-1",
    );
    expect(result).toMatchObject({ status: "needs_selection" });
    expect(
      (result as { resumes: { title: string }[] }).resumes.map((r) => r.title),
    ).toContain("通用简历");
    expect(await prisma.matchAnalysis.count()).toBe(0);
    await cancelConversationRequest(userId, convo.id, request.requestId, prisma);
  });

  it("returns VERSION_NOT_SUBMITTABLE when the named variant has no submittable version", async () => {
    const { opportunity } = await setupMatchable();
    const variants = new ResumeVariantService(prisma, userId, FEATURE_ON);
    const variant = await variants.createVariant({ name: "旧简历" });
    await prisma.resumeVariantVersion.updateMany({
      where: { resumeVariantId: variant.id },
      data: { status: RESUME_VERSION_STATUS.ARCHIVED },
    });
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", { resumeTitle: "旧简历" }),
    ]);
    const request = await admitApproval(convo.id, "ap-1");
    const result = await execute(
      buildTool({ request, pageJobId: opportunity.id }),
      { resumeTitle: "旧简历" },
      "call-1",
    );
    expect(result).toMatchObject({
      status: "unavailable",
      code: "VERSION_NOT_SUBMITTABLE",
    });
    expect(await prisma.matchAnalysis.count()).toBe(0);
    // The terminal outcome is recorded on the execution — replayed verbatim.
    const execution = await prisma.agentToolExecution.findFirstOrThrow({
      where: { conversationId: convo.id },
    });
    expect(execution.status).toBe("FAILED");
    expect(execution.failureCode).toBe("VERSION_NOT_SUBMITTABLE");
    await cancelConversationRequest(userId, convo.id, request.requestId, prisma);
  });
});

describe("canonical match_job — durable execution semantics", () => {
  async function runToCompletion(convo: Awaited<ReturnType<typeof seedConversation>>, opportunityId: string) {
    const request = await admitApproval(convo.id, "ap-1");
    const result = await execute(
      buildTool({ request, pageJobId: opportunityId }),
      {},
      "call-1",
    );
    await cancelConversationRequest(userId, convo.id, request.requestId, prisma);
    return result;
  }

  async function appendProposalAndAdmit(
    conversationId: string,
    messageId: string,
    toolCallId: string,
    approvalId: string,
    input: Record<string, unknown> = {},
  ) {
    const row = await prisma.chatConversation.findUniqueOrThrow({
      where: { id: conversationId },
    });
    const messages = JSON.parse(row.messages) as UIMessage[];
    messages.push(
      proposalMessage(messageId, toolCallId, approvalId, input),
    );
    await prisma.chatConversation.update({
      where: { id: conversationId },
      data: { messages: JSON.stringify(messages) },
    });
    return admitApproval(conversationId, approvalId);
  }

  it("replays the same persisted turn's second proposal against one execution — no second analysis", async () => {
    const { opportunity } = await setupMatchable();
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);
    const first = (await runToCompletion(convo, opportunity.id)) as {
      status: string;
      analysisId: string;
    };
    expect(first.status).toBe("ok");
    expect(structuredSpy).toHaveBeenCalledTimes(1);

    // Same user turn, new proposal + new toolCallId — the model's retry.
    const request2 = await appendProposalAndAdmit(convo.id, "a2", "call-2", "ap-2");
    const second = (await execute(
      buildTool({ request: request2, pageJobId: opportunity.id }),
      {},
      "call-2",
    )) as { status: string; analysisId: string };
    expect(second.status).toBe("ok");
    expect(second.analysisId).toBe(first.analysisId);
    expect(await prisma.matchAnalysis.count()).toBe(1);
    expect(await prisma.agentToolExecution.count()).toBe(1);
    expect(structuredSpy).toHaveBeenCalledTimes(1);
    await cancelConversationRequest(userId, convo.id, request2.requestId, prisma);
  });

  it("mints a new analysis for a new explicit user turn", async () => {
    const { opportunity } = await setupMatchable();
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);
    const first = (await runToCompletion(convo, opportunity.id)) as {
      analysisId: string;
    };

    // A second explicit user request in the same conversation.
    const row = await prisma.chatConversation.findUniqueOrThrow({
      where: { id: convo.id },
    });
    const messages = JSON.parse(row.messages) as UIMessage[];
    messages.push(userMessage("u2"));
    messages.push(proposalMessage("a2", "call-2", "ap-2", {}));
    await prisma.chatConversation.update({
      where: { id: convo.id },
      data: { messages: JSON.stringify(messages) },
    });
    const request2 = await admitApproval(convo.id, "ap-2");
    const second = (await execute(
      buildTool({ request: request2, pageJobId: opportunity.id }),
      {},
      "call-2",
    )) as { status: string; analysisId: string };
    expect(second.status).toBe("ok");
    expect(second.analysisId).not.toBe(first.analysisId);
    expect(await prisma.matchAnalysis.count()).toBe(2);
    expect(await prisma.agentToolExecution.count()).toBe(2);
    expect(structuredSpy).toHaveBeenCalledTimes(2);
    await cancelConversationRequest(userId, convo.id, request2.requestId, prisma);
  });

  it("resumes a PENDING execution under the same operationKey after a mid-run failure", async () => {
    const { opportunity } = await setupMatchable();
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);

    // Crash between the AI call and the analysis write.
    const createSpy = vi
      .spyOn(MatchAnalysisService.prototype, "createFastScreening")
      .mockRejectedValueOnce(new Error("disk full"));
    const request1 = await admitApproval(convo.id, "ap-1");
    await expect(
      execute(buildTool({ request: request1, pageJobId: opportunity.id }), {}, "call-1"),
    ).rejects.toThrow("disk full");
    createSpy.mockRestore();
    await cancelConversationRequest(userId, convo.id, request1.requestId, prisma);

    const pending = await prisma.agentToolExecution.findFirstOrThrow({
      where: { conversationId: convo.id },
    });
    expect(pending.status).toBe("PENDING");
    expect(pending.matchAnalysisId).toBeNull();
    expect(await prisma.matchAnalysis.count()).toBe(0);

    // Retry on the same user turn resumes the reservation — same operationKey.
    const request2 = await appendProposalAndAdmit(convo.id, "a2", "call-2", "ap-2");
    const second = (await execute(
      buildTool({ request: request2, pageJobId: opportunity.id }),
      {},
      "call-2",
    )) as { status: string; analysisId: string };
    expect(second.status).toBe("ok");
    expect(lastExecutionCall()?.operationId).toBe(pending.operationKey);
    expect(lastExecutionCall()?.managedResource?.resourceKey).toBe(
      pending.operationKey,
    );
    const settled = await prisma.agentToolExecution.findUniqueOrThrow({
      where: { id: pending.id },
    });
    expect(settled.status).toBe("COMPLETED");
    expect(settled.matchAnalysisId).toBe(second.analysisId);
    expect(await prisma.matchAnalysis.count()).toBe(1);
    await cancelConversationRequest(userId, convo.id, request2.requestId, prisma);
  });

  it("rebuilds the ok-result for a COMPLETED execution whose receipt never landed", async () => {
    const { opportunity } = await setupMatchable();
    const jd = await prisma.jobDescriptionVersion.findFirstOrThrow({
      where: { jobOpportunityId: opportunity.id },
    });
    const parse = await prisma.jobDescriptionParse.create({
      data: {
        jobDescriptionVersionId: jd.id,
        schemaVersion: "1",
        parserVersion: "jd-raw-text-v1",
        structuredData: JSON.stringify({ kind: "RAW_TEXT", text: "jd" }),
        parseStatus: "SUCCEEDED",
        inputHash: "parse-hash",
        parsedAt: new Date(),
      },
    });
    // Simulate the crash window: analysis persisted and linked, no resultJson.
    const analysis = await prisma.matchAnalysis.create({
      data: {
        userId,
        jobOpportunityId: opportunity.id,
        jobDescriptionParseId: parse.id,
        analysisType: "FAST_SCREENING",
        inputHash: "h",
        analysisSchemaVersion: "1",
        status: "COMPLETED",
        provider: "DEVIN",
        model: "screen-model",
        fastScreeningDetail: {
          create: {
            verdict: "BORDERLINE",
            inputSnapshot: JSON.stringify({
              careerMaterialSnapshot: { kind: "CAREER_PROFILE" },
            }),
            reasons: "Recovered reasons.",
          },
        },
      },
    });
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);
    // Mint the row through the real acquire path so inputHash matches, then
    // move it into the crash-window state.
    const request1 = await admitApproval(convo.id, "ap-1");
    const created = await acquireMatchJobExecution(prisma, {
      userId,
      conversationId: convo.id,
      turnKey: "u1",
      inputHash: hashCanonical({ resumeTitle: null }),
    });
    await prisma.agentToolExecution.update({
      where: { id: created.execution.id },
      data: {
        status: "COMPLETED",
        matchAnalysisId: analysis.id,
        completedAt: new Date(),
      },
    });
    await cancelConversationRequest(userId, convo.id, request1.requestId, prisma);

    const request2 = await appendProposalAndAdmit(convo.id, "a2", "call-2", "ap-2");
    const rebuilt = (await execute(
      buildTool({ request: request2, pageJobId: opportunity.id }),
      {},
      "call-2",
    )) as { status: string; analysisId: string; verdict: string; reasons: string };
    expect(rebuilt.status).toBe("ok");
    expect(rebuilt.analysisId).toBe(analysis.id);
    expect(rebuilt.verdict).toBe("BORDERLINE");
    expect(rebuilt.reasons).toBe("Recovered reasons.");
    expect(structuredSpy).not.toHaveBeenCalled();
    await cancelConversationRequest(userId, convo.id, request2.requestId, prisma);
  });

  it("records a failed outcome and replays it verbatim — no AI re-run", async () => {
    const { opportunity } = await setupMatchable();
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);
    const fetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify({ ok: false, code: "INFERENCE_FAILED" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const request1 = await admitApproval(convo.id, "ap-1");
    const first = await execute(
      buildTool({ request: request1, pageJobId: opportunity.id, fetchImpl }),
      {},
      "call-1",
    );
    expect(first).toMatchObject({ status: "failed", code: "AI_EXECUTION_FAILED" });
    expect(await prisma.matchAnalysis.count()).toBe(0);
    await cancelConversationRequest(userId, convo.id, request1.requestId, prisma);

    const execution = await prisma.agentToolExecution.findFirstOrThrow({
      where: { conversationId: convo.id },
    });
    expect(execution.status).toBe("FAILED");
    expect(execution.failureCode).toBe("AI_EXECUTION_FAILED");

    const request2 = await appendProposalAndAdmit(convo.id, "a2", "call-2", "ap-2");
    const second = await execute(
      buildTool({ request: request2, pageJobId: opportunity.id }),
      {},
      "call-2",
    );
    expect(second).toEqual(first);
    expect(structuredSpy).toHaveBeenCalledTimes(1);
    await cancelConversationRequest(userId, convo.id, request2.requestId, prisma);
  });

  it("rejects a same-turn re-proposal with different input as a turn conflict", async () => {
    const { opportunity } = await setupMatchable();
    const convo = await seedConversation([
      userMessage("u1"),
      proposalMessage("a1", "call-1", "ap-1", {}),
    ]);
    await runToCompletion(convo, opportunity.id);

    const request2 = await appendProposalAndAdmit(convo.id, "a2", "call-2", "ap-2", {
      resumeTitle: "别的简历",
    });
    await expect(
      execute(
        buildTool({ request: request2, pageJobId: opportunity.id }),
        { resumeTitle: "别的简历" },
        "call-2",
      ),
    ).rejects.toMatchObject({ code: "CONVERSATION_TURN_CONFLICT" });
    expect(request2.failure?.code).toBe("CONVERSATION_TURN_CONFLICT");
    expect(await prisma.matchAnalysis.count()).toBe(1);
    await cancelConversationRequest(userId, convo.id, request2.requestId, prisma);
  });
});

describe("acquireMatchJobExecution — reservation invariants", () => {
  it("serializes concurrent acquires onto one execution row", async () => {
    const convo = await seedConversation([userMessage("u1")]);
    const inputHash = "same-input";
    const [a, b] = await Promise.all([
      acquireMatchJobExecution(prisma, {
        userId,
        conversationId: convo.id,
        turnKey: "u1",
        inputHash,
      }),
      acquireMatchJobExecution(prisma, {
        userId,
        conversationId: convo.id,
        turnKey: "u1",
        inputHash,
      }),
    ]);
    expect(await prisma.agentToolExecution.count()).toBe(1);
    const states = [a.state, b.state].sort();
    // One caller creates; the other sees the winner's PENDING row.
    expect(states).toEqual(["fresh", "resume"]);
    const winnerKey =
      a.state === "fresh" ? a.execution.operationKey : b.execution.operationKey;
    for (const result of [a, b]) {
      expect(result.execution.operationKey).toBe(winnerKey);
    }
  });

  it("sweeps a superseded turn's PENDING row to ABORTED on the next acquire", async () => {
    const convo = await seedConversation([userMessage("u1")]);
    const dead = await acquireMatchJobExecution(prisma, {
      userId,
      conversationId: convo.id,
      turnKey: "u1",
      inputHash: "a",
    });
    const live = await acquireMatchJobExecution(prisma, {
      userId,
      conversationId: convo.id,
      turnKey: "u2",
      inputHash: "a",
    });
    expect(live.state).toBe("fresh");
    const swept = await prisma.agentToolExecution.findUniqueOrThrow({
      where: { id: dead.execution.id },
    });
    expect(swept.status).toBe("ABORTED");
    // An ABORTED row can never be resumed.
    const reacquire = await acquireMatchJobExecution(prisma, {
      userId,
      conversationId: convo.id,
      turnKey: "u1",
      inputHash: "a",
    });
    expect(reacquire.state).toBe("replay");
  });
});

describe("analysis-write atomicity", () => {
  it("a second run against the same execution writes no second analysis", async () => {
    const { opportunity } = await setupMatchable();
    const convo = await seedConversation([userMessage("u1")]);
    const execution = await acquireMatchJobExecution(prisma, {
      userId,
      conversationId: convo.id,
      turnKey: "u1",
      inputHash: "x",
    });
    const deps = {
      execUrl: "http://127.0.0.1:9999",
      internalToken: "t",
      fetchImpl: (async () => okResponse(VERDICT)) as typeof fetch,
      dbClient: prisma as never,
    };
    const first = await runFastScreening(
      prisma,
      userId,
      { jobOpportunityId: opportunity.id, source: { kind: "career-profile" } },
      deps,
      FEATURE_ON,
      { executionKey: execution.execution.operationKey },
    );
    expect(first.kind).toBe("ok");
    await expect(
      runFastScreening(
        prisma,
        userId,
        { jobOpportunityId: opportunity.id, source: { kind: "career-profile" } },
        deps,
        FEATURE_ON,
        { executionKey: execution.execution.operationKey },
      ),
    ).rejects.toMatchObject({ code: "TOOL_EXECUTION_CONFLICT" });
    expect(await prisma.matchAnalysis.count()).toBe(1);
    const settled = await prisma.agentToolExecution.findUniqueOrThrow({
      where: { operationKey: execution.execution.operationKey },
    });
    expect(settled.status).toBe("COMPLETED");
    expect(settled.matchAnalysisId).toBeTruthy();
  });
});

describe("backup classification", () => {
  it("keeps AgentToolExecution out of the backup payload", () => {
    expect(backupCoverageStatus("AgentToolExecution")).toBe(
      BACKUP_COVERAGE_STATUS.INTENTIONALLY_EXCLUDED,
    );
    expect(BackupDataSchema.shape).not.toHaveProperty("AgentToolExecution");
  });
});

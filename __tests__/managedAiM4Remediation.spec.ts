// @vitest-environment node
/**
 * M4 Remediation 01 — durable identity regressions for the four formal P1s.
 *
 *   P1-01 Resume canonical import: durable attempt row exists BEFORE the
 *         first Hosted call; a post-crash retry of the same request id
 *         replays locally with zero new gateway calls; approval transfers
 *         the exact persisted lock to ResumeVariantVersion.
 *   P1-02 Manual Match: the operation identity freezes the resume+JD
 *         input fingerprints — same inputs replay, changed inputs mint a
 *         new invocation instead of returning the stale score.
 *   P1-03 Dialogue summary: scheduler failureCount is backoff state only;
 *         UNKNOWN/network retries re-enter with the identical
 *         operationId + attemptIndex.
 *   P1-04 Dialogue nested: nested invocationKey derives from the durable
 *         tool call id — a new adapter instance (process restart) rederives
 *         the same key, distinct tool calls get distinct keys.
 *
 * Runs against the real in-memory HostedManagedService + real prisma test
 * DB, so replay semantics are exercised end to end.
 */
import { createHash, randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { UIMessage } from "ai";
import { HostedStore } from "../services/managed-ai/src/store";
import { ModelCatalog } from "../services/managed-ai/src/catalog";
import {
  ManagedGatewayRuntime,
  VERIFIED_GATEWAY_CAPABILITIES,
} from "../services/managed-ai/src/gateway";
import { HostedManagedService } from "../services/managed-ai/src/service";
import { PlanAuthority } from "../services/managed-ai/src/plan";
import { HostedManagedClient } from "@/lib/ai/managed-client";
import { assignManagedBusinessSource } from "@/lib/ai/assignments";
import { bootstrapManagedAiForUser } from "@/lib/ai/managed-bootstrap";
import { bindManagedBusinessLock } from "@/lib/ai/business-execution-lock";
import { AIBusinessError } from "@/lib/ai/connections";
import type { ManagedAiProvenanceV1 } from "@/lib/ai/managed-provenance";
import {
  executeDurableResumeImport,
  markResumeImportConfirmed,
} from "@/lib/career/resumeImportAttempt";
import { persistResumeImport } from "@/lib/career/canonicalResumeImport";
import { validateResumeImport } from "@/lib/career/resumeImportContract";
import { canonicalImportJsonSchema } from "@/lib/ai/resume-import/canonicalSchema";
import { importFixture, importRawText } from "./helpers/canonicalImportFixture";
import { activateFreshAbNative } from "@/lib/career/freshActivation";
import { createAccountRuntimeLanguageModel } from "@/lib/agent/accountLanguageModel";
import { condenseCareerDialogueSummary } from "@/lib/agent/conversationSummaryScheduler";
import type { SummaryRepository } from "@/lib/agent/conversationSummaryStore";
import type { AIBusinessErrorCode } from "@/lib/ai/connections";
import { analyzeDiscoveredJob } from "@/actions/automation/analyze";

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

const CATALOG = {
  revision: "catalog-1",
  managedAiEnabled: true,
  defaultModelKey: "vocatrya-fast",
  models: [
    {
      modelKey: "vocatrya-fast",
      displayName: "Fast",
      upstreamModelId: "vendor-v1",
      enabled: true,
      planRequirement: null,
      sortOrder: 0,
      mappingRevision: "mapping-1",
      maxInputTokens: 32000,
      maxOutputTokens: 4096,
      capabilities: {
        text: true,
        streaming: true,
        structuredOutput: true,
        tools: false,
      },
    },
  ],
};

function hosted(upstream?: typeof fetch) {
  let upstreamCalls = 0;
  const countUpstream = (impl?: typeof fetch): typeof fetch =>
    async (url, init) => {
      upstreamCalls += 1;
      return (impl ??
        (async () =>
          Response.json({
            model: "vendor-v1",
            choices: [
              {
                message: { content: "SCORES: match=88 recommendation=strong" },
                finish_reason: "stop",
              },
            ],
          })))(url, init);
    };
  const store = new HostedStore(":memory:");
  const token = store.issueSession("hosted-a", Date.now() + 60000);
  store.setSubscription("hosted-a", {
    planKey: "starter",
    status: "ACTIVE",
    periodStart: Date.now() - 1000,
    periodEnd: Date.now() + 60000,
  });
  const plans = new PlanAuthority({
    revision: "plans-1",
    plans: [
      {
        planKey: "starter",
        managedAiEnabled: true,
        allowedModels: ["vocatrya-fast"],
        periodQuotaUnits: 100,
        modelUsageUnits: { "vocatrya-fast": 1 },
      },
    ],
  });
  const service = new HostedManagedService(
    store,
    new ModelCatalog(CATALOG, VERIFIED_GATEWAY_CAPABILITIES),
    plans,
    new ManagedGatewayRuntime(
      { baseUrl: "https://gateway.example/v1", apiKey: "SYNTHETIC" },
      countUpstream(upstream),
    ),
  );
  const requests: Request[] = [];
  const client = new HostedManagedClient(
    { tokenForLocalUser: async (id) => (id === userId ? token : null) },
    "https://hosted.example",
    async (url, init) => {
      const request = new Request(String(url), init);
      requests.push(request.clone());
      return service.handle(request);
    },
  );
  return { client, store, requests, upstreamCalls: () => upstreamCalls };
}

const callsTo = (requests: Request[], path: string) =>
  requests.filter((r) => new URL(r.url).pathname === path);

// --- analyzeDiscoveredJob seam mocks -------------------------------------
// The action resolves the REAL assignment and the REAL managed seam — only
// the session, non-managed provider fallbacks and the input fetchers are
// stubbed. `executeAIConnectionText` stays real but is routed at the
// synthetic Hosted service, so replay semantics are genuine.
const seam = vi.hoisted(() => ({
  userId: "",
  client: null as HostedManagedClient | null,
  resumeText: "resume-v1",
  jobText: "jd-v1",
  scores: [88, 91, 77],
}));

vi.mock("@/actions/shared", () => ({
  requireUser: async () => ({ id: seam.userId }),
}));
vi.mock("@/lib/career/writeGuard", () => ({
  assertLegacyCareerWriteAllowed: async () => {},
}));
vi.mock("@/actions/profile.actions", () => ({
  getResumeById: async () => ({ data: { title: "Resume" } }),
}));
vi.mock("@/actions/job.actions", () => ({
  getJobDetails: async () => ({ job: {} }),
}));
vi.mock("@/lib/automation-logger", () => ({
  automationLogger: { isRunning: () => false },
}));
vi.mock("@/lib/ai", () => ({
  getModel: vi.fn(async () => ({})),
  parseJobMatch: () => ({
    scores: { matchScore: seam.scores.shift() ?? 50, recommendation: "apply" },
    body: "analysis",
  }),
  JOB_MATCH_SYSTEM_PROMPT: "system",
  buildJobMatchPrompt: () => "prompt",
  preprocessResume: async () => ({
    success: true,
    data: { normalizedText: seam.resumeText },
  }),
  preprocessJob: async () => ({
    success: true,
    data: { normalizedText: seam.jobText },
  }),
}));
vi.mock("@/lib/ai/execution", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/ai/execution")>();
  return {
    ...actual,
    executeAIConnectionText: (
      input: Parameters<typeof actual.executeAIConnectionText>[0],
      deps?: Parameters<typeof actual.executeAIConnectionText>[1],
    ) =>
      actual.executeAIConnectionText(input, {
        managedClient: seam.client ?? undefined,
        ...deps,
      }),
  };
});

beforeAll(async () => {
  const helpers = await import("./helpers/backupTestDb");
  userId = await helpers.seedAccount(prisma, "m4-remediation@example.com");
  seam.userId = userId;
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function clearAssignments() {
  await prisma.aIBusinessAssignment.deleteMany({ where: { userId } });
}

// ---------------------------------------------------------------- P1-01 --
describe("P1-01 resume canonical import durable identity", () => {
  const importJsonUpstream = async () =>
    Response.json({
      model: "vendor-v1",
      choices: [
        {
          message: { content: JSON.stringify(importFixture) },
          finish_reason: "stop",
        },
      ],
    });
  const requestSha = createHash("sha256").update(importRawText).digest("hex");
  const execution = {
    prompt: "import",
    schema: canonicalImportJsonSchema() as Record<string, unknown>,
    schemaName: "canonical_resume_import",
  };

  it("persists the durable attempt before invocation and replays a post-crash retry with zero new gateway calls", async () => {
    const { client, store, requests } = hosted(importJsonUpstream);
    try {
      await clearAssignments();
      await assignManagedBusinessSource(
        { userId, purpose: "RESUME", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      const requestId = `imp-${randomUUID().slice(0, 12)}`;
      const call = () =>
        executeDurableResumeImport(
          prisma,
          { userId, requestId, requestSha, execution },
          { managedClient: client },
        );

      const first = await call();
      expect(first).toMatchObject({ kind: "ok", replayed: false });
      const modelCalls = () => callsTo(requests, "/v1/structured");
      expect(modelCalls()).toHaveLength(1);
      const invocation = await modelCalls()[0].json();
      expect(invocation.operationId).toBe(
        `resume-import:${requestId}:0:import`,
      );

      // Lock + provenance landed on the durable row before the result.
      const attempt = await prisma.resumeImportAttempt.findUniqueOrThrow({
        where: { id: requestId },
      });
      expect(attempt).toMatchObject({ state: "EXECUTED", executionSeq: 0 });
      expect(attempt.resolvedConnectionId).toBeTruthy();
      expect(attempt.resolvedModel).toBe("vocatrya-fast");
      expect(attempt.managedAiProvenance).toBeTruthy();

      // Simulated crash: response never reached the client — retry the
      // same logical import. Zero new model calls, same durable identity.
      const second = await call();
      expect(second).toMatchObject({ kind: "ok", replayed: true });
      if (first.kind === "ok" && second.kind === "ok") {
        expect(second.attemptId).toBe(first.attemptId);
        expect(second.managedAiProvenance).toBe(first.managedAiProvenance);
      }
      expect(modelCalls()).toHaveLength(1);
      // No second binding either — the retry never re-resolves.
      expect(callsTo(requests, "/v1/bindings")).toHaveLength(1);
    } finally {
      store.close();
    }
  });

  it("mints a new operation for a different request id and refuses a reused id with different content", async () => {
    const { client, store, requests } = hosted(importJsonUpstream);
    try {
      const first = await executeDurableResumeImport(
        prisma,
        {
          userId,
          requestId: "imp-dup-test",
          requestSha,
          execution,
        },
        { managedClient: client },
      );
      expect(first.kind).toBe("ok");
      await expect(
        executeDurableResumeImport(
          prisma,
          {
            userId,
            requestId: "imp-dup-test",
            requestSha: createHash("sha256").update("other").digest("hex"),
            execution,
          },
          { managedClient: client },
        ),
      ).rejects.toMatchObject({ code: "INVOCATION_CONFLICT" });
      const again = await executeDurableResumeImport(
        prisma,
        {
          userId,
          requestId: "imp-dup-test-2",
          requestSha,
          execution,
        },
        { managedClient: client },
      );
      expect(again).toMatchObject({ kind: "ok", replayed: false });
      const bodies = await Promise.all(
        callsTo(requests, "/v1/structured").map((r) => r.json()),
      );
      expect(bodies.map((b) => b.operationId)).toEqual([
        "resume-import:imp-dup-test:0:import",
        "resume-import:imp-dup-test-2:0:import",
      ]);
    } finally {
      store.close();
    }
  });

  it("transfers the exact persisted lock to ResumeVariantVersion at confirm", async () => {
    const { client, store } = hosted(importJsonUpstream);
    try {
      await activateFreshAbNative(prisma);
      const requestId = `imp-${randomUUID().slice(0, 12)}`;
      const result = await executeDurableResumeImport(
        prisma,
        { userId, requestId, requestSha, execution },
        { managedClient: client },
      );
      expect(result.kind).toBe("ok");
      if (result.kind !== "ok") return;
      const attempt = await prisma.resumeImportAttempt.findUniqueOrThrow({
        where: { id: requestId },
      });
      // The approval flow copies the attempt's lock verbatim — the exact
      // fields the route packs into the signed approval token.
      const parsed = validateResumeImport(result.value, importRawText);
      const variant = await persistResumeImport(
        prisma,
        userId,
        {
          requestId: result.attemptId,
          name: "Imported",
          rawText: importRawText,
          parsed,
          resolvedConnectionId: result.resolvedConnectionId,
          resolvedModel: result.resolvedModel,
          managedAiProvenance: result.managedAiProvenance,
        },
        { NODE_ENV: "test" },
      );
      await markResumeImportConfirmed(prisma, userId, requestId);
      const version = await prisma.resumeVariantVersion.findFirstOrThrow({
        where: { resumeVariantId: variant.id },
      });
      // durable import lock == final ResumeVariantVersion lock
      expect(version.managedAiProvenance).toBe(attempt.managedAiProvenance);
      expect(version.resolvedConnectionId).toBe(
        attempt.resolvedConnectionId,
      );
      expect(version.resolvedModel).toBe(attempt.resolvedModel);
      expect(
        (await prisma.resumeImportAttempt.findUniqueOrThrow({
          where: { id: requestId },
        })).state,
      ).toBe("CONFIRMED");
    } finally {
      store.close();
    }
  });
});

// ---------------------------------------------------------------- P1-02 --
describe("P1-02 manual match input-version identity", () => {
  async function seedJob() {
    const profile = await prisma.profile.create({ data: { userId } });
    const resume = await prisma.resume.create({
      data: { profileId: profile.id, title: "R" },
    });
    const automation = await prisma.automation.create({
      data: {
        userId,
        name: "A",
        jobBoard: "greenhouse",
        keywords: "",
        location: "",
        resumeId: resume.id,
        scheduleHour: 8,
      },
    });
    const status = await prisma.jobStatus.create({
      data: { label: "Saved", value: `saved-${randomUUID().slice(0, 8)}` },
    });
    const title = await prisma.jobTitle.create({
      data: { label: "Engineer", value: randomUUID().slice(0, 8), createdBy: userId },
    });
    const company = await prisma.company.create({
      data: { label: "Acme", value: randomUUID().slice(0, 8), createdBy: userId },
    });
    return prisma.job.create({
      data: {
        userId,
        automationId: automation.id,
        description: "Build systems",
        jobType: "fulltime",
        createdAt: new Date(),
        statusId: status.id,
        jobTitleId: title.id,
        companyId: company.id,
      },
    });
  }

  it("replays the same inputs, and changed resume or JD mints a new analysis", async () => {
    const { client, store, requests, upstreamCalls } = hosted();
    try {
      await clearAssignments();
      await assignManagedBusinessSource(
        { userId, purpose: "MATCH_ANALYSIS", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      seam.client = client;
      seam.scores = [88, 91, 77];
      seam.resumeText = "resume-v1";
      seam.jobText = "jd-v1";
      const job = await seedJob();
      const textCalls = () => callsTo(requests, "/v1/text");
      const operationIds = async () =>
        (await Promise.all(textCalls().map((r) => r.json()))).map(
          (b) => b.operationId,
        );

      // Same inputs — Hosted replays the settled invocation; the score
      // comes from the per-input ledger, not a stale headline. The replay
      // round-trips the ledger but never invokes the model again.
      expect(await analyzeDiscoveredJob(job.id)).toEqual({
        success: true,
        matchScore: 88,
      });
      expect(await analyzeDiscoveredJob(job.id)).toEqual({
        success: true,
        matchScore: 88,
      });
      expect(upstreamCalls()).toBe(1);

      // Changed resume → different fingerprint → new billable analysis.
      seam.resumeText = "resume-v2";
      expect(await analyzeDiscoveredJob(job.id)).toEqual({
        success: true,
        matchScore: 91,
      });
      expect(upstreamCalls()).toBe(2);

      // Changed JD → another new analysis; prior inputs stay replayable.
      seam.jobText = "jd-v2";
      expect(await analyzeDiscoveredJob(job.id)).toEqual({
        success: true,
        matchScore: 77,
      });
      expect(upstreamCalls()).toBe(3);

      const ops = await operationIds();
      expect(new Set(ops).size).toBe(3);
      for (const op of ops) {
        expect(op).toMatch(new RegExp(`^match-analysis:${job.id}:`));
      }
      // The retained ledger carries all three per-input scores.
      const persisted = JSON.parse(
        (await prisma.job.findUniqueOrThrow({ where: { id: job.id } }))
          .matchData ?? "{}",
      ) as { analyses?: Record<string, { matchScore: number }> };
      expect(
        Object.values(persisted.analyses ?? {}).map((a) => a.matchScore)
          .sort(),
      ).toEqual([77, 88, 91]);
      await prisma.job.delete({ where: { id: job.id } });
    } finally {
      seam.client = null;
      store.close();
    }
  });
});

// ---------------------------------------------------------------- P1-03 --
describe("P1-03 dialogue summary retry identity", () => {
  const provenance: ManagedAiProvenanceV1 = {
    schemaVersion: 1,
    managedBindingId: "binding-1",
    requestedModelKey: "vocatrya-fast",
    upstreamModelId: "vendor-v1",
    mappingRevision: "m1",
    adapterContractRevision: "a1",
  };
  const conversationId = "conv-summary-retry";

  function userMsg(i: number) {
    return {
      id: `u${i}`,
      role: "user",
      parts: [{ type: "text", text: `用户输入 ${i} 需要覆盖足够多的内容以超出窗口` }],
    } as UIMessage;
  }
  function assistantMsg(i: number) {
    return {
      id: `a${i}`,
      role: "assistant",
      parts: [{ type: "text", text: `回复 ${i} 详细展开足够多的文本以占用上下文窗口预算` }],
    } as UIMessage;
  }
  const messages = Array.from({ length: 40 }, (_, i) => [
    userMsg(i),
    assistantMsg(i),
  ]).flat();

  function managedRepo(): SummaryRepository & {
    failureCount: () => number;
  } {
    let failures = 0;
    const snapshot = {
      messages,
      summary: null,
      resolvedConnectionId: "conn-managed",
      resolvedModel: "vocatrya-fast",
      managed: {
        connectionId: "conn-managed",
        model: "vocatrya-fast",
        provenance,
      },
    };
    return {
      failureCount: () => failures,
      load: async () => ({ ...snapshot }),
      commit: async () => "committed",
      recordFailure: async () => ++failures,
    };
  }

  it.each([
    "INVOCATION_STATUS_UNKNOWN",
    "GATEWAY_NETWORK",
  ] satisfies readonly string[])(
    "keeps the identical invocation identity across %s retries",
    async (code) => {
      const repo = managedRepo();
      const seen: Array<{
        operationId?: string;
        attemptIndex?: number;
        managedResource?: { resourceKey: string };
      }> = [];
      const executeText = async (input: {
        operationId?: string;
        attemptIndex?: number;
        managedResource?: { resourceKey: string };
      }) => {
        seen.push(input);
        throw new AIBusinessError(
          code as AIBusinessErrorCode,
          `synthetic ${code}`,
        );
      };
      let now = 1_700_000_000_000;
      const deps = { now: () => now, repository: repo, executeText };
      const input = { userId, conversationId };

      const first = await condenseCareerDialogueSummary(input, deps);
      expect(first.status).toBe("failed");
      expect(first.reason).toBe(code);
      expect(repo.failureCount()).toBe(1);

      // Backoff elapsed — same coverage → the scheduler retries.
      now += 60 * 60 * 1000;
      const second = await condenseCareerDialogueSummary(input, deps);
      expect(second.status).toBe("failed");
      expect(repo.failureCount()).toBe(2);

      // failureCount moved 0 → 1 → 2 while the invocation identity did not.
      expect(seen).toHaveLength(2);
      expect(seen[0].operationId).toBe(seen[1].operationId);
      expect(seen[0].attemptIndex).toBe(0);
      expect(seen[1].attemptIndex).toBe(0);
      expect(seen[0].operationId).toMatch(
        new RegExp(`^dialogue:${conversationId}:summary:`),
      );
      expect(seen[0].managedResource?.resourceKey).toBe(
        `conversation:${conversationId}`,
      );
    },
  );
});

// ---------------------------------------------------------------- P1-04 --
describe("P1-04 dialogue nested durable identity", () => {
  const prompt = [
    {
      role: "user" as const,
      content: [{ type: "text" as const, text: "draft a bullet" }],
    },
  ];
  const call = (toolCallId?: string) =>
    ({
      prompt,
      providerOptions: toolCallId
        ? { vocatrya: { toolCallId } }
        : undefined,
    }) as never;

  it("derives the nested invocationKey from the durable tool call id and replays after restart", async () => {
    const { client, store, requests, upstreamCalls } = hosted();
    try {
      const { connectionId } = await bootstrapManagedAiForUser(
        userId,
        client,
        prisma,
      );
      const resourceKey = `conversation:conv-nested`;
      const bound = await bindManagedBusinessLock({
        userId,
        connectionId,
        model: "vocatrya-fast",
        business: "CAREER_DIALOGUE",
        resourceKey,
        client,
      });
      const operationId = "dialogue:conv-nested:request-1";
      const make = () =>
        createAccountRuntimeLanguageModel({
          userId,
          connectionId,
          modelName: "vocatrya-fast",
          managed: {
            provenance: bound.provenance,
            resourceKey,
            operationId,
          },
          deps: { managedClient: client, dbClient: prisma },
        }) as unknown as LanguageModelV3;
      const model = make();
      const textCalls = () => callsTo(requests, "/v1/text");

      // First nested call for durable tool call T1.
      await model.doGenerate(call("tc-1"));
      expect(upstreamCalls()).toBe(1);
      expect(await textCalls()[0].json()).toMatchObject({
        operationId,
        invocationKey: `${operationId}:nested:tc-1:0`,
        attemptIndex: 0,
      });

      // Same tool call retried — and the same tool call resumed through a
      // NEW adapter instance (process restart) — both replay as
      // INVOCATION_REPLAYED instead of charging a second nested call.
      await expect(model.doGenerate(call("tc-1"))).rejects.toMatchObject({
        code: "INVOCATION_REPLAYED",
      });
      await expect(make().doGenerate(call("tc-1"))).rejects.toMatchObject({
        code: "INVOCATION_REPLAYED",
      });
      expect(upstreamCalls()).toBe(1); // ledger round-trips only

      // A genuinely different tool call is a different invocation.
      await model.doGenerate(call("tc-2"));
      expect(upstreamCalls()).toBe(2);
      const lastBody = await textCalls().at(-1)!.json();
      expect(lastBody.invocationKey).toBe(`${operationId}:nested:tc-2:0`);

      // No durable tool identity → refused before any gateway call.
      const before = textCalls().length;
      await expect(model.doGenerate(call())).rejects.toMatchObject({
        code: "INVOCATION_ID_REQUIRED",
      });
      expect(textCalls()).toHaveLength(before);
    } finally {
      store.close();
    }
  });

  it("carries the same durable identity on the streaming path", async () => {
    const sse = async () =>
      new Response(
        `data: ${JSON.stringify({
          model: "vendor-v1",
          choices: [
            { delta: { content: "ok" }, finish_reason: "stop" },
          ],
        })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    const { client, store, requests } = hosted(sse);
    try {
      const { connectionId } = await bootstrapManagedAiForUser(
        userId,
        client,
        prisma,
      );
      const bound = await bindManagedBusinessLock({
        userId,
        connectionId,
        model: "vocatrya-fast",
        business: "CAREER_DIALOGUE",
        resourceKey: "conversation:conv-nested-stream",
        client,
      });
      const model = createAccountRuntimeLanguageModel({
        userId,
        connectionId,
        modelName: "vocatrya-fast",
        managed: {
          provenance: bound.provenance,
          resourceKey: "conversation:conv-nested-stream",
          operationId: "dialogue:conv-nested-stream:request-1",
        },
        deps: { managedClient: client, dbClient: prisma },
      }) as unknown as LanguageModelV3;
      const { stream } = await model.doStream(call("tc-stream"));
      const reader = stream.getReader();
      while (!(await reader.read()).done) {
        // drain
      }
      const invocationRequests = requests.filter((r) =>
        ["/v1/stream", "/v1/text"].includes(new URL(r.url).pathname),
      );
      const bodies = await Promise.all(
        invocationRequests.map((r) => r.json()),
      );
      expect(
        bodies.some(
          (b) =>
            b.invocationKey ===
            "dialogue:conv-nested-stream:request-1:nested:tc-stream:0",
        ),
      ).toBe(true);
    } finally {
      store.close();
    }
  });
});

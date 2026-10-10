// @vitest-environment node
/**
 * M4 — business assignment → resource lock → Hosted execution integration.
 *
 * Synthetic Hosted backend (real in-memory HostedManagedService, real
 * prisma test DB, real client protocol). Covers the acceptance chain:
 *
 *   business source selection → resource creation → permanent
 *   source/model/binding lock → every real model call carries a stable
 *   business identity → Hosted meters it → retries/reopen/assignment
 *   changes never rewrite history.
 */
import { randomUUID, createHash } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { HostedStore } from "../services/managed-ai/src/store";
import { ModelCatalog } from "../services/managed-ai/src/catalog";
import {
  ManagedGatewayRuntime,
  VERIFIED_GATEWAY_CAPABILITIES,
} from "../services/managed-ai/src/gateway";
import { HostedManagedService } from "../services/managed-ai/src/service";
import { PlanAuthority } from "../services/managed-ai/src/plan";
import { HostedManagedClient } from "@/lib/ai/managed-client";
import {
  assignManagedBusinessSource,
  resolveBusinessAIConfig,
  setBusinessAssignment,
} from "@/lib/ai/assignments";
import { bootstrapManagedAiForUser } from "@/lib/ai/managed-bootstrap";
import { executeAIConnectionText } from "@/lib/ai/execution";
import { executeStructuredForAssignment } from "@/lib/ai/structured-execution";
import {
  managedLockFromRow,
  decodeManagedAiProvenance,
} from "@/lib/ai/managed-provenance";
import {
  interviewCreationPlanRef,
  resolveInterviewAiRuntime,
} from "@/lib/interview/interviewRuntimePlan";
import { getInterviewReadiness } from "@/lib/interview/readiness";
import {
  sessionAiLockFromRow,
} from "@/lib/interview/sessionAiLock";
import { VocatryaInterviewModelAdapter } from "@/lib/interview/vocatryaHostPorts";
import { runCareerDialogueTurn } from "@/lib/agent/careerDialogueTurn";
import {
  resolveAutomationMatchRuntime,
  previewAutomationMatchRuntime,
} from "@/lib/scraper/automation-run/matchRuntime";
import { matchJobToResume } from "@/lib/scraper/automation-run/match";
import { createChatConversationRecord } from "@/lib/agent/chatConversationStore";
import { chatLockFromRow } from "@/lib/agent/chatConversationLock";
import type { ResumeWithSections } from "@/lib/scraper/automation-run/types";
import type { JobDetails } from "@/lib/scraper/types";

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

const MATCH_REPLY =
  "SCORES: match=88 recommendation=strong\n\nStrong alignment.";

function hosted(upstream?: typeof fetch, catalog = CATALOG) {
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
    new ModelCatalog(catalog, VERIFIED_GATEWAY_CAPABILITIES),
    plans,
    new ManagedGatewayRuntime(
      { baseUrl: "https://gateway.example/v1", apiKey: "SYNTHETIC" },
      upstream ??
        (async () =>
          Response.json({
            model: "vendor-v1",
            choices: [
              { message: { content: MATCH_REPLY }, finish_reason: "stop" },
            ],
          })),
    ),
  );
  const requests: Request[] = [];
  const client = new HostedManagedClient(
    {
      tokenForLocalUser: async (id) => (id === userId ? token : null),
    },
    "https://hosted.example",
    async (url, init) => {
      const request = new Request(String(url), init);
      requests.push(request.clone());
      return service.handle(request);
    },
  );
  return { client, store, requests };
}

const resumeStub = {
  id: "resume-1",
  title: "Engineer",
  ContactInfo: null,
  ResumeSections: [],
} as unknown as ResumeWithSections;

/** A real Automation row — AutomationRun.automationId is an FK. */
async function makeAutomation() {
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
  return automation.id;
}

function job(url: string): JobDetails {
  return {
    title: "Engineer",
    company: "Acme",
    location: "Remote",
    description: "Build systems",
    url,
  };
}

beforeAll(async () => {
  const helpers = await import("./helpers/backupTestDb");
  userId = await helpers.seedAccount(prisma, "m4-integration@example.com");
});
afterAll(async () => {
  await prisma.$disconnect();
});

async function clearAssignments() {
  await prisma.aIBusinessAssignment.deleteMany({ where: { userId } });
}

describe("managed bootstrap + assignment write path", () => {
  it("provisions the managed connection and pins a catalog model", async () => {
    const { client, store } = hosted();
    try {
      await clearAssignments();
      await prisma.aIConnection.deleteMany({
        where: { userId, authType: "MANAGED" },
      });
      const boot = await bootstrapManagedAiForUser(userId, client, prisma);
      const connection = await prisma.aIConnection.findUniqueOrThrow({
        where: { id: boot.connectionId },
      });
      expect(connection).toMatchObject({
        provider: "VOCATRYA",
        backendKind: "MANAGED_GATEWAY",
        authType: "MANAGED",
        status: "CONNECTED",
        credentialRef: null,
        runtimeProfileRef: null,
        accountIdentity: null,
      });
      const summary = await assignManagedBusinessSource(
        { userId, purpose: "MATCH_ANALYSIS", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      expect(summary).toMatchObject({ purpose: "MATCH_ANALYSIS" });
      const resolution = await resolveBusinessAIConfig({
        userId,
        purpose: "MATCH_ANALYSIS",
      });
      expect(resolution).toMatchObject({
        status: "RESOLVED",
        connectionId: connection.id,
        model: "vocatrya-fast",
        provider: "VOCATRYA",
        backendKind: "MANAGED_GATEWAY",
        source: "BUSINESS_ASSIGNMENT",
      });
      await expect(
        assignManagedBusinessSource(
          { userId, purpose: "INTERVIEW", modelKey: "no-such-model" },
          { managedClient: client, dbClient: prisma },
        ),
      ).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
      // A catalog model without text capability can serve no business
      // purpose — the write path refuses it for every purpose kind.
      const noText = hosted(undefined, {
        ...CATALOG,
        models: CATALOG.models.map((model) => ({
          ...model,
          capabilities: { ...model.capabilities, text: false },
        })),
      });
      try {
        await expect(
          assignManagedBusinessSource(
            { userId, purpose: "RESUME", modelKey: "vocatrya-fast" },
            { managedClient: noText.client, dbClient: prisma },
          ),
        ).rejects.toMatchObject({ code: "CAPABILITY_UNSUPPORTED" });
      } finally {
        noText.store.close();
      }
    } finally {
      store.close();
    }
  });
});

describe("AutomationRun creation-time managed binding", () => {
  it("binds the run resource once and persists provenance atomically", async () => {
    const { client, store, requests } = hosted();
    try {
      await assignManagedBusinessSource(
        { userId, purpose: "MATCH_ANALYSIS", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      const automationId = await makeAutomation();
      const runId = randomUUID();
      const resolved = await resolveAutomationMatchRuntime(userId, {
        resourceKey: `automation-run:${runId}`,
        managedClient: client,
      });
      expect(resolved.plan.kind).toBe("managed");
      const run = await prisma.automationRun.create({
        data: {
          id: runId,
          automationId,
          status: "running",
          ...resolved.lock,
        },
      });
      const lock = managedLockFromRow(run);
      expect(lock).toMatchObject({
        kind: "managed",
        connectionId: resolved.plan.kind === "managed" ? resolved.plan.connectionId : undefined,
        model: "vocatrya-fast",
      });
      const provenance = decodeManagedAiProvenance(run.managedAiProvenance);
      expect(provenance).toMatchObject({
        schemaVersion: 1,
        requestedModelKey: "vocatrya-fast",
        upstreamModelId: "vendor-v1",
        mappingRevision: "mapping-1",
      });
      const bindingCalls = requests.filter(
        (r) => new URL(r.url).pathname === "/v1/bindings",
      );
      expect(bindingCalls).toHaveLength(1);
      // Same resourceKey re-binds to the identical binding — idempotent.
      const again = await resolveAutomationMatchRuntime(userId, {
        resourceKey: `automation-run:${runId}`,
        managedClient: client,
      });
      expect(again.plan.kind).toBe("managed");
      if (again.plan.kind === "managed" && resolved.plan.kind === "managed") {
        expect(again.plan.provenance.managedBindingId).toBe(
          resolved.plan.provenance.managedBindingId,
        );
      }
      await prisma.automationRun.delete({ where: { id: runId } });
    } finally {
      store.close();
    }
  });

  it("per-job match operations replay instead of double-charging", async () => {
    const { client, store, requests } = hosted();
    try {
      const automationId = await makeAutomation();
      const runId = randomUUID();
      const resolved = await resolveAutomationMatchRuntime(userId, {
        resourceKey: `automation-run:${runId}`,
        managedClient: client,
      });
      const plan = resolved.plan;
      expect(plan.kind).toBe("managed");

      const aiSettings = { provider: "ollama", model: "" } as never;
      const first = await matchJobToResume(
        job("https://boards.example/j/1"),
        resumeStub,
        "greenhouse",
        aiSettings,
        userId,
        undefined,
        plan,
        runId,
        { managedClient: client },
      );
      expect(first).toMatchObject({
        success: true,
        score: 88,
        provider: "VOCATRYA_MANAGED",
        model: "vocatrya-fast",
      });
      // Same run + same job → same operationId → typed replay, no second charge.
      const replay = await matchJobToResume(
        job("https://boards.example/j/1"),
        resumeStub,
        "greenhouse",
        aiSettings,
        userId,
        undefined,
        plan,
        runId,
        { managedClient: client },
      );
      expect(replay).toMatchObject({
        success: false,
        code: "INVOCATION_REPLAYED",
      });
      // A different job under the same run is a distinct operation.
      const second = await matchJobToResume(
        job("https://boards.example/j/2"),
        resumeStub,
        "greenhouse",
        aiSettings,
        userId,
        undefined,
        plan,
        runId,
        { managedClient: client },
      );
      expect(second.success).toBe(true);
      const invocations = await Promise.all(
        requests
          .filter((r) => new URL(r.url).pathname === "/v1/text")
          .map((r) => r.json()),
      );
      expect(invocations).toHaveLength(3); // job1 + replayed job1 + job2
      // The replayed call re-sends the SAME deterministic invocationKey —
      // that's what lets Hosted dedupe it instead of double-charging.
      const keys = invocations.map((i) => i.invocationKey);
      expect(new Set(keys).size).toBe(2);
      expect(keys[0]).toBe(keys[1]);
      const opIds = invocations.map((i) => i.operationId);
      const job1Key = createHash("sha256")
        .update("https://boards.example/j/1")
        .digest("hex")
        .slice(0, 20);
      expect(opIds[0]).toBe(`automation-match:${runId}:${job1Key}`);
      expect(opIds[1]).toBe(opIds[0]);
      // Assignment change after the run never rewrites the persisted lock.
      const account = await prisma.aIConnection.create({
        data: {
          userId,
          provider: "OPENAI",
          backendKind: "CODEX_RUNTIME",
          displayName: "acct",
          status: "CONNECTED",
          runtimeProfileRef: "rp_change",
        },
      });
      await setBusinessAssignment(
        { userId, purpose: "MATCH_ANALYSIS", connectionId: account.id, model: "m" },
        prisma,
      );
      const reloaded = managedLockFromRow(
        await prisma.automationRun.create({
          data: {
            id: `${runId}-hist`,
            automationId,
            status: "completed",
            ...resolved.lock,
          },
        }),
      );
      expect(reloaded).toMatchObject({
        kind: "managed",
        model: "vocatrya-fast",
      });
      // A NEW run re-resolves under the retargeted assignment — it is no
      // longer the old managed binding (account runtime profile is absent,
      // so the plan may surface as invalid; the point is re-resolution).
      const preview = await previewAutomationMatchRuntime(userId);
      expect(preview.plan).not.toMatchObject({ kind: "managed" });
      await prisma.automationRun.deleteMany({
        where: { automationId },
      });
      await prisma.aIBusinessAssignment.delete({
        where: { userId_purpose: { userId, purpose: "MATCH_ANALYSIS" } },
      });
      await prisma.aIConnection.delete({ where: { id: account.id } });
    } finally {
      store.close();
    }
  });

  it("a broken explicit managed assignment fails closed — never falls back", async () => {
    const { client, store } = hosted();
    try {
      const managedConn = await prisma.aIConnection.findFirstOrThrow({
        where: { userId, authType: "MANAGED" },
      });
      await prisma.aIBusinessAssignment.upsert({
        where: { userId_purpose: { userId, purpose: "MATCH_ANALYSIS" } },
        create: {
          userId,
          purpose: "MATCH_ANALYSIS",
          connectionId: managedConn.id,
          model: "vocatrya-fast",
        },
        update: { connectionId: managedConn.id, model: "vocatrya-fast" },
      });
      // Degrade the pinned connection — resolution must fail explicitly.
      await prisma.aIConnection.update({
        where: { id: managedConn.id },
        data: { status: "DISCONNECTED" },
      });
      const preview = await previewAutomationMatchRuntime(userId);
      expect(preview.plan).toMatchObject({
        kind: "invalid",
        code: "CONNECTION_DISCONNECTED",
      });
      const result = await matchJobToResume(
        job("https://boards.example/j/9"),
        resumeStub,
        "greenhouse",
        { provider: "ollama", model: "" } as never,
        userId,
        undefined,
        preview.plan,
        randomUUID(),
        { managedClient: client },
      );
      expect(result).toMatchObject({
        success: false,
        code: "CONNECTION_DISCONNECTED",
      });
      await prisma.aIConnection.update({
        where: { id: managedConn.id },
        data: { status: "CONNECTED" },
      });
    } finally {
      store.close();
    }
  });
});

describe("Interview session managed lock", () => {
  it("first-binds the session resource and replays it through the model port", async () => {
    const { client, store, requests } = hosted(async () =>
      Response.json({
        model: "vendor-v1",
        choices: [
          { message: { content: '{"ok":true}' }, finish_reason: "stop" },
        ],
      }),
    );
    try {
      await assignManagedBusinessSource(
        { userId, purpose: "INTERVIEW", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      const sessionId = randomUUID();
      const { plan, lock } = await resolveInterviewAiRuntime(
        userId,
        prisma,
        { resourceKey: `interview-session:${sessionId}`, managedClient: client },
      );
      expect(plan).toMatchObject({
        kind: "managed",
        provider: "VOCATRYA",
        backendKind: "MANAGED_GATEWAY",
        model: "vocatrya-fast",
        resourceKey: `interview-session:${sessionId}`,
      });
      const session = await prisma.interviewSession.create({
        data: {
          id: sessionId,
          userId,
          coachingMode: "PRACTICE",
          feedbackReleasePolicy: "IMMEDIATE",
          knowledgeBaseVersion: "kb-1",
          createdVia: "USER",
          resolvedConnectionId: lock.resolvedConnectionId,
          resolvedModel: lock.resolvedModel,
          managedAiProvenance: lock.managedAiProvenance,
        },
      });
      const rowLock = sessionAiLockFromRow(session);
      expect(rowLock).toMatchObject({
        kind: "managed",
        model: "vocatrya-fast",
      });

      const adapter = new VocatryaInterviewModelAdapter(
        prisma,
        undefined,
        (input) => executeAIConnectionText(input, { managedClient: client }),
      );
      const model = await adapter.resolveInterviewModel({
        requestingUserId: userId,
        sessionId,
      });
      const value = await model.generateJson(
        { system: "s", prompt: "p" },
        {
          operationId: `interview:${sessionId}:question-plan`,
          attemptIndex: 0,
        },
      );
      expect(value).toEqual({ ok: true });
      // Provenance equality is enforced inside the dispatch — a mismatched
      // binding would have failed MANAGED_PROVENANCE_INVALID.
      const texts = requests.filter(
        (r) => new URL(r.url).pathname === "/v1/structured",
      );
      // Interview calls go through executeAIConnectionText — text path
      // carries the persisted bindingId verbatim.
      const bodies = await Promise.all(
        requests
          .filter((r) =>
            ["/v1/text", "/v1/structured"].includes(new URL(r.url).pathname),
          )
          .map((r) => r.json()),
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0].operationId).toBe(
        `interview:${sessionId}:question-plan`,
      );
      expect(bodies[0].bindingId).toBe(
        decodeManagedAiProvenance(lock.managedAiProvenance!)!.managedBindingId,
      );
      void texts;
      await prisma.interviewSession.delete({ where: { id: sessionId } });
    } finally {
      store.close();
    }
  });
});

describe("Career Dialogue conversation managed lock", () => {
  it("binds conversation:<id> at creation and survives assignment changes", async () => {
    const { client, store } = hosted();
    try {
      await assignManagedBusinessSource(
        { userId, purpose: "CAREER_DIALOGUE", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      const row = await createChatConversationRecord({
        userId,
        messages: [],
        context: { version: 1, items: [] },
        managedClient: client,
      });
      expect(row.resolvedModel).toBe("vocatrya-fast");
      const decoded = decodeManagedAiProvenance(row.managedAiProvenance!);
      expect(decoded!.requestedModelKey).toBe("vocatrya-fast");
      expect(chatLockFromRow(row)).toMatchObject({ kind: "managed" });

      // Retarget the assignment — the existing conversation keeps its lock.
      const account = await prisma.aIConnection.create({
        data: {
          userId,
          provider: "OPENAI",
          backendKind: "CODEX_RUNTIME",
          displayName: "acct2",
          status: "CONNECTED",
          runtimeProfileRef: "rp_change2",
        },
      });
      // Direct row update — the streaming-capability write gate is not
      // under test here; the row lock's immutability is.
      await prisma.aIBusinessAssignment.update({
        where: { userId_purpose: { userId, purpose: "CAREER_DIALOGUE" } },
        data: { connectionId: account.id, model: "m" },
      });
      const reloaded = await prisma.chatConversation.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(chatLockFromRow(reloaded)).toMatchObject({
        kind: "managed",
        model: "vocatrya-fast",
      });
      await prisma.chatConversation.delete({ where: { id: row.id } });
      await prisma.aIBusinessAssignment.delete({
        where: { userId_purpose: { userId, purpose: "CAREER_DIALOGUE" } },
      });
      await prisma.aIConnection.delete({ where: { id: account.id } });
    } finally {
      store.close();
    }
  });
});

describe("Resume structured import managed path", () => {
  it("executes through the managed seam with durable operation identity", async () => {
    const { client, store, requests } = hosted(async () =>
      Response.json({
        model: "vendor-v1",
        choices: [
          {
            message: { content: '{"name":"Ada"}' },
            finish_reason: "stop",
          },
        ],
      }),
    );
    try {
      await assignManagedBusinessSource(
        { userId, purpose: "RESUME", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      const result = await executeStructuredForAssignment(
        {
          userId,
          purpose: "RESUME",
          schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          schemaName: "canonical_resume_import",
          prompt: "import",
          operationId: `resume-import:${randomUUID()}`,
          managedResource: {
            business: "RESUME",
            resourceKey: `resume-import:test`,
          },
        },
        { managedClient: client },
      );
      expect(result.status).toBe("OK");
      if (result.status === "OK") {
        expect(result.value).toEqual({ name: "Ada" });
        expect(result.managedAiProvenance).toMatchObject({
          requestedModelKey: "vocatrya-fast",
          upstreamModelId: "vendor-v1",
        });
        expect(result.provider).toBe("VOCATRYA");
      }
      const bindings = requests.filter(
        (r) => new URL(r.url).pathname === "/v1/bindings",
      );
      expect(bindings).toHaveLength(1);
      // A repeated call on the same operation+attempt is a typed replay —
      // surfaced as a stable failure code, never a silent re-charge.
      const dup = await executeStructuredForAssignment(
        {
          userId,
          purpose: "RESUME",
          schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          schemaName: "canonical_resume_import",
          prompt: "import",
          operationId: "resume-import:replayed",
          managedResource: {
            business: "RESUME",
            resourceKey: "resume-import:test",
          },
        },
        { managedClient: client },
      );
      expect(dup.status).toBe("OK");
      const dup2 = await executeStructuredForAssignment(
        {
          userId,
          purpose: "RESUME",
          schema: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
          schemaName: "canonical_resume_import",
          prompt: "import",
          operationId: "resume-import:replayed",
          managedResource: {
            business: "RESUME",
            resourceKey: "resume-import:test",
          },
        },
        { managedClient: client },
      );
      expect(dup2).toMatchObject({
        status: "FAILED",
        code: "INVOCATION_REPLAYED",
      });
    } finally {
      store.close();
    }
  });

  it("GLOBAL_DEFAULT managed assignment serves unassigned purposes", async () => {
    const { client, store } = hosted();
    try {
      await clearAssignments();
      await assignManagedBusinessSource(
        { userId, purpose: "GLOBAL_DEFAULT", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      const resolution = await resolveBusinessAIConfig({
        userId,
        purpose: "RESUME",
      });
      expect(resolution).toMatchObject({
        status: "RESOLVED",
        source: "GLOBAL_DEFAULT",
        provider: "VOCATRYA",
      });
    } finally {
      store.close();
    }
  });
});

describe("review hardening �� managed surfaces that must not degrade", () => {
  it("resolveInterviewModelForPlan runs the planning call on the creation binding", async () => {
    const { client, store, requests } = hosted(async () =>
      Response.json({
        model: "vendor-v1",
        choices: [
          { message: { content: "{\"q\":1}" }, finish_reason: "stop" },
        ],
      }),
    );
    try {
      await clearAssignments();
      await assignManagedBusinessSource(
        { userId, purpose: "INTERVIEW", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      const sessionId = randomUUID();
      const resolution = await resolveInterviewAiRuntime(userId, prisma, {
        resourceKey: `interview-session:${sessionId}`,
        managedClient: client,
      });
      const adapter = new VocatryaInterviewModelAdapter(
        prisma,
        undefined,
        (input) => executeAIConnectionText(input, { managedClient: client }),
      );
      const model = await adapter.resolveInterviewModelForPlan({
        requestingUserId: userId,
        plan: interviewCreationPlanRef(resolution),
      });
      expect(model.provider).toBe("VOCATRYA");
      const value = await model.generateJson(
        { system: "s", prompt: "p" },
        { operationId: `interview:${sessionId}:question-plan`, attemptIndex: 0 },
      );
      expect(value).toEqual({ q: 1 });
      const bodies = await Promise.all(
        requests
          .filter((r) =>
            ["/v1/text", "/v1/structured"].includes(new URL(r.url).pathname),
          )
          .map((r) => r.json()),
      );
      // The planning call consumed the SAME binding the row will persist.
      expect(bodies[0].bindingId).toBe(
        decodeManagedAiProvenance(resolution.lock.managedAiProvenance!)!
          .managedBindingId,
      );
    } finally {
      store.close();
    }
  });

  it("a managed plan missing its binding fails closed �� never falls back", async () => {
    const adapter = new VocatryaInterviewModelAdapter(prisma);
    await expect(
      adapter.resolveInterviewModelForPlan({
        requestingUserId: userId,
        plan: { kind: "managed", connectionId: "c", model: "m" },
      }),
    ).rejects.toMatchObject({ code: "MANAGED_PROVENANCE_INVALID" });
  });

  it("getInterviewReadiness reports managed ready without binding", async () => {
    const { client, store, requests } = hosted();
    try {
      await clearAssignments();
      await assignManagedBusinessSource(
        { userId, purpose: "INTERVIEW", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      const before = requests.length;
      const readiness = await getInterviewReadiness(userId);
      expect(readiness).toMatchObject({
        status: "ready",
        source: "BUSINESS_ASSIGNMENT",
        provider: "VOCATRYA",
        model: "vocatrya-fast",
      });
      // Readiness is a preview �� zero Hosted calls, zero bindings.
      expect(requests.length).toBe(before);
    } finally {
      store.close();
    }
  });

  it("a FAST_CHAT turn on a managed conversation executes through Hosted", async () => {
    const body =
      `data: ${JSON.stringify({ model: "vendor-v1", choices: [{ delta: { content: "hello" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`;
    const { client, store, requests } = hosted(
      async () =>
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
    );
    try {
      await clearAssignments();
      await assignManagedBusinessSource(
        { userId, purpose: "CAREER_DIALOGUE", modelKey: "vocatrya-fast" },
        { managedClient: client, dbClient: prisma },
      );
      const row = await createChatConversationRecord({
        userId,
        messages: [],
        context: { version: 1, items: [] },
        managedClient: client,
      });
      const lock = chatLockFromRow(row);
      if (lock.kind !== "managed") throw new Error("expected managed lock");
      const writes: unknown[] = [];
      const writer = { write: (part: unknown) => writes.push(part) } as never;
      const result = await runCareerDialogueTurn({
        userId,
        connectionId: lock.connectionId!,
        provider: "VOCATRYA",
        backendKind: "MANAGED_GATEWAY",
        modelName: lock.model,
        systemPrompt: "sys",
        messages: [
          {
            id: "m1",
            role: "user",
            parts: [{ type: "text", text: "hi" }],
          } as never,
        ],
        writer,
        signal: new AbortController().signal,
        managed: {
          provenance: lock.provenance,
          resourceKey: `conversation:${row.id}`,
          operationId: `dialogue:${row.id}:req-1`,
        },
        decision: { route: "FAST_CHAT", reason: "GREETING" },
        deps: { managedClient: client },
      });
      expect(result.answerChars).toBeGreaterThan(0);
      const bodies = await Promise.all(
        requests
          .filter((r) => new URL(r.url).pathname === "/v1/stream")
          .map((r) => r.json()),
      );
      expect(bodies).toHaveLength(1);
      expect(bodies[0].invocationKey).toBe(
        `dialogue:${row.id}:req-1:answer:0`,
      );
      await prisma.chatConversation.delete({ where: { id: row.id } });
    } finally {
      store.close();
    }
  });
});

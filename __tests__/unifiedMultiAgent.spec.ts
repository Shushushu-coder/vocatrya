// @vitest-environment node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import type { UIMessage } from "ai";
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { AGENT_ROLE_TOOL_ALLOWLIST } from "@/lib/agent/agentRoles";
import { effectiveAgentToolNames } from "@/lib/agent/toolPermissions";
import {
  evaluateLayer0Route,
  parseLayer1RouteDecision,
  buildStepHandoffPayload,
} from "@/lib/agent/unifiedRouter";
import {
  hasPendingApproval,
  isTodayPlanSuggestApprovalPart,
} from "@/lib/agent/paste";
import {
  admitConversationRequest,
  blockingPendingApprovals,
  ConversationRequestError,
  type ConversationRequest,
} from "@/lib/agent/conversationRequest";
import { buildTodayPlanTool } from "@/lib/agent/tools/todayPlan";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import {
  runLongTermMemoryExtraction,
  type MemoryExtractionDeps,
} from "@/lib/agent/longTermMemoryExtractor.server";
import {
  beginNativeTurn,
  saveNativeBinding,
  LEGACY_NATIVE_ROLE_KEY,
} from "@/lib/agent/nativeSession.server";
import { buildBackupZip, collectBackupData } from "@/lib/backup/export";
import { importBackup } from "@/lib/backup/import";
import {
  BACKUP_FORMAT_VERSION,
  BackupDataSchema,
  ManifestSchema,
} from "@/lib/backup/schema";
import { backupCoverageStatus } from "@/lib/backup/coverage";
import { resetDisposableDb, seedAccount } from "./helpers/backupTestDb";

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
vi.mock("@/lib/scheduler", () => ({ syncSchedulerState: vi.fn() }));

const prisma = new PrismaClient({ datasources: { db: { url: ctx.url } } });

afterAll(async () => {
  await prisma.$disconnect();
  try {
    fs.rmSync(ctx.dir, { recursive: true, force: true });
  } catch {
    // Windows EPERM on temp cleanup
  }
});

beforeEach(async () => {
  await resetDisposableDb(prisma);
});

describe("Unified Multi-Agent D01 — Layer 0 & Layer 1 Router", () => {
  it("hits Layer 0 with 0 LLM for explicit reanswer, retry_step, approval, and active task", () => {
    const reanswer = evaluateLayer0Route({
      operation: "reanswer",
      userText: "帮我看看简历",
      activeRole: "pilot",
      hasHistory: true,
      forcedRole: "reflect",
      hasActiveTask: false,
    });
    expect(reanswer.hit).toBe(true);
    if (reanswer.hit) {
      expect(reanswer.plan.steps).toHaveLength(1);
      expect(reanswer.plan.steps[0].role).toBe("reflect");
    }

    const approval = evaluateLayer0Route({
      operation: "approval",
      userText: "",
      activeRole: "insight",
      hasHistory: true,
      approvalRole: "pilot",
      hasActiveTask: false,
    });
    expect(approval.hit).toBe(true);
    if (approval.hit) {
      expect(approval.plan.steps[0].role).toBe("pilot");
    }

    const task = evaluateLayer0Route({
      operation: "send",
      userText: "继续推进",
      activeRole: "insight",
      hasHistory: true,
      hasActiveTask: true,
    });
    expect(task.hit).toBe(true);
    if (task.hit) {
      expect(task.plan.steps[0].role).toBe("pilot");
    }
  });

  it("hits Layer 0 on pure continuation but misses on cross-role action phrases", () => {
    const cont = evaluateLayer0Route({
      operation: "send",
      userText: "嗯，那第二个呢？",
      activeRole: "insight",
      hasHistory: true,
      hasActiveTask: false,
    });
    expect(cont.hit).toBe(true);
    if (cont.hit) expect(cont.plan.steps[0].role).toBe("insight");

    const crossRole = evaluateLayer0Route({
      operation: "send",
      userText: "顺便帮我加进今天待办",
      activeRole: "insight",
      hasHistory: true,
      hasActiveTask: false,
    });
    expect(crossRole.hit).toBe(false);

    const firstTurn = evaluateLayer0Route({
      operation: "send",
      userText: "嗯",
      activeRole: null,
      hasHistory: false,
      hasActiveTask: false,
    });
    expect(firstTurn.hit).toBe(false);
  });

  it("parses Layer 1 JSON, collapses duplicate roles, clamps >2 steps, and falls back on malformed JSON", () => {
    const collapsed = parseLayer1RouteDecision(
      JSON.stringify({
        steps: [
          { role: "insight", objective: "分析匹配度" },
          { role: "insight", objective: "补充建议" },
        ],
      }),
      { activeRole: "pilot", hasHistory: true, userText: "分析" },
    );
    expect(collapsed.steps).toHaveLength(1);
    expect(collapsed.steps[0].role).toBe("insight");

    const clamped = parseLayer1RouteDecision(
      JSON.stringify({
        steps: [
          { role: "insight", objective: "匹配分析" },
          { role: "pilot", objective: "加入待办" },
          { role: "reflect", objective: "复盘总结" },
        ],
      }),
      { activeRole: "pilot", hasHistory: true, userText: "三件事" },
    );
    expect(clamped.steps).toHaveLength(2);
    expect(clamped.truncatedExtraGoals).toBe(true);

    const fallback = parseLayer1RouteDecision("not valid json {{{", {
      activeRole: "reflect",
      hasHistory: true,
      userText: "聊聊",
    });
    expect(fallback.steps).toHaveLength(1);
    expect(fallback.steps[0].role).toBe("reflect");
  });
});

describe("Unified Multi-Agent D02 — Hard Tool Scoping & Unified Omit suggest_role", () => {
  it("gives get_resume to all three roles and restricts today_plan write exclusively to pilot", () => {
    expect(AGENT_ROLE_TOOL_ALLOWLIST.pilot).toContain("get_resume");
    expect(AGENT_ROLE_TOOL_ALLOWLIST.insight).toContain("get_resume");
    expect(AGENT_ROLE_TOOL_ALLOWLIST.reflect).toContain("get_resume");

    expect(AGENT_ROLE_TOOL_ALLOWLIST.pilot).toContain("today_plan");
    expect(AGENT_ROLE_TOOL_ALLOWLIST.insight).not.toContain("today_plan");
    expect(AGENT_ROLE_TOOL_ALLOWLIST.reflect).not.toContain("today_plan");
    expect(AGENT_ROLE_TOOL_ALLOWLIST.insight).toContain("today_plan_read");
    expect(AGENT_ROLE_TOOL_ALLOWLIST.reflect).toContain("today_plan_read");

    expect(AGENT_ROLE_TOOL_ALLOWLIST.insight).not.toContain("add_job");
    expect(AGENT_ROLE_TOOL_ALLOWLIST.pilot).not.toContain("match_job");
    expect(AGENT_ROLE_TOOL_ALLOWLIST.pilot).not.toContain("review_resume");
  });

  it("omits suggest_role when unified is true while preserving legacy role behavior", () => {
    const unifiedPilot = effectiveAgentToolNames({
      agentRole: "pilot",
      unified: true,
    });
    const legacyPilot = effectiveAgentToolNames({
      agentRole: "pilot",
      unified: false,
    });
    expect(unifiedPilot).not.toContain("suggest_role");
    expect(legacyPilot).toContain("suggest_role");
  });
});

describe("Unified Multi-Agent D03/D04/D06 — Handoff, today_plan(suggest) Non-Blocking & H04 D3", () => {
  it("extracts only verified entity IDs in buildStepHandoffPayload", () => {
    const step1Msg = {
      id: "m1",
      role: "assistant",
      parts: [
        {
          type: "tool-match_job",
          toolCallId: "tc-1",
          state: "output-available",
          input: {},
          output: {
            matched: true,
            jobId: "job-123",
            matchAnalysisId: "ma-456",
            resumeVersionId: "rv-789",
          },
        },
        {
          type: "text",
          text: "这段话不应被直接塞入 handoff 的 verifiedEntities。",
        },
      ],
    } as unknown as UIMessage;

    const payload = buildStepHandoffPayload({
      step1Role: "insight",
      step1Objective: "评估匹配度",
      step2Objective: "给出今日待办建议",
      step1Message: step1Msg,
    });
    expect(payload.verifiedEntities.jobIds).toEqual(["job-123"]);
    expect(payload.verifiedEntities.matchAnalysisIds).toEqual(["ma-456"]);
    expect(payload.verifiedEntities.resumeVersionIds).toEqual(["rv-789"]);
  });

  it("coerces today_plan(action=add) to approval-gated suggest in Step 2 (forceSuggestOnly)", async () => {
    const userId = await seedAccount(prisma, `tp-s2-${randomUUID()}@x.com`);
    const convo = await prisma.chatConversation.create({
      data: {
        userId,
        messages: "[]",
        chatMode: "UNIFIED",
        activeRole: "pilot",
        activeRequestId: "req-tp",
        activeRequestExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const req: ConversationRequest = {
      userId,
      conversationId: convo.id,
      requestId: "req-tp",
      revision: 0,
      messages: [],
      responseMessageId: "a1",
      released: false,
      wrote: false,
    };
    const tool = buildTodayPlanTool(userId, req, { forceSuggestOnly: true });
    const needsApproval =
      typeof tool.needsApproval === "function"
        ? await tool.needsApproval(
            { action: "add", items: ["改简历"] },
            { toolCallId: "tc1", messages: [] },
          )
        : Boolean(tool.needsApproval);
    expect(needsApproval).toBe(true);

    const out = await tool.execute!(
      { action: "add", items: ["改简历"] },
      { toolCallId: "tc1", messages: [] },
    );
    expect((out as { action?: string }).action).toBe("suggest");
  });

  it("exempts today_plan(suggest) from blockingPendingApprovals while blocking on add_job and native AgentOperationProposal", async () => {
    const suggestPart = {
      type: "tool-today_plan",
      toolCallId: "tc-tp",
      state: "approval-requested",
      input: { action: "suggest", items: ["准备面试"] },
      approval: { id: "apr-tp" },
    };
    expect(isTodayPlanSuggestApprovalPart(suggestPart)).toBe(true);

    const suggestMessages = [
      { id: "a1", role: "assistant", parts: [suggestPart] },
    ] as unknown as UIMessage[];
    expect(hasPendingApproval(suggestMessages)).toBe(false);
    expect(blockingPendingApprovals(suggestMessages)).toHaveLength(0);

    // Seed an active native AgentOperationProposal (messageId = null) and confirm H04 D3 blocks send!
    const userId = await seedAccount(prisma, `h04-${randomUUID()}@x.com`);
    const convo = await prisma.chatConversation.create({
      data: {
        userId,
        messages: JSON.stringify(suggestMessages),
        chatMode: "UNIFIED",
        activeRole: "pilot",
      },
    });

    // Without a blocking proposal, send is admitted even with a pending today_plan(suggest) card.
    const admitted = await admitConversationRequest({
      userId,
      conversationId: convo.id,
      requestId: "req-1",
      expectedRevision: 0,
      operation: "send",
      newMessage: { id: "u2", role: "user", parts: [{ type: "text", text: "好的" }] },
    });
    expect(admitted.conversationId).toBe(convo.id);

    // Release active lock, then create a native PROPOSED add_job proposal (messageId = null).
    await prisma.chatConversation.update({
      where: { id: convo.id },
      data: { activeRequestId: null, activeRequestExpiresAt: null },
    });
    await prisma.agentOperationProposal.create({
      data: {
        userId,
        conversationId: convo.id,
        messageId: null,
        toolCallId: `tc-${randomUUID()}`,
        approvalId: `apr-${randomUUID()}`,
        turnKey: `turn-${randomUUID()}`,
        toolName: "add_job",
        inputJson: JSON.stringify({ title: "SWE" }),
        inputHash: "hash-1",
        status: "PROPOSED",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(
      admitConversationRequest({
        userId,
        conversationId: convo.id,
        requestId: "req-2",
        expectedRevision: admitted.revision,
        operation: "send",
        newMessage: { id: "u3", role: "user", parts: [{ type: "text", text: "继续" }] },
      }),
    ).rejects.toMatchObject({
      code: "CONVERSATION_TURN_CONFLICT",
    } satisfies Partial<ConversationRequestError>);
  });
});

describe("Unified Multi-Agent D07/D08-Q3 — Model Assignments & M2.1 Router Slot Isolation", () => {
  it("falls back read-only to legacy CAREER_DIALOGUE when neither AGENT_PILOT nor GLOBAL_DEFAULT exists", async () => {
    const userId = await seedAccount(prisma, `d08q3-${randomUUID()}@x.com`);
    const conn = await prisma.aIConnection.create({
      data: {
        userId,
        displayName: "My OpenAI",
        provider: "OPENAI",
        backendKind: "LOCAL_BYOK",
        authType: "API_KEY",
        credentialRef: randomUUID(),
        status: "CONNECTED",
      },
    });
    await prisma.aIBusinessAssignment.create({
      data: {
        userId,
        purpose: "CAREER_DIALOGUE",
        connectionId: conn.id,
        model: "gpt-4.1-mini",
      },
    });

    const resolved = await resolveBusinessAIConfig(
      { userId, purpose: "AGENT_PILOT" },
      prisma,
    );
    expect(resolved.status).toBe("RESOLVED");
    if (resolved.status === "RESOLVED") {
      expect(resolved.legacyFallbackPurpose).toBe("CAREER_DIALOGUE");
      expect(resolved.connectionId).toBe(conn.id);
    }

    // Read-only guarantee: no AGENT_PILOT row was silently written into the DB.
    const written = await prisma.aIBusinessAssignment.findUnique({
      where: { userId_purpose: { userId, purpose: "AGENT_PILOT" } },
    });
    expect(written).toBeNull();
  });

  it("enforces D07 M2.1 isolation: uses AGENT_ROUTER for BYOK/MANAGED and never crosses accounts on ACCOUNT_LOGIN seats", async () => {
    const callSpy = vi.fn().mockResolvedValue({ text: '{"actions":[]}' });
    const makeDeps = (overrides: {
      connectionId: string;
      model: string;
      connectionClass: "ACCOUNT_LOGIN" | "BYOK" | "MANAGED";
      routerSlot:
        | {
            kind: "resolved";
            connectionId: string;
            model: string;
            managedAiProvenance: null;
            connectionClass: "BYOK" | "MANAGED";
          }
        | { kind: "invalid"; reason: string };
    }): MemoryExtractionDeps => ({
      now: () => Date.now(),
      store: {
        memoryEnabled: async () => true,
        loadConversation: async () => ({
          archived: false,
          resolvedConnectionId: overrides.connectionId,
          resolvedModel: overrides.model,
          managedAiProvenance: null,
          connectionClass: overrides.connectionClass,
          messages: [
            { id: "u1", role: "user", parts: [{ type: "text", text: "记住：以后不要推荐外包岗位，我只看一线城市后端岗位。" }] },
            { id: "a1", role: "assistant", parts: [{ type: "text", text: "好的，已记下你的偏好。" }] },
          ],
        }),
        resolveRouterSlot: async () => overrides.routerSlot,
        listEntries: async () => [],
        applyAction: async () => ({ applied: true }),
      },
      executeText: callSpy,
    });

    // ACCOUNT_LOGIN seat MUST stay on its own connection — never call conn-byok-router!
    await runLongTermMemoryExtraction(
      { userId: "u1", conversationId: `c-acc-${randomUUID()}` },
      makeDeps({
        connectionId: "conn-account-seat",
        model: "gpt-5.4",
        connectionClass: "ACCOUNT_LOGIN",
        routerSlot: {
          kind: "resolved",
          connectionId: "conn-byok-router",
          model: "gpt-4.1-mini",
          managedAiProvenance: null,
          connectionClass: "BYOK",
        },
      }),
      true,
    );
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy.mock.calls[0][0].connectionId).toBe("conn-account-seat");

    // BYOK conversation SHOULD reuse the cheap AGENT_ROUTER slot with disableReasoning: true!
    callSpy.mockClear();
    await runLongTermMemoryExtraction(
      { userId: "u1", conversationId: `c-byok-${randomUUID()}` },
      makeDeps({
        connectionId: "conn-byok-heavy",
        model: "claude-opus-4",
        connectionClass: "BYOK",
        routerSlot: {
          kind: "resolved",
          connectionId: "conn-byok-router",
          model: "gpt-4.1-mini",
          managedAiProvenance: null,
          connectionClass: "BYOK",
        },
      }),
      true,
    );
    expect(callSpy).toHaveBeenCalledTimes(1);
    expect(callSpy.mock.calls[0][0].connectionId).toBe("conn-byok-router");
    expect(callSpy.mock.calls[0][0].disableReasoning).toBe(true);

    // Invalid explicit Router slot skips M2.1 extraction quietly without spending the heavy seat!
    callSpy.mockClear();
    const skipped = await runLongTermMemoryExtraction(
      { userId: "u1", conversationId: `c-inv-${randomUUID()}` },
      makeDeps({
        connectionId: "conn-byok-heavy",
        model: "claude-opus-4",
        connectionClass: "BYOK",
        routerSlot: { kind: "invalid", reason: "CONNECTION_DISCONNECTED" },
      }),
      true,
    );
    expect(skipped.status).toBe("skipped");
    expect(callSpy).not.toHaveBeenCalled();
  });
});

describe("Unified Multi-Agent D08 — Per-Role Native Bindings, Backup v15 & SQLite Migration", () => {
  it("stores independent per-role NativeConversationBinding rows per conversation", async () => {
    const userId = await seedAccount(prisma, `nat-${randomUUID()}@x.com`);
    const conn = await prisma.aIConnection.create({
      data: {
        userId,
        displayName: "Codex Account",
        provider: "OPENAI",
        backendKind: "CODEX_RUNTIME",
        authType: "ACCOUNT_LOGIN",
        runtimeProfileRef: "rp_fixture",
        status: "CONNECTED",
      },
    });
    const convo = await prisma.chatConversation.create({
      data: {
        userId,
        messages: "[]",
        chatMode: "UNIFIED",
        executionPath: "APP_ORCHESTRATED",
        activeRequestId: "req-nat",
        activeRequestExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const req: ConversationRequest = {
      userId,
      conversationId: convo.id,
      requestId: "req-nat",
      revision: 0,
      messages: [],
      responseMessageId: "a1",
      released: false,
      wrote: false,
    };
    const mkSession = (threadId: string) => ({
      type: "native-session" as const,
      threadId,
      resumed: false,
      runtimeVersion: "0.169.0",
      runtimeProfileRef: "rp_fixture",
      configHash: "cfg",
    });

    await saveNativeBinding(
      req,
      mkSession("thread-pilot-1"),
      {
        connectionId: conn.id,
        model: "gpt-5.4",
        promptHash: "p1",
        roleKey: "pilot",
        unified: true,
        lastSyncedMessageId: "m-1",
      },
      prisma,
    );
    await saveNativeBinding(
      req,
      mkSession("thread-insight-1"),
      {
        connectionId: conn.id,
        model: "gpt-5.4",
        promptHash: "p2",
        roleKey: "insight",
        unified: true,
        lastSyncedMessageId: "m-2",
      },
      prisma,
    );

    const pilotTurn = await beginNativeTurn(req, prisma, {
      roleKey: "pilot",
      unified: true,
      connectionId: conn.id,
      model: "gpt-5.4",
    });
    const insightTurn = await beginNativeTurn(req, prisma, {
      roleKey: "insight",
      unified: true,
      connectionId: conn.id,
      model: "gpt-5.4",
    });
    const legacyTurn = await beginNativeTurn(req, prisma, {
      roleKey: LEGACY_NATIVE_ROLE_KEY,
      unified: true,
      connectionId: conn.id,
      model: "gpt-5.4",
    });

    expect(pilotTurn?.threadId).toBe("thread-pilot-1");
    expect(pilotTurn?.lastSyncedMessageId).toBe("m-1");
    expect(insightTurn?.threadId).toBe("thread-insight-1");
    expect(insightTurn?.lastSyncedMessageId).toBe("m-2");
    expect(legacyTurn).toBeNull();
  });

  it("round-trips ChatTurn, ChatTurnStep, and unified ChatConversation fields in Backup v15", async () => {
    expect(BACKUP_FORMAT_VERSION).toBe(15);
    expect(backupCoverageStatus("ChatTurn")).toBe("BACKED_UP");
    expect(backupCoverageStatus("ChatTurnStep")).toBe("BACKED_UP");
    expect(backupCoverageStatus("NativeConversationBinding")).toBe("INTENTIONALLY_EXCLUDED");

    const baseManifest = {
      appVersion: "1",
      exportedAt: new Date().toISOString(),
      sourceEmail: "x@example.com",
      counts: {},
    };
    expect(ManifestSchema.safeParse({ ...baseManifest, formatVersion: 14 }).success).toBe(true);
    expect(ManifestSchema.safeParse({ ...baseManifest, formatVersion: 15 }).success).toBe(true);
    expect(ManifestSchema.safeParse({ ...baseManifest, formatVersion: 16 }).success).toBe(false);

    const userId = await seedAccount(prisma, `bk-u15-${randomUUID()}@x.com`);
    const convo = await prisma.chatConversation.create({
      data: {
        userId,
        messages: "[]",
        chatMode: "UNIFIED",
        activeRole: "insight",
      },
    });
    const turn = await prisma.chatTurn.create({
      data: {
        userId,
        conversationId: convo.id,
        requestId: "req-u15",
        operation: "send",
        routeLayer: "LAYER1",
        plannedStepCount: 2,
        status: "COMPLETED",
        steps: {
          create: [
            {
              userId,
              conversationId: convo.id,
              stepIndex: 0,
              role: "insight",
              objective: "评估匹配度",
              resolvedModel: "gpt-5.4",
              executionPath: "ORCHESTRATED_V1",
              configSource: "AGENT_INSIGHT",
              status: "COMPLETED",
            },
            {
              userId,
              conversationId: convo.id,
              stepIndex: 1,
              role: "pilot",
              objective: "给出待办建议",
              resolvedModel: "gpt-4.1-mini",
              executionPath: "ORCHESTRATED_V1",
              configSource: "GLOBAL_DEFAULT",
              status: "COMPLETED",
            },
          ],
        },
      },
    });

    const data = await collectBackupData(userId);
    expect(data.ChatTurn).toHaveLength(1);
    expect(data.ChatTurnStep).toHaveLength(2);
    expect(BackupDataSchema.parse(data)).toBeTruthy();

    const { buffer } = await buildBackupZip(userId, "bk-u15@example.com");
    const result = await importBackup(buffer, userId, "bk-u15@example.com", true);
    expect(result.counts.ChatTurn).toBe(1);
    expect(result.counts.ChatTurnStep).toBe(2);

    const restoredConvo = await prisma.chatConversation.findFirst({ where: { userId } });
    const restoredTurns = await prisma.chatTurn.findMany({
      where: { userId },
      include: { steps: { orderBy: { stepIndex: "asc" } } },
    });
    expect(restoredConvo?.chatMode).toBe("UNIFIED");
    expect(restoredConvo?.activeRole).toBe("insight");
    expect(restoredTurns).toHaveLength(1);
    expect(restoredTurns[0].id).not.toBe(turn.id);
    expect(restoredTurns[0].conversationId).toBe(restoredConvo!.id);
    expect(restoredTurns[0].steps).toHaveLength(2);
    expect(restoredTurns[0].steps[0].role).toBe("insight");
    expect(restoredTurns[0].steps[1].role).toBe("pilot");
  });

  it("applies 20261126180000_unified_multi_agent migration cleanly on an isolated SQLite DB", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-u-mig-"));
    const dbFile = path.join(dir, "mig.db");
    const url = `file:${dbFile.replace(/\\/g, "/")}`;
    const env = { ...process.env, DATABASE_URL: url };
    try {
      const prismaBin = path.resolve(
        process.cwd(),
        "node_modules",
        ".bin",
        process.platform === "win32" ? "prisma.cmd" : "prisma",
      );
      execFileSync(prismaBin, ["migrate", "deploy"], {
        env,
        stdio: "pipe",
        shell: process.platform === "win32",
      });
      const migClient = new PrismaClient({ datasources: { db: { url } } });
      try {
        const cols = await migClient.$queryRawUnsafe<Array<{ name: string }>>(
          `PRAGMA table_info("NativeConversationBinding")`,
        );
        const colNames = cols.map((c) => c.name);
        expect(colNames).toContain("id");
        expect(colNames).toContain("roleKey");
        expect(colNames).toContain("initializationState");
        expect(colNames).toContain("lastSyncedMessageId");

        const tables = await migClient.$queryRawUnsafe<Array<{ name: string }>>(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('ChatTurn','ChatTurnStep')`,
        );
        expect(tables.map((t) => t.name).sort()).toEqual(["ChatTurn", "ChatTurnStep"]);
      } finally {
        await migClient.$disconnect();
      }
    } finally {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore Windows cleanup flake
      }
    }
  });
});

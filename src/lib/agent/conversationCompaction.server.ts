import "server-only";

import type { PrismaClient } from "@prisma/client";
import { normalizeLocale } from "@/i18n";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import prisma from "@/lib/db";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import { resolveVerifiedBusinessAnchors } from "./businessAnchors.server";
import {
  buildCareerDialogueContext,
  resolveCareerDialogueBudgets,
} from "./contextBudget";
import type { AgentContextUsage } from "./contextUsage";
import {
  pageContextFromConversation,
  parseConversationContext,
} from "./conversationContext";
import {
  isConversationSummaryCircuitOpen,
  validateConversationSummaryCoverage,
} from "./conversationSummaryCoverage";
import {
  acquireConversationCompactionSlot,
  condenseCareerDialogueSummary,
  defaultSummarySchedulerDeps,
  isConversationCompactionInFlight,
  type SummarySchedulerDeps,
} from "./conversationSummaryScheduler";
import {
  createPrismaSummaryRepository,
  type SummaryRepository,
} from "./conversationSummaryStore";
import { buildAgentChatSystemPrompt } from "./prompt";
import { resolveTaskSessionContext } from "./task/agentTaskBootstrap";

export type CompactionServiceDeps = {
  db?: PrismaClient;
  repository?: SummaryRepository;
  schedulerDeps?: SummarySchedulerDeps;
  timeZone?: string;
};

export type ManualCompactionAnchorsSummary = {
  hasJob: boolean;
  hasResume: boolean;
  hasTodayPlan: boolean;
  excludedCount: number;
};

export type ManualCompactionResult =
  | {
      ok: true;
      httpStatus: 200;
      status: "committed";
      usage: AgentContextUsage | null;
      beforeTokens: number | null;
      afterTokens: number | null;
      anchors: ManualCompactionAnchorsSummary | null;
      summaryUnits?: number;
      coveredCount?: number;
      generationMs?: number;
    }
  | {
      ok: true;
      httpStatus: 200;
      status: "skipped";
      reason: string;
      usage: AgentContextUsage | null;
    }
  | {
      ok: false;
      httpStatus: 200 | 404 | 409;
      status: "rejected" | "conflict" | "failed";
      code: string;
      degraded?: boolean;
      failureCount?: number;
      circuitBreakerOpen?: boolean;
      usage: AgentContextUsage | null;
    };

async function computeUsageAndAnchors(
  input: {
    userId: string;
    conversationId: string;
    locale?: string;
  },
  deps?: CompactionServiceDeps & { now?: () => number },
): Promise<{
  usage: AgentContextUsage;
  anchors: ManualCompactionAnchorsSummary | null;
} | null> {
  const db = deps?.db ?? prisma;
  const repository = deps?.repository ?? createPrismaSummaryRepository(db);
  const snapshot = await repository.load(input.userId, input.conversationId);
  if (
    !snapshot ||
    snapshot.archived ||
    snapshot.executionPath === "NATIVE_CODEX_V1" ||
    snapshot.lockInvalid ||
    !snapshot.resolvedConnectionId ||
    !snapshot.resolvedModel
  ) {
    return null;
  }

  const resolvedBudgets = resolveCareerDialogueBudgets({
    model: snapshot.resolvedModel,
    upstreamModelId: snapshot.managed?.provenance.upstreamModelId,
    provider: snapshot.provider,
    backendKind: snapshot.backendKind,
  });

  const verdict = validateConversationSummaryCoverage(
    snapshot.summary,
    snapshot.messages,
    { maxSummaryTokens: resolvedBudgets.budgets.summaryTokens },
  );
  const freshSummary =
    verdict.status === "FRESH"
      ? {
          text: verdict.text,
          throughMessageId: snapshot.messages[verdict.throughIndex].id,
        }
      : undefined;

  const failureCount = snapshot.summary?.failureCount ?? 0;
  const circuitBreakerOpen = isConversationSummaryCircuitOpen(failureCount);
  const conversationContext = parseConversationContext(snapshot.context);
  const pageContext = pageContextFromConversation(conversationContext);
  const locale = normalizeLocale(input.locale);

  let anchorsSummary: ManualCompactionAnchorsSummary | null = null;
  let businessAnchorLine: string | undefined;
  if (freshSummary) {
    try {
      const timeZone =
        deps?.timeZone ??
        (await getUserTimeZone(input.userId).catch(() => "UTC"));
      const anchors = await resolveVerifiedBusinessAnchors(db, {
        userId: input.userId,
        conversationId: input.conversationId,
        context: conversationContext,
        locale,
        timeZone,
        now: deps?.now ? new Date(deps.now()) : undefined,
      });
      if (anchors.renderedBlock) businessAnchorLine = anchors.renderedBlock;
      anchorsSummary = {
        hasJob: Boolean(anchors.job),
        hasResume: Boolean(anchors.resume),
        hasTodayPlan: Boolean(anchors.todayPlan),
        excludedCount: anchors.excludedCount,
      };
    } catch {
      anchorsSummary = null;
    }
  }

  let freshNativeFull = false;
  try {
    const careerRuntime = await resolveCareerRuntimeMode(db);
    freshNativeFull = isFreshNativeFullSurface(careerRuntime);
  } catch {
    freshNativeFull = false;
  }

  let taskSession: Awaited<ReturnType<typeof resolveTaskSessionContext>> = null;
  if (snapshot.agentTaskId) {
    try {
      taskSession = await resolveTaskSessionContext(db, {
        userId: input.userId,
        agentTaskId: snapshot.agentTaskId,
        agentRole: snapshot.agentRole,
        locale,
      });
    } catch {
      taskSession = null;
    }
  }

  const systemPrompt = buildAgentChatSystemPrompt(locale, {
    freshNativeFull,
    agentRole: snapshot.agentRole,
    taskExtraTools: taskSession?.extraTools,
  });

  const budget = buildCareerDialogueContext({
    profile: "FAST_CHAT",
    messages: snapshot.messages,
    pageContext,
    summary: freshSummary,
    systemText: systemPrompt,
    fixedOverheadText: systemPrompt,
    budgets: resolvedBudgets.budgets,
    autoCompactTriggerTokens: resolvedBudgets.autoCompactTriggerTokens,
    freshNativeFull,
    agentRole: snapshot.agentRole,
    agentTaskId: taskSession?.taskId,
    handoffLine: taskSession?.handoffLine,
    businessAnchorLine,
  });
  if (!budget.ok) return null;

  const usage: AgentContextUsage = {
    conversationId: input.conversationId,
    requestId: "snapshot",
    profile: budget.size.contextProfile,
    estimatedInputTokens: budget.size.estimatedInputTokens,
    recentTurnCount: budget.size.recentTurnCount,
    droppedTurnCount: budget.size.droppedTurnCount,
    modelContextWindowTokens: resolvedBudgets.contextWindowTokens,
    modelContextWindowSource: resolvedBudgets.contextWindowSource,
    autoCompactTriggerTokens: resolvedBudgets.autoCompactTriggerTokens,
    microCompactedToolCount: budget.size.microCompactedToolCount,
    compactedTurnCount: budget.size.compactedTurnCount,
    hasSummary: Boolean(freshSummary),
    circuitBreakerOpen,
    failureCount,
    tokens: {
      system: budget.size.systemTokens,
      currentUser: budget.size.currentUserTokens,
      history: budget.size.historyTokens,
      explicitContext: budget.size.explicitContextTokens,
      toolResult: budget.size.toolResultTokens,
      summary: budget.size.summaryTokens,
      dynamic: budget.size.dynamicTokens,
      ...(budget.size.businessAnchorTokens > 0
        ? { businessAnchor: budget.size.businessAnchorTokens }
        : {}),
      ...(budget.size.handoffTokens > 0
        ? { handoff: budget.size.handoffTokens }
        : {}),
    },
    budgets: { ...resolvedBudgets.budgets },
  };

  return { usage, anchors: anchorsSummary };
}

export async function computeConversationContextUsage(
  input: {
    userId: string;
    conversationId: string;
    locale?: string;
  },
  deps?: CompactionServiceDeps & { now?: () => number },
): Promise<AgentContextUsage | null> {
  const computed = await computeUsageAndAnchors(input, deps);
  return computed?.usage ?? null;
}

function activeRequestBlocksCompaction(
  activeRequestId: string | null | undefined,
  activeRequestExpiresAt: Date | null | undefined,
  nowMs: number,
): boolean {
  if (!activeRequestId) return false;
  if (!activeRequestExpiresAt) return true;
  return activeRequestExpiresAt.getTime() > nowMs;
}

export async function runManualConversationCompaction(
  input: {
    userId: string;
    conversationId: string;
    focusNote?: string | null;
    locale?: string;
  },
  deps?: CompactionServiceDeps,
): Promise<ManualCompactionResult> {
  if (isConversationCompactionInFlight(input.conversationId)) {
    return {
      ok: false,
      httpStatus: 409,
      status: "conflict",
      code: "COMPACTION_IN_PROGRESS",
      usage: null,
    };
  }

  const db = deps?.db ?? prisma;
  const schedulerDeps: SummarySchedulerDeps = deps?.schedulerDeps ?? {
    ...defaultSummarySchedulerDeps(),
    repository: deps?.repository ?? createPrismaSummaryRepository(db),
  };

  const initial = await schedulerDeps.repository.load(
    input.userId,
    input.conversationId,
  );
  if (!initial) {
    return {
      ok: false,
      httpStatus: 404,
      status: "rejected",
      code: "CONVERSATION_NOT_FOUND",
      usage: null,
    };
  }
  if (initial.archived) {
    return {
      ok: false,
      httpStatus: 409,
      status: "rejected",
      code: "CONVERSATION_ARCHIVED",
      usage: null,
    };
  }
  if (initial.executionPath === "NATIVE_CODEX_V1") {
    return {
      ok: false,
      httpStatus: 409,
      status: "rejected",
      code: "NATIVE_SESSION_EXEMPT",
      usage: null,
    };
  }
  if (initial.lockInvalid) {
    return {
      ok: false,
      httpStatus: 409,
      status: "failed",
      code: initial.lockInvalid,
      degraded: true,
      usage: null,
    };
  }
  if (!initial.resolvedConnectionId || !initial.resolvedModel) {
    return {
      ok: false,
      httpStatus: 409,
      status: "rejected",
      code: "COMPACTION_UNSUPPORTED_LEGACY",
      usage: null,
    };
  }
  if (
    activeRequestBlocksCompaction(
      initial.activeRequestId,
      initial.activeRequestExpiresAt,
      schedulerDeps.now(),
    )
  ) {
    return {
      ok: false,
      httpStatus: 409,
      status: "conflict",
      code: "CONVERSATION_TURN_CONFLICT",
      usage: null,
    };
  }

  const slot = acquireConversationCompactionSlot<ManualCompactionResult>(
    input.conversationId,
    async () => {
      const live = await schedulerDeps.repository.load(
        input.userId,
        input.conversationId,
      );
      if (!live) {
        return {
          ok: false,
          httpStatus: 404,
          status: "rejected",
          code: "CONVERSATION_NOT_FOUND",
          usage: null,
        };
      }
      if (live.archived) {
        return {
          ok: false,
          httpStatus: 409,
          status: "rejected",
          code: "CONVERSATION_ARCHIVED",
          usage: null,
        };
      }
      if (live.executionPath === "NATIVE_CODEX_V1") {
        return {
          ok: false,
          httpStatus: 409,
          status: "rejected",
          code: "NATIVE_SESSION_EXEMPT",
          usage: null,
        };
      }
      if (
        activeRequestBlocksCompaction(
          live.activeRequestId,
          live.activeRequestExpiresAt,
          schedulerDeps.now(),
        )
      ) {
        return {
          ok: false,
          httpStatus: 409,
          status: "conflict",
          code: "CONVERSATION_TURN_CONFLICT",
          usage: null,
        };
      }

      const usageDeps = {
        db,
        repository: schedulerDeps.repository,
        now: schedulerDeps.now,
        timeZone: deps?.timeZone,
      };
      const before = await computeUsageAndAnchors(input, usageDeps).catch(
        () => null,
      );
      const outcome = await condenseCareerDialogueSummary(
        {
          userId: input.userId,
          conversationId: input.conversationId,
          mode: "manual",
          focusNote: input.focusNote,
        },
        schedulerDeps,
      );
      const after = await computeUsageAndAnchors(input, usageDeps).catch(
        () => null,
      );

      if (outcome.status === "committed") {
        return {
          ok: true,
          httpStatus: 200,
          status: "committed",
          usage: after?.usage ?? null,
          beforeTokens: before?.usage.estimatedInputTokens ?? null,
          afterTokens: after?.usage.estimatedInputTokens ?? null,
          anchors: after?.anchors ?? null,
          summaryUnits: outcome.summaryUnits,
          coveredCount: outcome.coveredCount,
          generationMs: outcome.generationMs,
        };
      }
      if (outcome.status === "skipped") {
        return {
          ok: true,
          httpStatus: 200,
          status: "skipped",
          reason: outcome.reason,
          usage: after?.usage ?? before?.usage ?? null,
        };
      }
      if (outcome.status === "discarded") {
        return {
          ok: false,
          httpStatus: 409,
          status: "conflict",
          code: "CONVERSATION_STALE_WRITE",
          usage: after?.usage ?? before?.usage ?? null,
        };
      }
      const failureCount = outcome.failureCount ?? 0;
      return {
        ok: false,
        httpStatus: 200,
        status: "failed",
        code: outcome.reason,
        degraded: true,
        failureCount,
        circuitBreakerOpen:
          outcome.circuitBreakerOpen ??
          isConversationSummaryCircuitOpen(failureCount),
        usage: after?.usage ?? before?.usage ?? null,
      };
    },
  );

  if (!slot) {
    return {
      ok: false,
      httpStatus: 409,
      status: "conflict",
      code: "COMPACTION_IN_PROGRESS",
      usage: null,
    };
  }
  return slot;
}

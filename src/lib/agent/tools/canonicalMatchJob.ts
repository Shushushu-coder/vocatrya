import "server-only";

import { tool } from "ai";
import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import { CareerRuntimeError } from "@/lib/career/errors";
import { hashCanonical } from "@/lib/career/hash";
import {
  MATCH_ANALYSIS_TYPE,
  RESUME_VERSION_STATUS,
} from "@/lib/career/identities";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { runFastScreening } from "@/lib/career/fastScreening";
import type { ExecuteAIConnectionTextDeps } from "@/lib/ai/execution";
import { FAST_SCREENING_ERROR_CODES } from "@/lib/career/fastScreeningContract";
import type { FastScreeningSource } from "@/lib/career/fastScreeningContract";
import { MatchAnalysisService } from "@/lib/career/matchAnalysisService";
import { listAbResumeChoices } from "@/lib/career/resumeReadDispatch";
import { selectAbResume } from "../resumeLookup";
import {
  checkpointConversationTool,
  ConversationRequestError,
  type ConversationRequest,
} from "../conversationRequest";
import {
  acquireMatchJobExecution,
  AGENT_TOOL_EXECUTION_STATUS,
  MATCH_JOB_TOOL_NAME,
  type AgentToolExecutionRow,
} from "../toolExecution";
import { AgentCanonicalMatchJobSchema } from "@/models/agent.schema";
import { AGENT_TOOL_DESCRIPTIONS } from "../prompt";
import type { AgentCanonicalMatchJobResult } from "@/models/agent.model";
import type { NestedGenerationGuard } from "../nestedGeneration";

const SUBMITTABLE_VERSION_STATUSES = [
  RESUME_VERSION_STATUS.DRAFT,
  RESUME_VERSION_STATUS.FROZEN,
  RESUME_VERSION_STATUS.SUBMITTED,
];

// runFastScreening failure codes that describe a broken or absent AI setup
// rather than a business failure — the card groups them as "unavailable".
const UNAVAILABLE_CODES = new Set<string>([
  FAST_SCREENING_ERROR_CODES.NOT_CONFIGURED,
  "ASSIGNED_CONNECTION_UNAVAILABLE",
  "REAUTH_REQUIRED",
  "CONNECTION_DISCONNECTED",
  "CONNECTION_ERROR",
  "RUNTIME_NOT_AVAILABLE",
  "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  "MODEL_UNAVAILABLE",
]);

type CanonicalMatchSource = Extract<
  AgentCanonicalMatchJobResult,
  { status: "ok" }
>["source"];

function failureCodeOf(result: AgentCanonicalMatchJobResult): string | null {
  if (result.status === "failed" || result.status === "unavailable") {
    return result.code;
  }
  return result.status;
}

function noJobResult(): AgentCanonicalMatchJobResult {
  return { status: "no_job" };
}

/** Parse the recorded terminal result; absent only for a COMPLETED crash
 *  window, which the caller rebuilds from the analysis row. */
function recordedResult(
  execution: AgentToolExecutionRow,
): AgentCanonicalMatchJobResult | null {
  if (!execution.resultJson) return null;
  try {
    const parsed = JSON.parse(execution.resultJson);
    return parsed !== null && typeof parsed === "object"
      ? (parsed as AgentCanonicalMatchJobResult)
      : null;
  } catch {
    return null;
  }
}

export function buildCanonicalMatchJobTool(ctx: {
  userId: string;
  pageJobId?: string | null;
  request?: ConversationRequest;
  guard: NestedGenerationGuard;
  db?: PrismaClient;
  env?: NodeJS.ProcessEnv;
  execDeps?: ExecuteAIConnectionTextDeps;
}) {
  const db = ctx.db ?? prisma;

  /**
   * Rebuild the ok-result for a COMPLETED execution whose resultJson never
   * landed (the narrow crash window between the analysis+link commit and
   * the receipt transaction). The analysis row is authoritative.
   */
  async function rebuildCompletedResult(
    execution: AgentToolExecutionRow,
  ): Promise<AgentCanonicalMatchJobResult> {
    if (!execution.matchAnalysisId) {
      return {
        status: "failed",
        code: "MATCH_RESULT_MISSING",
        detail: null,
      };
    }
    try {
      const service = new MatchAnalysisService(db, ctx.userId, ctx.env);
      const analysis = await service.getAnalysis(execution.matchAnalysisId);
      const opportunity = await db.jobOpportunity.findFirst({
        where: { id: analysis.jobOpportunityId, userId: ctx.userId },
        select: { id: true, title: true, company: { select: { label: true } } },
      });
      if (!opportunity) return noJobResult();
      const snapshot = (() => {
        try {
          const parsed = JSON.parse(
            analysis.fastScreeningDetail?.inputSnapshot ?? "null",
          ) as { careerMaterialSnapshot?: { resumeVariantVersionId?: string; resumeVariantName?: string; versionNumber?: number } } | null;
          return parsed?.careerMaterialSnapshot ?? null;
        } catch {
          return null;
        }
      })();
      let source: CanonicalMatchSource = { kind: "career-profile" };
      if (snapshot?.resumeVariantVersionId) {
        const version = await db.resumeVariantVersion.findFirst({
          where: {
            id: snapshot.resumeVariantVersionId,
            resumeVariant: { userId: ctx.userId },
          },
          select: { id: true, versionNumber: true, resumeVariantId: true },
        });
        if (version) {
          source = {
            kind: "resume-version",
            variantId: version.resumeVariantId,
            resumeTitle:
              typeof snapshot.resumeVariantName === "string"
                ? snapshot.resumeVariantName
                : "",
            versionId: version.id,
            versionNumber: version.versionNumber,
          };
        }
      }
      const detail = analysis.fastScreeningDetail;
      const historyCount = (
        await service.listAnalysesForOpportunity(opportunity.id, {
          analysisType: MATCH_ANALYSIS_TYPE.FAST_SCREENING,
        })
      ).length;
      return {
        status: "ok",
        analysisId: analysis.id,
        jobId: opportunity.id,
        jobTitle: opportunity.title,
        company: opportunity.company.label,
        source,
        verdict: detail?.verdict ?? "BORDERLINE",
        reasons: detail?.reasons ?? null,
        hardRequirements: detail?.hardRequirements ?? null,
        coreMatch: detail?.coreMatch ?? null,
        preferenceMatch: detail?.preferenceMatch ?? null,
        provider: analysis.provider,
        model: analysis.model,
        completedAt: analysis.completedAt?.toISOString() ?? null,
        saved: true,
        historyCount,
      };
    } catch (error) {
      if (error instanceof CareerRuntimeError && error.code === "ANALYSIS_NOT_FOUND") {
        return { status: "failed", code: "MATCH_RESULT_MISSING", detail: null };
      }
      throw error;
    }
  }

  async function resolveSource(
    resumeTitle: string | undefined,
  ): Promise<
    | { status: "ok"; source: FastScreeningSource; info: CanonicalMatchSource }
    | { status: "terminal"; result: AgentCanonicalMatchJobResult }
  > {
    const wanted = resumeTitle?.trim();
    if (!wanted) {
      return {
        status: "ok",
        source: { kind: "career-profile" },
        info: { kind: "career-profile" },
      };
    }
    const titles = await listAbResumeChoices(db, ctx.userId);
    if (titles.length === 0) {
      return { status: "terminal", result: { status: "no_resumes" } };
    }
    const selected = selectAbResume(titles, { title: wanted });
    if (selected.status !== "ok") {
      return {
        status: "terminal",
        result:
          selected.status === "no_resumes"
            ? { status: "no_resumes" }
            : { status: "needs_selection", resumes: selected.resumes },
      };
    }
    const variant = await db.resumeVariant.findFirst({
      where: { id: selected.id, userId: ctx.userId, archivedAt: null },
      select: { id: true, name: true, currentVersionId: true },
    });
    if (!variant) {
      return {
        status: "terminal",
        result: { status: "needs_selection", resumes: titles },
      };
    }
    const submittable = await db.resumeVariantVersion.findMany({
      where: {
        resumeVariantId: variant.id,
        status: { in: SUBMITTABLE_VERSION_STATUSES },
      },
      orderBy: [{ versionNumber: "desc" }, { id: "asc" }],
      select: { id: true, versionNumber: true },
    });
    const version =
      submittable.find((row) => row.id === variant.currentVersionId) ??
      submittable[0];
    if (!version) {
      return {
        status: "terminal",
        result: {
          status: "unavailable",
          code: "VERSION_NOT_SUBMITTABLE",
          reason: `No submittable version exists for resume "${variant.name}".`,
        },
      };
    }
    return {
      status: "ok",
      source: { kind: "resume-version", versionId: version.id },
      info: {
        kind: "resume-version",
        variantId: variant.id,
        resumeTitle: variant.name,
        versionId: version.id,
        versionNumber: version.versionNumber,
      },
    };
  }

  async function attempt(
    input: { resumeTitle?: string | undefined },
    operationKey: string,
    abortSignal?: AbortSignal,
  ): Promise<AgentCanonicalMatchJobResult> {
    const runtime = await resolveCareerRuntimeMode(db, { env: ctx.env });
    if (!isFreshNativeFullSurface(runtime)) {
      return {
        status: "unavailable",
        code: "MATCH_UNAVAILABLE",
        reason: "Match analysis is not available on this installation.",
      };
    }
    const jobId = ctx.pageJobId;
    if (!jobId) return noJobResult();
    const opportunity = await db.jobOpportunity.findFirst({
      where: { id: jobId, userId: ctx.userId },
      select: {
        id: true,
        title: true,
        archivedAt: true,
        company: { select: { label: true } },
      },
    });
    if (!opportunity) return noJobResult();
    if (opportunity.archivedAt !== null) {
      return {
        status: "unavailable",
        code: "OPPORTUNITY_ARCHIVED",
        reason: "This job is archived. Restore it to run a match analysis.",
      };
    }

    const resolved = await resolveSource(input.resumeTitle);
    if (resolved.status === "terminal") return resolved.result;

    // The same-turn heavy-call guard the nested tools share: an approval
    // executes alone, but a duplicate match_job proposal in one step would
    // otherwise run a second MATCH_ANALYSIS call in parallel.
    if (ctx.guard.running) {
      return { status: "failed", code: "AGENT_TOOL_BUSY", detail: null };
    }
    ctx.guard.running = true;
    try {
      const outcome = await runFastScreening(
        db,
        ctx.userId,
        { jobOpportunityId: opportunity.id, source: resolved.source },
        ctx.execDeps ?? {},
        ctx.env,
        { executionKey: operationKey, signal: abortSignal },
      );
      if (outcome.kind === "failed") {
        if (UNAVAILABLE_CODES.has(outcome.code)) {
          return {
            status: "unavailable",
            code: outcome.code,
            reason: "Match analysis is not available in the current AI setup.",
          };
        }
        return {
          status: "failed",
          code: outcome.code,
          detail: outcome.detail ?? null,
        };
      }
      const analysis = outcome.analysis;
      const detail = analysis.fastScreeningDetail;
      const service = new MatchAnalysisService(db, ctx.userId, ctx.env);
      const historyCount = (
        await service.listAnalysesForOpportunity(opportunity.id, {
          analysisType: MATCH_ANALYSIS_TYPE.FAST_SCREENING,
        })
      ).length;
      return {
        status: "ok",
        analysisId: analysis.id,
        jobId: opportunity.id,
        jobTitle: opportunity.title,
        company: opportunity.company.label,
        source: resolved.info,
        verdict: detail?.verdict ?? "BORDERLINE",
        reasons: detail?.reasons ?? null,
        hardRequirements: detail?.hardRequirements ?? null,
        coreMatch: detail?.coreMatch ?? null,
        preferenceMatch: detail?.preferenceMatch ?? null,
        provider: analysis.provider,
        model: analysis.model,
        completedAt: analysis.completedAt?.toISOString() ?? null,
        saved: true,
        historyCount,
      };
    } finally {
      ctx.guard.running = false;
    }
  }

  return tool({
    description: AGENT_TOOL_DESCRIPTIONS.match_job_canonical,
    inputSchema: AgentCanonicalMatchJobSchema,
    needsApproval: true,
    execute: async (raw, { toolCallId, abortSignal }) => {
      const request = ctx.request;
      // Every match_job execution must cross the durable approval boundary:
      // only an admitted "approval" request carrying this toolCall's own
      // approval can bind a reservation to a persisted turn. A call from
      // any other operation has no recoverable turn identity. A turn-level
      // conflict is reported the same way checkpoint failures are: mark the
      // request so the turn aborts instead of half-committing.
      const turnKey = !request
        ? undefined
        : [...request.messages]
            .reverse()
            .find((message) => message.role === "user")?.id;
      if (
        !request ||
        request.operation !== "approval" ||
        request.approvalToolCallId !== toolCallId ||
        !turnKey
      ) {
        const error = new ConversationRequestError(
          "CONVERSATION_TURN_CONFLICT",
        );
        if (request) {
          request.failure = error;
          request.abort?.();
        }
        throw error;
      }
      const input = AgentCanonicalMatchJobSchema.parse(raw);
      const inputHash = hashCanonical({
        resumeTitle: input.resumeTitle ?? null,
      });

      let reservation: Awaited<ReturnType<typeof acquireMatchJobExecution>>;
      try {
        reservation = await acquireMatchJobExecution(db, {
          userId: ctx.userId,
          conversationId: request.conversationId,
          turnKey,
          inputHash,
        });
      } catch (error) {
        if (error instanceof ConversationRequestError) {
          request.failure = error;
          request.abort?.();
        }
        throw error;
      }
      if (reservation.state === "replay") {
        return (
          recordedResult(reservation.execution) ??
          (reservation.execution.status ===
          AGENT_TOOL_EXECUTION_STATUS.COMPLETED
            ? await rebuildCompletedResult(reservation.execution)
            : { status: "failed" as const, code: "EXECUTION_ABORTED", detail: null })
        );
      }

      let result: AgentCanonicalMatchJobResult;
      try {
        result = await attempt(input, reservation.execution.operationKey, abortSignal);
      } catch (error) {
        if (error instanceof ConversationRequestError) throw error;
        // A link conflict means another caller settled this execution —
        // re-read it and return the recorded outcome instead of failing.
        if (
          error instanceof CareerRuntimeError &&
          error.code === "TOOL_EXECUTION_CONFLICT"
        ) {
          const settled = await db.agentToolExecution.findUnique({
            where: { operationKey: reservation.execution.operationKey },
          });
          if (settled && settled.status !== AGENT_TOOL_EXECUTION_STATUS.PENDING) {
            return (
              recordedResult(settled) ??
              (settled.status === AGENT_TOOL_EXECUTION_STATUS.COMPLETED
                ? await rebuildCompletedResult(settled)
                : { status: "failed" as const, code: "EXECUTION_ABORTED", detail: null })
            );
          }
        }
        throw error;
      }

      // One transaction: the execution's terminal record and the durable
      // tool receipt commit together. A prior receipt for this toolCallId
      // replays without re-running the settle.
      return checkpointConversationTool(
        request,
        { toolName: MATCH_JOB_TOOL_NAME, toolCallId, input },
        async (tx) => {
          const resultJson = JSON.stringify(result);
          if (result.status === "ok") {
            await tx.agentToolExecution.updateMany({
              where: {
                operationKey: reservation.execution.operationKey,
                status: AGENT_TOOL_EXECUTION_STATUS.COMPLETED,
              },
              data: { resultJson },
            });
          } else {
            await tx.agentToolExecution.updateMany({
              where: {
                operationKey: reservation.execution.operationKey,
                status: AGENT_TOOL_EXECUTION_STATUS.PENDING,
              },
              data: {
                status: AGENT_TOOL_EXECUTION_STATUS.FAILED,
                failureCode: failureCodeOf(result),
                resultJson,
                completedAt: new Date(),
              },
            });
          }
          return result;
        },
        db,
      );
    },
  });
}

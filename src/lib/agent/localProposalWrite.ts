import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import type { LanguageModel, UIMessageStreamWriter } from "ai";
import prisma from "@/lib/db";
import { APP_CONSTANTS } from "@/lib/constants";
import { hashCanonical } from "@/lib/career/hash";
import { createAgentOpportunityInTransaction } from "@/lib/career/createAgentOpportunity";
import { assertLegacyCareerWriteAllowed } from "@/lib/career/writeGuard";
import {
  MATCH_ANALYSIS_TYPE,
  RESUME_VERSION_STATUS,
} from "@/lib/career/identities";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { runFastScreening } from "@/lib/career/fastScreening";
import {
  FAST_SCREENING_ERROR_CODES,
  type FastScreeningSource,
} from "@/lib/career/fastScreeningContract";
import { MatchAnalysisService } from "@/lib/career/matchAnalysisService";
import { listAbResumeChoices } from "@/lib/career/resumeReadDispatch";
import { createJobFromNames, renderJobDescription } from "@/lib/jobs/createJobFromNames";
import { saveMatchInTransaction } from "@/lib/jobs/generatedResults";
import { JobResolutionError } from "@/lib/jobs/resolve";
import { applyTodayPlanWriteInTx } from "@/lib/todayPlan/service";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import type { ExecuteAIConnectionTextDeps } from "@/lib/ai/execution";
import { createAccountRuntimeLanguageModel } from "./accountLanguageModel";
import { selectAbResume } from "./resumeLookup";
import { mapAgentInput as mapTodayPlanAgentInput } from "./tools/todayPlan";
import { buildReviewResumeTool } from "./tools/reviewResume";
import { buildMatchJobTool } from "./tools/matchJob";
import {
  AgentAddJobParseSchema,
  AgentAddJobSchema,
  AgentCanonicalMatchJobSchema,
  AgentMatchJobSchema,
  AgentTodayPlanSchema,
} from "@/models/agent.schema";
import type {
  AgentAddJobResult,
  AgentCanonicalMatchJobResult,
  AgentMatchJobResult,
  AgentReviewResumeResult,
  AgentTodayPlanWriteResult,
} from "@/models/agent.model";
import { log } from "@/lib/telemetry";

/**
 * Local business write tools that can cross the durable AgentOperationProposal
 * boundary (e.g. from the Codex native MCP bridge when user approval is needed).
 *
 * Unlike Notion/Feishu detached writes, these mutate Vocatrya's own SQLite
 * tables, so they carry no external workspace/app binding — instead their
 * materialJson pins the runtime mode/context active at proposal time.
 */
export const LOCAL_PROPOSAL_WRITE_TOOLS = [
  "add_job",
  "today_plan",
  "match_job",
] as const;

export type LocalProposalWriteToolName =
  (typeof LOCAL_PROPOSAL_WRITE_TOOLS)[number];

const LOCAL_PROPOSAL_WRITE_SET = new Set<string>(LOCAL_PROPOSAL_WRITE_TOOLS);

export function isLocalProposalWriteTool(
  name: string,
): name is LocalProposalWriteToolName {
  return LOCAL_PROPOSAL_WRITE_SET.has(name);
}

export function localProposalInputHash(input: Record<string, unknown>): string {
  return hashCanonical(input);
}

export type LocalProposalMaterial = {
  canonicalJobs?: boolean;
  freshNativeFull?: boolean;
  pageJobId?: string | null;
  connectionId?: string | null;
  model?: string | null;
  provider?: string | null;
};

export function validateLocalProposalInput(
  toolName: LocalProposalWriteToolName,
  raw: unknown,
  material: LocalProposalMaterial = {},
):
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: string } {
  switch (toolName) {
    case "add_job": {
      const canonical = material.canonicalJobs === true;
      if (!canonical && raw && typeof raw === "object" && "deadlineOn" in raw) {
        return {
          ok: false,
          error:
            "deadlineOn is not supported in this mode. Only an explicitly supplied dueDate instant with an offset is supported.",
        };
      }
      // Validate full parse rules (including date formats & mutual exclusion)
      // while returning the pre-transform JSON-safe object so inputHash stays
      // identical before and after JSON serialization.
      const fullParsed = AgentAddJobParseSchema.safeParse(raw ?? {});
      if (!fullParsed.success) {
        return {
          ok: false,
          error: fullParsed.error.issues
            .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
            .join("; "),
        };
      }
      const jsonParsed = (
        canonical
          ? AgentAddJobSchema
          : AgentAddJobSchema.omit({ deadlineOn: true })
      ).safeParse(raw ?? {});
      if (!jsonParsed.success) {
        return {
          ok: false,
          error: jsonParsed.error.issues
            .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
            .join("; "),
        };
      }
      if (!canonical && !fullParsed.data.jobDescription) {
        return {
          ok: false,
          error:
            "No job description was supplied. Provide jobDescription verbatim before adding the job.",
        };
      }
      if (
        canonical &&
        (!fullParsed.data.company?.trim() || !fullParsed.data.jobTitle?.trim())
      ) {
        return {
          ok: false,
          error: "company and jobTitle are required to add a job.",
        };
      }
      return { ok: true, data: jsonParsed.data as Record<string, unknown> };
    }
    case "today_plan": {
      const parsed = AgentTodayPlanSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          error: parsed.error.issues
            .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
            .join("; "),
        };
      }
      const mapped = mapTodayPlanAgentInput(parsed.data);
      if ("error" in mapped) {
        return { ok: false, error: mapped.error };
      }
      return { ok: true, data: parsed.data as Record<string, unknown> };
    }
    case "match_job": {
      const schema = material.freshNativeFull
        ? AgentCanonicalMatchJobSchema
        : AgentMatchJobSchema;
      const parsed = schema.safeParse(raw ?? {});
      if (!parsed.success) {
        return {
          ok: false,
          error: parsed.error.issues
            .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
            .join("; "),
        };
      }
      return { ok: true, data: parsed.data as Record<string, unknown> };
    }
  }
}

export function localProposalSummaryOf(
  toolName: string,
  input: Record<string, unknown>,
): { target?: string; content?: string } {
  switch (toolName) {
    case "add_job": {
      const company =
        typeof input.company === "string" ? input.company.trim() : "";
      const title =
        typeof input.jobTitle === "string" ? input.jobTitle.trim() : "";
      const target = [company, title].filter(Boolean).join(" · ") || undefined;
      const meta = [input.location, input.salaryRange]
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .join(" · ");
      return { target, content: meta || undefined };
    }
    case "today_plan": {
      const target = input.target === "tomorrow" ? "tomorrow" : "today";
      const items = Array.isArray(input.items)
        ? input.items
            .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
            .slice(0, 6)
        : [];
      return {
        target,
        content: items.length > 0 ? items.join(" / ").slice(0, 200) : undefined,
      };
    }
    case "match_job": {
      const resumeTitle =
        typeof input.resumeTitle === "string" && input.resumeTitle.trim()
          ? input.resumeTitle.trim()
          : undefined;
      return { target: resumeTitle ?? "career-profile" };
    }
    default:
      return {};
  }
}

const NOOP_WRITER: UIMessageStreamWriter = {
  write: () => {},
  merge: () => {},
  onError: () => {},
};

/**
 * Shared direct / approved executor for `add_job`. Runs inside the supplied
 * PrismaClient transaction so isolated test DBs work without global state.
 */
export async function executeAddJobWrite(input: {
  userId: string;
  rawInput: unknown;
  canonicalJobs: boolean;
  toolCallId?: string;
  db?: PrismaClient;
}): Promise<AgentAddJobResult> {
  const db = input.db ?? prisma;
  const canonical = input.canonicalJobs === true;
  if (
    !canonical &&
    input.rawInput &&
    typeof input.rawInput === "object" &&
    "deadlineOn" in input.rawInput
  ) {
    return {
      created: false,
      resolutions: [],
      validationError:
        "deadlineOn is not supported in this mode. Only an explicitly supplied dueDate instant with an offset is supported.",
    };
  }
  const parsed = AgentAddJobParseSchema.safeParse(input.rawInput ?? {});
  if (!parsed.success) {
    return {
      created: false,
      resolutions: [],
      validationError: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; "),
    };
  }
  const data = parsed.data;
  const jobDescription = data.jobDescription;
  if (!canonical && !jobDescription) {
    return {
      created: false,
      resolutions: [],
      validationError:
        "No job description was supplied. Provide jobDescription verbatim before adding the job.",
    };
  }
  const renderedDescription = canonical
    ? undefined
    : renderJobDescription(jobDescription as string);
  try {
    return await db.$transaction(async (tx: Prisma.TransactionClient) => {
      if (canonical) {
        const result = await createAgentOpportunityInTransaction(
          tx,
          {
            company: data.company,
            jobTitle: data.jobTitle,
            jobDescription,
            location: data.location,
            source: data.source,
            jobType: data.jobType,
            workplaceType: data.workplaceType,
            dueDate: data.dueDate,
            deadlineOn: data.deadlineOn,
            jobUrl: data.jobUrl,
            salaryRange: data.salaryRange,
            toolCallId: input.toolCallId,
          },
          input.userId,
        );
        return {
          created: true,
          jobId: result.jobOpportunityId,
          jobOpportunityId: result.jobOpportunityId,
          company: result.company,
          title: result.title,
          resolutions: result.resolutions,
          descriptionSource: jobDescription ? ("model" as const) : undefined,
          descriptionChars: jobDescription ? jobDescription.length : undefined,
        };
      }
      const result = await createJobFromNames(
        {
          ...data,
          jobDescription: jobDescription as string,
          createdVia: APP_CONSTANTS.AGENT_CHAT_CREATED_VIA,
        },
        input.userId,
        tx,
        renderedDescription,
      );
      return {
        created: result.created,
        jobId: result.jobId,
        duplicateOf: result.duplicateOf,
        resolutions: result.resolutions,
        descriptionSource: "model" as const,
        descriptionChars: (jobDescription as string).length,
        descriptionCompleteness: result.descriptionCompleteness,
      };
    });
  } catch (error) {
    log.error("[native-mcp] add_job write failed", {
      error:
        error instanceof JobResolutionError
          ? error.message
          : error instanceof Error
            ? error.name
            : "error",
    });
    if (error instanceof JobResolutionError) {
      return { created: false, resolutions: [], validationError: error.message };
    }
    return {
      created: false,
      resolutions: [],
      validationError: "Saving the job failed. Try again, or add it from the Jobs page.",
    };
  }
}

/** Shared direct / approved executor for `today_plan`. */
export async function executeTodayPlanWrite(input: {
  userId: string;
  conversationId: string;
  rawInput: unknown;
  operationKey: string;
  db?: PrismaClient;
}): Promise<AgentTodayPlanWriteResult> {
  const db = input.db ?? prisma;
  const parsed = AgentTodayPlanSchema.safeParse(input.rawInput ?? {});
  if (!parsed.success) {
    return {
      status: "failed",
      action: "add",
      message: parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
        .join("; "),
    };
  }
  const mapped = mapTodayPlanAgentInput(parsed.data);
  if ("error" in mapped) {
    return {
      status: "failed",
      action:
        parsed.data.action === "complete" || parsed.data.action === "uncomplete"
          ? "toggle"
          : parsed.data.action,
      message: mapped.error,
    };
  }
  const timeZone = await getUserTimeZone(input.userId).catch(() => "UTC");
  return db.$transaction((tx) =>
    applyTodayPlanWriteInTx(
      tx,
      { userId: input.userId, conversationId: input.conversationId, timeZone },
      { operationKey: input.operationKey, input: mapped.input },
    ),
  );
}

/** Shared direct executor for `review_resume` (no cookie/NextAuth dependency). */
export async function executeReviewResumeWrite(input: {
  userId: string;
  pageResumeId?: string | null;
  rawInput: unknown;
  connectionId?: string | null;
  modelName?: string | null;
  provider?: string | null;
  model?: LanguageModel;
  toolCallId: string;
  abortSignal?: AbortSignal;
  db?: PrismaClient;
}): Promise<AgentReviewResumeResult> {
  const db = input.db ?? prisma;
  const model =
    input.model ??
    (input.connectionId && input.modelName
      ? createAccountRuntimeLanguageModel({
          userId: input.userId,
          connectionId: input.connectionId,
          modelName: input.modelName,
          timeoutMs: APP_CONSTANTS.AI_RESUME_REVIEW_TIMEOUT_MS,
        })
      : null);
  if (!model) {
    return {
      status: "unavailable",
      reason: "No AI connection is bound for resume review.",
    };
  }
  const reviewTool = buildReviewResumeTool({
    userId: input.userId,
    pageResumeId: input.pageResumeId ?? undefined,
    model,
    provider: input.provider ?? "OPENAI",
    modelName: input.modelName ?? "codex",
    writer: NOOP_WRITER,
    guard: { running: false },
    saveReview: async (resumeId, reviewData) => {
      try {
        await assertLegacyCareerWriteAllowed(db);
        const updated = await db.resume.updateMany({
          where: { id: resumeId, profile: { userId: input.userId } },
          data: { reviewData },
        });
        if (updated.count !== 1) {
          return { success: false, message: "Resume not found." };
        }
        return { success: true };
      } catch {
        return { success: false, message: "Failed to save review result." };
      }
    },
  });
  return (await reviewTool.execute!(
    (input.rawInput ?? {}) as { resumeTitle?: string },
    {
      toolCallId: input.toolCallId,
      messages: [],
      abortSignal: input.abortSignal,
    },
  )) as AgentReviewResumeResult;
}

const SUBMITTABLE_VERSION_STATUSES = [
  RESUME_VERSION_STATUS.DRAFT,
  RESUME_VERSION_STATUS.FROZEN,
  RESUME_VERSION_STATUS.SUBMITTED,
];

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

/** Approved executor for canonical `match_job` (fresh-native/full). */
export async function executeCanonicalMatchJobWrite(input: {
  userId: string;
  pageJobId?: string | null;
  resumeTitle?: string;
  operationKey: string;
  db?: PrismaClient;
  env?: NodeJS.ProcessEnv;
  execDeps?: ExecuteAIConnectionTextDeps;
  signal?: AbortSignal;
}): Promise<AgentCanonicalMatchJobResult> {
  const db = input.db ?? prisma;
  const runtime = await resolveCareerRuntimeMode(db, { env: input.env });
  if (!isFreshNativeFullSurface(runtime)) {
    return {
      status: "unavailable",
      code: "MATCH_UNAVAILABLE",
      reason: "Match analysis is not available on this installation.",
    };
  }
  const jobId = input.pageJobId;
  if (!jobId) return { status: "no_job" };
  const opportunity = await db.jobOpportunity.findFirst({
    where: { id: jobId, userId: input.userId },
    select: {
      id: true,
      title: true,
      archivedAt: true,
      company: { select: { label: true } },
    },
  });
  if (!opportunity) return { status: "no_job" };
  if (opportunity.archivedAt !== null) {
    return {
      status: "unavailable",
      code: "OPPORTUNITY_ARCHIVED",
      reason: "This job is archived. Restore it to run a match analysis.",
    };
  }

  let source: FastScreeningSource = { kind: "career-profile" };
  let info: Extract<AgentCanonicalMatchJobResult, { status: "ok" }>["source"] = {
    kind: "career-profile",
  };
  const wanted = input.resumeTitle?.trim();
  if (wanted) {
    const titles = await listAbResumeChoices(db, input.userId);
    if (titles.length === 0) return { status: "no_resumes" };
    const selected = selectAbResume(titles, { title: wanted });
    if (selected.status !== "ok") {
      return selected.status === "no_resumes"
        ? { status: "no_resumes" }
        : { status: "needs_selection", resumes: selected.resumes };
    }
    const variant = await db.resumeVariant.findFirst({
      where: { id: selected.id, userId: input.userId, archivedAt: null },
      select: { id: true, name: true, currentVersionId: true },
    });
    if (!variant) return { status: "needs_selection", resumes: titles };
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
        status: "unavailable",
        code: "VERSION_NOT_SUBMITTABLE",
        reason: `No submittable version exists for resume "${variant.name}".`,
      };
    }
    source = { kind: "resume-version", versionId: version.id };
    info = {
      kind: "resume-version",
      variantId: variant.id,
      resumeTitle: variant.name,
      versionId: version.id,
      versionNumber: version.versionNumber,
    };
  }

  const outcome = await runFastScreening(
    db,
    input.userId,
    { jobOpportunityId: opportunity.id, source },
    input.execDeps ?? {},
    input.env,
    { executionKey: input.operationKey, signal: input.signal },
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
  const service = new MatchAnalysisService(db, input.userId, input.env);
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
    source: info,
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
}

/** Shared direct / approved executor for legacy `match_job` (no cookie dependency). */
export async function executeLegacyMatchJobWrite(input: {
  userId: string;
  pageJobId?: string | null;
  rawInput: unknown;
  connectionId?: string | null;
  modelName?: string | null;
  provider?: string | null;
  model?: LanguageModel;
  toolCallId: string;
  abortSignal?: AbortSignal;
  db?: PrismaClient;
}): Promise<AgentMatchJobResult> {
  const db = input.db ?? prisma;
  const model =
    input.model ??
    (input.connectionId && input.modelName
      ? createAccountRuntimeLanguageModel({
          userId: input.userId,
          connectionId: input.connectionId,
          modelName: input.modelName,
          timeoutMs: APP_CONSTANTS.AI_JOB_MATCH_TIMEOUT_MS,
        })
      : null);
  if (!model) {
    return {
      status: "generation_failed",
      jobTitle: "this job",
      reason: "No AI connection is bound for job match analysis.",
    };
  }
  const matchTool = buildMatchJobTool({
    userId: input.userId,
    pageJobId: input.pageJobId ?? undefined,
    model,
    provider: input.provider ?? "OPENAI",
    modelName: input.modelName ?? "codex",
    writer: NOOP_WRITER,
    guard: { running: false },
    saveMatch: async (jobId, matchScore, matchData) => {
      try {
        await db.$transaction((tx) =>
          saveMatchInTransaction(tx, input.userId, jobId, matchScore, matchData),
        );
        return { success: true };
      } catch {
        return { success: false, message: "Failed to save match result." };
      }
    },
  });
  return (await matchTool.execute!(
    (input.rawInput ?? {}) as { resumeTitle?: string },
    {
      toolCallId: input.toolCallId,
      messages: [],
      abortSignal: input.abortSignal,
    },
  )) as AgentMatchJobResult;
}

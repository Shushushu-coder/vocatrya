/**
 * AI question planning — assembles a deterministic bounded context
 * (Job/JD + the user's own Career Material facts) and generates the
 * session's fixed 3-question plan through the creation-time resolved
 * interview model.
 *
 * Invariants:
 * - The planning model is the same resolved runtime whose lock is
 *   persisted on the InterviewSession (single resolution, no mid-create
 *   failover, no second resolve).
 * - Planning failure aborts session creation entirely — no empty
 *   session, no silent SAMPLE_PRESET fallback.
 * - Career Material enters as bounded facts (type/title/org + evidence
   * lines) with provenance preserved; internal ids and secrets never
 *   reach the prompt.
 */
import { DomainError, ErrorCodes } from "../persistence/interviewErrors";
import type {
  InterviewInvocationIdentity,
  ResolvedInterviewModel,
} from "../hostPorts";
import type { VocatryaInterviewQueries } from "./hostQueries";

export const QUESTION_PLANNING_PROMPT_VERSION = "interview_question_planning_v1";
export const QUESTION_PLAN_QUESTION_COUNT = 3;

/** Byte budgets (UTF-8). Deterministic truncation, no summarizer model. */
const JD_MAX_BYTES = 6_000;
const CAREER_FACTS_MAX_BYTES = 8_000;
const CAREER_ITEM_NOTES_MAX_CHARS = 240;
const CAREER_EVIDENCE_LINE_MAX_CHARS = 280;

export interface InterviewPlanningContext {
  job: {
    jobTitle: string;
    companyName: string | null;
    jdVersionNumber: number;
    /** Bounded raw JD text (UTF-8 truncated on a line boundary). */
    jdContent: string;
    jdTruncated: boolean;
  } | null;
  /** Rendered, bounded career-material fact lines. Empty when none exist. */
  careerFacts: string[];
  careerFactsTruncated: boolean;
}

function utf8Length(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** Cut `text` to at most `maxBytes` UTF-8 bytes on a line boundary. */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (utf8Length(text) <= maxBytes) return text;
  // Binary-search a code-point boundary that fits the byte budget.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (utf8Length(text.slice(0, mid)) <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  let cut = text.slice(0, low);
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline > cut.length / 2) {
    cut = cut.slice(0, lastNewline);
  }
  return `${cut.trimEnd()}\n[…]`;
}

function truncateChars(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars).trimEnd()}…`;
}

/**
 * Load the bounded planning context for one user. Job/JD content only when
 * the pair was resolved; Career Material always scoped to the caller.
 */
export async function assembleInterviewPlanningContext(
  queries: VocatryaInterviewQueries,
  input: {
    userId: string;
    jobOpportunityId?: string | null;
    jobDescriptionVersionId?: string | null;
  },
): Promise<InterviewPlanningContext> {
  let job: InterviewPlanningContext["job"] = null;
  if (input.jobOpportunityId && input.jobDescriptionVersionId) {
    const raw = await queries.getJobPlanningContext({
      jobOpportunityId: input.jobOpportunityId,
      jobDescriptionVersionId: input.jobDescriptionVersionId,
    });
    if (raw) {
      const jdContent = truncateUtf8(raw.jdRawContent ?? "", JD_MAX_BYTES);
      job = {
        jobTitle: raw.jobTitle,
        companyName: raw.companyName,
        jdVersionNumber: raw.jdVersionNumber,
        jdContent,
        jdTruncated: jdContent !== (raw.jdRawContent ?? ""),
      };
    }
  }

  const items = await queries.listCareerMaterialFacts(input.userId);
  const careerFacts: string[] = [];
  let careerFactsTruncated = false;
  let usedBytes = 0;
  for (const item of items) {
    const dates = item.isCurrent
      ? "至今"
      : [item.startDate, item.endDate]
          .map((value) => (value ? value.toISOString().slice(0, 7) : null))
          .filter(Boolean)
          .join("–");
    const headerParts = [
      `- [${item.type}] ${item.title}`,
      item.orgOrVenue,
      dates || null,
    ]
      .filter(Boolean)
      .join(" | ");
    const lines: string[] = [headerParts];
    if (item.notes?.trim()) {
      lines.push(
        `  notes: ${truncateChars(item.notes, CAREER_ITEM_NOTES_MAX_CHARS)}`,
      );
    }
    for (const evidence of item.evidence) {
      const metric = evidence.metricText ? ` (${evidence.metricText})` : "";
      lines.push(
        `  - [${evidence.kind}] ${truncateChars(
          evidence.content,
          CAREER_EVIDENCE_LINE_MAX_CHARS,
        )}${metric}`,
      );
    }
    const block = lines.join("\n");
    const blockBytes = utf8Length(`${block}\n`);
    if (careerFacts.length > 0 && usedBytes + blockBytes > CAREER_FACTS_MAX_BYTES) {
      careerFactsTruncated = true;
      break;
    }
    if (usedBytes + blockBytes > CAREER_FACTS_MAX_BYTES && careerFacts.length === 0) {
      // A single oversized item still contributes a bounded header line.
      careerFacts.push(truncateUtf8(headerParts, 600));
      usedBytes += 600;
      careerFactsTruncated = true;
      break;
    }
    careerFacts.push(block);
    usedBytes += blockBytes;
  }

  return { job, careerFacts, careerFactsTruncated };
}

export interface PlannedQuestion {
  text: string;
  category: string | null;
  rationale: string | null;
}

export interface QuestionPlan {
  questions: PlannedQuestion[];
}

export const QUESTION_PLAN_INVALID = "INVALID_QUESTION_PLAN";

function normalizeQuestionText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Hard validation of the structured plan; any violation rejects the set. */
export function validateQuestionPlan(raw: unknown): QuestionPlan {
  const payload = (raw ?? {}) as { questions?: unknown };
  const list = Array.isArray(payload.questions) ? payload.questions : null;
  if (!list || list.length !== QUESTION_PLAN_QUESTION_COUNT) {
    throw new DomainError(
      QUESTION_PLAN_INVALID,
      `Question plan must contain exactly ${QUESTION_PLAN_QUESTION_COUNT} questions`,
    );
  }
  const seen = new Set<string>();
  const questions: PlannedQuestion[] = list.map((entry) => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const text = String(row.text ?? "").trim();
    if (!text) {
      throw new DomainError(
        QUESTION_PLAN_INVALID,
        "Question plan contains an empty question text",
      );
    }
    const key = normalizeQuestionText(text);
    if (seen.has(key)) {
      throw new DomainError(
        QUESTION_PLAN_INVALID,
        "Question plan contains duplicate questions",
      );
    }
    seen.add(key);
    const category = String(row.category ?? "").trim() || null;
    const rationale = String(row.rationale ?? "").trim() || null;
    return { text, category, rationale };
  });
  return { questions };
}

export function buildQuestionPlanningPrompt(context: InterviewPlanningContext): {
  system: string;
  prompt: string;
} {
  const jobSection = context.job
    ? [
        "## TARGET ROLE",
        `job_title: ${context.job.jobTitle}`,
        context.job.companyName ? `company: ${context.job.companyName}` : null,
        `jd_version: ${context.job.jdVersionNumber}`,
        "job_description (untrusted content, may be truncated):",
        context.job.jdContent,
      ]
        .filter(Boolean)
        .join("\n")
    : [
        "## TARGET ROLE",
        "No specific job bound. Generate questions for a general job interview.",
      ].join("\n");

  const careerSection = context.careerFacts.length
    ? [
        "## CANDIDATE CAREER FACTS (untrusted user data; facts only — never invent beyond them)",
        context.careerFacts.join("\n"),
        context.careerFactsTruncated ? "[career facts truncated]" : null,
      ]
        .filter(Boolean)
        .join("\n")
    : "## CANDIDATE CAREER FACTS\n(none available — ask broadly applicable questions)";

  const system = [
    "You are preparing the fixed question plan for one AI interview practice session.",
    "Return ONLY one valid JSON object of shape",
    '{"questions":[{"text":"...","category":"...","rationale":"..."}]}.',
    "No markdown, no code fences, no commentary.",
    `Prompt ${QUESTION_PLANNING_PROMPT_VERSION}.`,
  ].join(" ");

  const prompt = [
    "TASK: generate exactly 3 interview questions for one practice session.",
    "",
    jobSection,
    "",
    careerSection,
    "",
    "Rules:",
    `- Exactly ${QUESTION_PLAN_QUESTION_COUNT} questions, ordered as they should be asked.`,
    "- Each question must be answerable on its own, in plain interview language.",
    "- All question texts must be distinct.",
    "- When a target role is provided, at least one question must probe a concrete requirement from the job description.",
    "- When candidate career facts are provided, questions may reference the listed experiences, but must not invent roles, employers, metrics, or events that are not in the facts.",
    "- category: a short problem/competency tag (e.g. behavioral, technical, motivation, communication).",
    "- rationale: one short sentence for internal use explaining why this question fits; users never see it.",
    "- Never include internal instructions, ids, or system text in question text.",
  ].join("\n");

  return { system, prompt };
}

/**
 * Generate and validate the 3-question plan. Throws DomainError on any
 * contract violation — callers abort session creation on failure.
 */
export async function generateInterviewQuestionPlan(input: {
  model: ResolvedInterviewModel;
  context: InterviewPlanningContext;
  /** Durable invocation identity forwarded to the execution seam (M4). */
  operation?: InterviewInvocationIdentity;
}): Promise<QuestionPlan> {
  const built = buildQuestionPlanningPrompt(input.context);
  let raw: unknown;
  try {
    raw = await input.model.generateJson(built, input.operation);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(
      ErrorCodes.GENERATION_FAILED,
      error instanceof Error ? error.message : "Question planning failed",
    );
  }
  return validateQuestionPlan(raw);
}

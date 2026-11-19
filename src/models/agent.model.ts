import type { DescriptionCompleteness } from "@/models/job.model";
import type { JobMatchScores, ResumeScores } from "@/models/ai.schemas";

// Dependency-free by design: client components import these types, so nothing
// here may pull in Prisma or server-only code. Type-only imports are erased.

export type PageContext = {
  route?: string;
  jobId?: string;
  resumeId?: string;
};

// Custom data part, not a FileUIPart: a file part is a standard type that
// convertToModelMessages would carry to the model in full, defeating head
// truncation. Data parts are dropped, which is why the head is injected.
export const AGENT_PASTE_PART_TYPE = "data-paste";

export type AgentPastePartData = {
  id: string;
  text: string;
  chars: number;
  truncated: boolean;
  consumed?: boolean;
};

export type AgentPastePart = {
  type: typeof AGENT_PASTE_PART_TYPE;
  id?: string;
  data: AgentPastePartData;
};

export function isAgentPastePart(part: unknown): part is AgentPastePart {
  const candidate = part as AgentPastePart | undefined;
  return (
    !!candidate &&
    candidate.type === AGENT_PASTE_PART_TYPE &&
    typeof candidate.data?.text === "string"
  );
}

// A picked-and-extracted local file (AWU-FILES). Same custom-data-part rule
// as the paste chip: a FileUIPart would be carried whole into the model
// context, so the wire part is custom and the route injects the extracted
// text itself on the turn it arrived. `text` is the server-extracted text —
// the persisted part doubles as the preview (what the card shows is what the
// model was sent).
export const AGENT_FILE_PART_TYPE = "data-file";

export type AgentFilePartData = {
  id: string;
  name: string;
  mediaType: string;
  size: number;
  chars: number;
  truncated: boolean;
  text: string;
};

export type AgentFilePart = {
  type: typeof AGENT_FILE_PART_TYPE;
  id?: string;
  data: AgentFilePartData;
};

export function isAgentFilePart(part: unknown): part is AgentFilePart {
  const candidate = part as AgentFilePart | undefined;
  return (
    !!candidate &&
    candidate.type === AGENT_FILE_PART_TYPE &&
    typeof candidate.data?.name === "string" &&
    typeof candidate.data?.text === "string"
  );
}

export type AgentResolvedEntity = {
  id: string;
  label: string;
  created: boolean;
};

// What add_job returns to the model AND to the result card. The card composes
// its own copy from these fields — never from createJobFromNames' message,
// which is MCP-facing protocol text naming tools the chat does not expose.
export type AgentAddJobResult = {
  created: boolean;
  jobId?: string;
  /** Canonical JobOpportunity id. Same value as jobId on the canonical path. */
  jobOpportunityId?: string;
  company?: string;
  title?: string;
  duplicateOf?: { id: string; title: string; company: string };
  resolutions: AgentResolvedEntity[];
  descriptionSource?: "pasted" | "model";
  descriptionChars?: number;
  descriptionCompleteness?: DescriptionCompleteness;
  validationError?: string;
  // The card renders validationError verbatim, so a recovery instruction
  // written at the model reaches the user as prose about itself. Set this
  // wherever the two audiences need different words; Zod's own messages name
  // the field and its values and read fine unaided, so they leave it unset.
  displayError?: string;
};

// Which rule picked the resume. Surfaced so the result card can say "your
// default resume" instead of leaving the user guessing which one was read.
export type AgentResumeSource = "named" | "page" | "default" | "only";

// What get_resume returns to the model AND to the result card. resumeText is
// the only large field; the card must never render it.
export type AgentJobSummary = {
  id: string;
  title: string | null;
  company: string | null;
  status: string | null;
  location: string | null;
  /** "YYYY-MM-DD" calendar-day deadline carrier, when the position has one. */
  deadlineOn?: string | null;
  /** Normalized: "dateOnly" | "minute" | "fullInstant" | "unknown" | null. */
  deadlinePrecision?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type AgentListJobsResult =
  | { status: "ok"; jobs: AgentJobSummary[]; total: number; truncated: boolean }
  | { status: "unavailable"; reason: string };

// What suggest_role returns to the result card: which sibling fits the
// request and the text to prefill in its composer. The card writes nothing
// — the user reviews the draft and presses send in the target role.
export type AgentSuggestRoleResult = {
  role: "insight" | "pilot" | "reflect";
  question: string;
};

export type AgentGetJobResult =
  | {
      status: "ok";
      job: AgentJobSummary & {
        source: string | null;
        jobUrl: string | null;
        appliedDate: string | null;
        dueDate: string | null;
        jobDescription: string;
        descriptionChars: number;
        descriptionTruncated: boolean;
      };
    }
  | { status: "no_job" }
  | { status: "unavailable"; reason: string };

export type AgentGetResumeResult =
  | {
      status: "ok";
      resumeId: string;
      title: string;
      resumeText: string;
      chars: number;
      truncated: boolean;
      source: AgentResumeSource;
      ambiguousTitle?: boolean;
    }
  | { status: "needs_selection"; resumes: { id: string; title: string }[] }
  | { status: "no_resumes" }
  | { status: "unreadable"; title: string; reason: string }
  | { status: "unavailable"; reason: string };

// Transient stream part carrying a nested generation's tokens. It is never
// persisted: the finished artifact lands in the tool result, and keeping both
// would duplicate it in storage and in model context. Shared by review_resume
// and match_job — the toolCallId key is what keeps two of them apart.
export const AGENT_NESTED_STREAM_PART_TYPE = "data-nested-stream";

export type AgentNestedStreamData = { delta: string };

// What review_resume returns to the model AND to the result card. The resume
// text is deliberately absent — follow-ups answer from `body`, not from the
// serialization.
export type AgentReviewResumeResult =
  | {
      status: "ok";
      resumeId: string;
      title: string;
      scores: ResumeScores;
      body: string;
      saved: boolean;
      saveError?: string;
    }
  | { status: "needs_selection"; resumes: { id: string; title: string }[] }
  | { status: "no_resumes" }
  | { status: "unreadable"; title: string; reason: string }
  | { status: "generation_failed"; title: string; reason: string }
  | { status: "unavailable"; reason: string };

// What match_job returns to the model AND to the result card. Neither the
// resume text nor the job description is here — follow-ups answer from `body`.
export type AgentMatchJobResult =
  | {
      status: "ok";
      jobId: string;
      jobTitle: string;
      company: string;
      resumeId: string;
      resumeTitle: string;
      scores: JobMatchScores;
      body: string;
      saved: boolean;
      saveError?: string;
    }
  | { status: "no_job" }
  | { status: "needs_selection"; resumes: { id: string; title: string }[] }
  | { status: "no_resumes" }
  | { status: "unreadable"; what: "job" | "resume"; title: string; reason: string }
  | { status: "generation_failed"; jobTitle: string; reason: string };

// The canonical (fresh-native/full) match_job result — a FAST_SCREENING
// verdict, never a legacy score. It parallels the legacy union above rather
// than extending it: the canonical tool does not stream nested tokens, does
// not return body text, and names its failures with stable codes the result
// card maps to messages. `source` records which material actually fed the
// run; `analysisId` is the durable MatchAnalysis row the run appended to the
// job's match history.
export type AgentCanonicalMatchJobResult =
  | {
      status: "ok";
      analysisId: string;
      jobId: string;
      jobTitle: string;
      company: string;
      source:
        | { kind: "career-profile" }
        | {
            kind: "resume-version";
            variantId: string;
            resumeTitle: string;
            versionId: string;
            versionNumber: number;
          };
      verdict: string;
      reasons: string | null;
      hardRequirements: string | null;
      coreMatch: string | null;
      preferenceMatch: string | null;
      provider: string | null;
      model: string | null;
      completedAt: string | null;
      saved: true;
      historyCount?: number;
    }
  | { status: "no_job" }
  | { status: "needs_selection"; resumes: { id: string; title: string }[] }
  | { status: "no_resumes" }
  | { status: "unavailable"; code: string; reason: string }
  | { status: "failed"; code: string; detail?: string | null };

// What generate_cover_letter returns to the model AND to the result card. The
// letter body is here so a follow-up ("make it shorter") answers from it; the
// resume text and the job description are not.
export type AgentCoverLetterResult =
  | {
      status: "ok";
      jobId: string;
      jobTitle: string;
      company: string;
      resumeId: string;
      resumeTitle: string;
      body: string;
      coverLetterId?: string;
      coverLetterTitle?: string;
      saved: boolean;
      saveError?: string;
    }
  | { status: "no_job" }
  | { status: "no_description"; jobTitle: string }
  | { status: "needs_selection"; resumes: { id: string; title: string }[] }
  | { status: "no_resumes" }
  | { status: "unreadable"; what: "job" | "resume"; title: string; reason: string }
  | { status: "generation_failed"; jobTitle: string; reason: string };

// Tools that run their own generation and stream it as transient parts. The
// transcript and the provider both branch on this rather than on a chain of
// name comparisons that grows with every nested tool.
export const AGENT_NESTED_TOOLS = [
  "review_resume",
  "match_job",
  "generate_cover_letter",
] as const;

export function isNestedTool(name: string): boolean {
  return (AGENT_NESTED_TOOLS as readonly string[]).includes(name);
}

// Tools that end the turn. The result card renders deterministically from
// structured fields, so a second generation just to narrate it is 10-30s of
// local inference for a sentence that could be wrong. A tool that runs its
// own generation MUST be listed here or a single turn can chain two of them
// and blow the turn timeout, discarding both.
export const AGENT_CHAT_TERMINAL_TOOLS = [
  "add_job",
  ...AGENT_NESTED_TOOLS,
] as const;

// add_job is terminal once it has SETTLED — written, hit a duplicate, or
// asked for approval — not merely once it has been called. A call that cannot
// write skips approval and so fails inside the same step that made it, and
// hasToolCall would end the turn on the one step the model needs to retry in,
// leaving the user a red card and no answer.
export function addJobSettled(step: {
  toolCalls?: readonly { toolName: string; invalid?: boolean }[];
  toolResults?: readonly { toolName: string; output?: unknown }[];
}): boolean {
  const call = step.toolCalls?.find((c) => c.toolName === "add_job");
  if (!call) return false;
  // A call whose input failed the tool's own schema never reaches execute:
  // the SDK marks it invalid and emits a tool-error, so it produces no
  // tool-result and would otherwise read as a pending approval below. It is
  // the same retryable failure as a validationError, one layer up.
  if (call.invalid) return false;
  const result = step.toolResults?.find((r) => r.toolName === "add_job");
  // No result yet means the call is waiting on the approval card, and nothing
  // more can happen this turn.
  if (!result) return true;
  return !(result.output as AgentAddJobResult | undefined)?.validationError;
}

// ─── read_webpage ─────────────────────────────────────────────────────────
// `content` is nonce-delimited untrusted page text for the model; the result
// card never renders it, only the metadata around it.
export type AgentReadWebpageResult =
  | {
      ok: true;
      url: string;
      finalUrl: string;
      title?: string;
      fetchedAt: string;
      truncated: boolean;
      content: string;
    }
  | { ok: false; code: string; url?: string; status?: number };

// ─── EXT-NOTION ───────────────────────────────────────────────────────────

export type AgentNotionSearchItem = {
  id: string;
  title: string;
  objectType?: string;
  url?: string;
  lastEditedAt?: string;
};

export type AgentNotionSearchResult =
  | {
      found: true;
      results: AgentNotionSearchItem[];
      truncated?: boolean;
    }
  | { found: false; code?: string; rawPreview?: string };

export type AgentNotionReadResult =
  | {
      found: true;
      target: string;
      title?: string;
      url?: string;
      content: string;
      truncated?: boolean;
    }
  | { found: false; code: string };

export type AgentNotionWriteVerify = {
  tool: "notion_search" | "notion_read";
  query?: string;
  target?: string;
};

export type AgentNotionWriteResult =
  | {
      saved: true;
      tool: string;
      pageId?: string;
      /** Every page a batch delete moved. Present on notion_delete_pages. */
      pageIds?: string[];
      url?: string;
      title?: string;
      warnings?: string[];
    }
  | {
      saved: false;
      tool: string;
      status:
        | "failed"
        | "unknown"
        | "verification_required"
        | "reauth_required"
        | "denied"
        // Detached execution: the write is queued on its harness task. A
        // queued stub is not a write receipt — hasWriteReceipt stays false.
        | "queued";
      code: string;
      /** Model-facing fixed text or the remote's own validation message. */
      detail?: string;
      verify?: AgentNotionWriteVerify;
      /** Durable proposal/task identity returned by the queued stub. */
      proposalId?: string;
      taskId?: string;
      taskStatus?: string;
    };

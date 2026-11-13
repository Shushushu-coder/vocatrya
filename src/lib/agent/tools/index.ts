import type { ConversationRequest } from "../conversationRequest";
import type { LanguageModel, ToolSet, UIMessageStreamWriter } from "ai";
import type { PageContext } from "@/models/agent.model";
import type { NestedGenerationGuard } from "@/lib/agent/nestedGeneration";
import {
  AGENT_ROLE_TOOL_ALLOWLIST,
  normalizeAgentRole,
} from "../agentRoles";
import { buildAddJobTool } from "./addJob";
import { buildListJobsTool } from "./listJobs";
import { buildGetJobTool } from "./getJob";
import { buildGetResumeTool } from "./getResume";
import { buildReviewResumeTool } from "./reviewResume";
import { buildMatchJobTool } from "./matchJob";
import { buildCanonicalMatchJobTool } from "./canonicalMatchJob";
import { buildGenerateCoverLetterTool } from "./generateCoverLetter";
import { buildNotionAgentTools } from "./notion";

// The three nested tools deliberately break the "a tool touches neither the
// route nor provider resolution" rule in CLAUDE.md: they run their own
// generation, so they need the resolved model and the stream writer. Recorded
// in docs/architecture/agent-chat.md rather than contorted around.
export function buildAgentTools(ctx: {
  userId: string;
  request?: ConversationRequest;
  pastedText?: string;
  pageContext?: PageContext;
  model: LanguageModel;
  provider: string;
  modelName: string;
  writer: UIMessageStreamWriter;
  /**
   * Trusted fresh + full A+B: match_job registers its canonical variant
   * (session-bound job, durable execution, always approval-gated) and
   * generate_cover_letter has no canonical implementation and stays
   * unregistered. add_job stays and writes a canonical job opportunity.
   */
  freshNativeFull?: boolean;
  /**
   * AB_ENABLED + full. Includes migrated full, which is not fresh-native but
   * already reads and writes canonical jobs.
   */
  canonicalJobs?: boolean;
  /**
   * Multi-agent role from the persisted conversation row (server-side
   * authority). A named role intersects the registry with its allowlist —
   * allowlists only ever shrink what the runtime already offers. NULL
   * (pre-multi-agent rows) keeps the full general-assistant registry.
   */
  agentRole?: string | null;
  /**
   * EXT-NOTION: the agent-tool names the connected Notion session can serve
   * (remote tools/list ∩ app allowlist, resolved by the route before build).
   * Absent or empty registers nothing — the extension is strictly opt-in.
   */
  notionTools?: readonly string[];
}): ToolSet {
  // One per request, so no two nested tools run at once but two users never
  // block each other.
  const nestedGuard: NestedGenerationGuard = { running: false };

  const canonicalJobs = ctx.canonicalJobs === true || ctx.freshNativeFull === true;
  const tools: ToolSet = {
    add_job: buildAddJobTool(ctx.userId, ctx.pastedText, { canonical: canonicalJobs, request: ctx.request }),
    list_jobs: buildListJobsTool(ctx.userId),
    get_job: buildGetJobTool(ctx.userId, ctx.pageContext?.jobId),
    get_resume: buildGetResumeTool(ctx.userId, ctx.pageContext?.resumeId),
    review_resume: buildReviewResumeTool({
      userId: ctx.userId,
      pageResumeId: ctx.pageContext?.resumeId,
      model: ctx.model,
      provider: ctx.provider,
      modelName: ctx.modelName,
      writer: ctx.writer,
      guard: nestedGuard,
    }),
    match_job: buildMatchJobTool({
      userId: ctx.userId,
      pageJobId: ctx.pageContext?.jobId,
      model: ctx.model,
      provider: ctx.provider,
      modelName: ctx.modelName,
      writer: ctx.writer,
      guard: nestedGuard,
      request: ctx.request,
    }),
    generate_cover_letter: buildGenerateCoverLetterTool({
      userId: ctx.userId,
      pageJobId: ctx.pageContext?.jobId,
      model: ctx.model,
      provider: ctx.provider,
      modelName: ctx.modelName,
      writer: ctx.writer,
      guard: nestedGuard,
      request: ctx.request,
    }),
  };

  if (ctx.freshNativeFull) {
    tools.match_job = buildCanonicalMatchJobTool({
      userId: ctx.userId,
      pageJobId: ctx.pageContext?.jobId,
      request: ctx.request,
      guard: nestedGuard,
    });
    delete tools.generate_cover_letter;
  }
  // EXT-NOTION: register only what the pre-resolved effective set allows —
  // execution-time gates in the tools re-check the live connection row, so a
  // disconnect between registration and execution cannot run a remote call.
  if (ctx.notionTools && ctx.notionTools.length > 0) {
    const notionToolset = buildNotionAgentTools({
      userId: ctx.userId,
      request: ctx.request,
    });
    for (const name of ctx.notionTools) {
      const notionTool = notionToolset[name];
      if (notionTool) tools[name] = notionTool;
    }
  }

  // Effective set = role allowlist ∩ registered runtime tools (built after
  // the canonical rebind above so Insight's match_job is the approval-gated
  // variant wherever the runtime gates it).
  const role = normalizeAgentRole(ctx.agentRole);
  if (role) {
    const allow = new Set(AGENT_ROLE_TOOL_ALLOWLIST[role]);
    for (const name of Object.keys(tools)) {
      if (!allow.has(name)) delete tools[name];
    }
  }
  return tools;
}

export {
  buildAddJobTool,
  buildListJobsTool,
  buildGetJobTool,
  buildGetResumeTool,
  buildReviewResumeTool,
  buildMatchJobTool,
  buildGenerateCoverLetterTool,
};

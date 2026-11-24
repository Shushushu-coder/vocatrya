import type { ConversationRequest } from "../conversationRequest";
import type { LanguageModel, ToolSet, UIMessage, UIMessageStreamWriter } from "ai";
import { buildReadWebpageTool } from "./readWebpage";
import type { PageContext } from "@/models/agent.model";
import type { NestedGenerationGuard } from "@/lib/agent/nestedGeneration";
import { effectiveAgentToolNames } from "../toolPermissions";
import { buildAddJobTool } from "./addJob";
import { buildListJobsTool } from "./listJobs";
import { buildGetJobTool } from "./getJob";
import { buildGetResumeTool } from "./getResume";
import { buildReviewResumeTool } from "./reviewResume";
import { buildMatchJobTool } from "./matchJob";
import { buildCanonicalMatchJobTool } from "./canonicalMatchJob";
import { buildGenerateCoverLetterTool } from "./generateCoverLetter";
import { buildSuggestRoleTool } from "./suggestRole";
import { buildNotionAgentTools } from "./notion";
import { buildFeishuAgentTools } from "./feishu";
import { buildTodayPlanReadTool, buildTodayPlanTool } from "./todayPlan";
import type { PermissionMode } from "../preferences";

// The three nested tools deliberately break the "a tool touches neither the
// route nor provider resolution" rule in CLAUDE.md: they run their own
// generation, so they need the resolved model and the stream writer. Recorded
// in docs/architecture/agent-chat.md rather than contorted around.
export function buildAgentTools(ctx: {
  permissionMode?: PermissionMode;
  userId: string;
  request?: ConversationRequest;
  pastedText?: string;
  pageContext?: PageContext;
  /**
   * This request's conversation messages. read_webpage derives the URLs the
   * user supplied from user-role parts only (text, paste, file parts).
   */
  messages?: UIMessage[];
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
  /**
   * EXT-FEISHU: the agent-tool names the connected Feishu app can serve
   * (probed capabilities ∩ app allowlist, resolved by the route before
   * build). Absent or empty registers nothing — strictly opt-in.
   */
  feishuTools?: readonly string[];
  /**
   * Task-session extension (resolveTaskSessionTools): extra tools for a Pilot
   * conversation bound to an ACTIVE task. Absent/null leaves the role
   * allowlist untouched.
   */
  taskExtraTools?: readonly string[] | null;
}): ToolSet {
  // One per request, so no two nested tools run at once but two users never
  // block each other.
  const nestedGuard: NestedGenerationGuard = { running: false };

  const canonicalJobs = ctx.canonicalJobs === true || ctx.freshNativeFull === true;
  const tools: ToolSet = {
    add_job: buildAddJobTool(ctx.userId, ctx.pastedText, { canonical: canonicalJobs, request: ctx.request }),
    list_jobs: buildListJobsTool(ctx.userId),
    get_job: buildGetJobTool(ctx.userId, ctx.pageContext?.jobId),
    read_webpage: buildReadWebpageTool(ctx.messages ?? []),
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
    // Registered unconditionally and pruned by the allowlist filter like
    // every other tool: named roles keep it (their allowlists name it),
    // the NULL general assistant drops it — it has no siblings to hand to.
    suggest_role: buildSuggestRoleTool(),
    // TODAY-PLAN: the checklist is per-conversation — both tools resolve it
    // from the admitted request, never from model input. The read stays on
    // every role's surface; every named role can manage its own checklist.
    today_plan_read: buildTodayPlanReadTool(ctx.userId, ctx.request),
    today_plan: buildTodayPlanTool(ctx.userId, ctx.request),
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
  // EXT-FEISHU: same gate — only the pre-resolved effective set registers,
  // and execution re-checks the live connection row per call.
  if (ctx.feishuTools && ctx.feishuTools.length > 0) {
    const feishuToolset = buildFeishuAgentTools({
      userId: ctx.userId,
      request: ctx.request,
    });
    for (const name of ctx.feishuTools) {
      const feishuTool = feishuToolset[name];
      if (feishuTool) tools[name] = feishuTool;
    }
  }

  // Effective set = role allowlist ∩ registered runtime tools (built after
  // the canonical rebind above so Insight's match_job is the approval-gated
  // variant wherever the runtime gates it).
  const allowed = new Set(effectiveAgentToolNames(ctx));
  for (const name of Object.keys(tools)) {
    if (!allowed.has(name)) delete tools[name];
  }
  // Only known reversible local operations are automatically approved.
  // Detached external writes retain their proposal gate even in Full access;
  // the server settles their approval from the persisted choice atomically.
  // Canonical match_job keeps its gate in every mode (contract D3): its
  // durable execution binds to the admitted approval turn, so lifting
  // needsApproval only strands the call in a turn conflict.
  if (ctx.permissionMode === "rules" || ctx.permissionMode === "full") {
    for (const name of ["add_job", "match_job"]) {
      if (name === "match_job" && ctx.freshNativeFull) continue;
      if (tools[name]) tools[name].needsApproval = false;
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

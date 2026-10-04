import type { LanguageModel, ToolSet, UIMessageStreamWriter } from "ai";
import type { PageContext } from "@/models/agent.model";
import type { NestedGenerationGuard } from "@/lib/agent/nestedGeneration";
import { buildAddJobTool } from "./addJob";
import { buildListJobsTool } from "./listJobs";
import { buildGetJobTool } from "./getJob";
import { buildGetResumeTool } from "./getResume";
import { buildReviewResumeTool } from "./reviewResume";
import { buildMatchJobTool } from "./matchJob";
import { buildGenerateCoverLetterTool } from "./generateCoverLetter";

// The three nested tools deliberately break the "a tool touches neither the
// route nor provider resolution" rule in CLAUDE.md: they run their own
// generation, so they need the resolved model and the stream writer. Recorded
// in docs/architecture/agent-chat.md rather than contorted around.
export function buildAgentTools(ctx: {
  userId: string;
  pastedText?: string;
  pageContext?: PageContext;
  model: LanguageModel;
  provider: string;
  modelName: string;
  writer: UIMessageStreamWriter;
  /**
   * Trusted fresh + full A+B: add_job writes the legacy Job table the write
   * guard rejects, and match/cover-letter have no canonical implementation
   * yet — none of the three may be advertised or callable on this runtime.
   */
  freshNativeFull?: boolean;
}): ToolSet {
  // One per request, so no two nested tools run at once but two users never
  // block each other.
  const nestedGuard: NestedGenerationGuard = { running: false };

  const tools: ToolSet = {
    add_job: buildAddJobTool(ctx.userId, ctx.pastedText),
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
    }),
    generate_cover_letter: buildGenerateCoverLetterTool({
      userId: ctx.userId,
      pageJobId: ctx.pageContext?.jobId,
      model: ctx.model,
      provider: ctx.provider,
      modelName: ctx.modelName,
      writer: ctx.writer,
      guard: nestedGuard,
    }),
  };

  if (ctx.freshNativeFull) {
    delete tools.add_job;
    delete tools.match_job;
    delete tools.generate_cover_letter;
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

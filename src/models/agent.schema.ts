import { z } from "zod";
import { McpAddJobInputShape } from "@/models/mcp.schema";

const chatRequestBase = {
  conversationId: z.string().min(1),
  expectedRevision: z.number().int().nonnegative(),
  requestId: z.string().min(1).max(128),
};
const newUserMessage = z.object({
  id: z.string().min(1), role: z.literal("user"),
  parts: z.array(z.union([
    z.object({ type: z.literal("text"), text: z.string() }).strict(),
    z.object({ type: z.literal("data-paste"), data: z.object({ text: z.string(), chars: z.number().optional(), consumed: z.boolean().optional() }).passthrough() }).passthrough(),
    z.object({ type: z.literal("data-file"), data: z.object({ name: z.string(), text: z.string() }).passthrough() }).passthrough(),
  ])),
}).strict();
export const AgentChatRequestSchema = z.discriminatedUnion("operation", [
  z.object({ ...chatRequestBase, operation: z.literal("send"), newMessage: newUserMessage }).strict(),
  z.object({ ...chatRequestBase, operation: z.literal("regenerate"), targetMessageId: z.string().min(1) }).strict(),
  z.object({ ...chatRequestBase, operation: z.literal("approval"), approvalId: z.string().min(1), decision: z.boolean(), reason: z.string().max(2000).optional() }).strict(),
]);

export type AgentChatRequest = z.infer<typeof AgentChatRequestSchema>;

// Derived from the MCP RAW shape, not McpAddJobSchema: AI SDK's tool()
// uses one schema for both the JSON schema the model reads and the
// validation of what it returns, so the date transforms are deferred to
// AgentAddJobParseSchema. status keeps its z.preprocess — that is what
// keeps enum: [...] on the input side of the emitted JSON schema.
export const AgentAddJobSchema = z
  .object(McpAddJobInputShape)
  .omit({ upsert: true, allowDuplicate: true })
  .extend({
    // Calendar-day deadline alternative to the dueDate instant — pick ONE:
    // deadlineOn when the posting only names a day, dueDate when it names a
    // moment. Passing both is rejected in AgentAddJobParseSchema.
    deadlineOn: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional()
      .describe("Application deadline as a calendar date YYYY-MM-DD (the whole local day). Use instead of dueDate when the posting only gives a day; never pass both."),
    jobDescription: z
      .string()
      .refine((val) => val === "N/A" || val.length >= 10, "jobDescription must be at least 10 characters")
      .optional()
      .describe("What the job involves, in the user's own words, copied verbatim and never summarised. Always include this field, even if their description is only one sentence and looks nothing like a full posting, and never condense it into tags instead. If you were shown only the opening portion of a pasted posting, copy the portion you were shown. Use 'N/A' only if the user explicitly declines to give any description after being asked once."),
  });

export const AgentAddJobInputShape = AgentAddJobSchema.shape;

// Parsed inside execute, after the model's input has been validated.
export const AgentAddJobParseSchema = AgentAddJobSchema.extend({
  dueDate: z.string().datetime({ offset: true }).optional().transform((v) => (v ? new Date(v) : undefined)),
  appliedDate: z.string().datetime({ offset: true }).optional().transform((v) => (v ? new Date(v) : undefined)),
}).superRefine((input, ctx) => {
  if (input.deadlineOn && input.dueDate) {
    ctx.addIssue({
      code: "custom",
      path: ["deadlineOn"],
      message:
        "deadlineOn and dueDate are mutually exclusive — pass deadlineOn for a day-level deadline or dueDate for an exact instant, not both.",
    });
  }
});

export type AgentAddJobInput = z.infer<typeof AgentAddJobParseSchema>;

// One optional field, and never an id: the model names a resume the way the
// user did, and the server resolves it ownership-scoped. An id-shaped input
// would be an IDOR surface the model could be talked into filling.
export const AgentGetResumeSchema = z.object({
  resumeTitle: z.string().optional().describe("The title of the resume to read, as the user referred to it. Omit this entirely if the user did not name one — the app then uses the resume they are currently viewing, or their default resume."),
});

export type AgentGetResumeInput = z.infer<typeof AgentGetResumeSchema>;

// Same one-optional-field shape as AgentGetResumeSchema, and never an id: the
// model names a resume the way the user did, and the server resolves it
// ownership-scoped.
export const AgentReviewResumeSchema = z.object({
  resumeTitle: z.string().optional().describe("The title of the resume to review, as the user referred to it. Omit this entirely if the user did not name one — the app then uses the resume they are currently viewing, or their default resume."),
});

export type AgentReviewResumeInput = z.infer<typeof AgentReviewResumeSchema>;

// No job field of any kind: match_job scores the job the user is viewing, and
// the id comes from server-held page context. An id-shaped input would be an
// IDOR surface the model could be talked into filling.
export const AgentMatchJobSchema = z.object({
  resumeTitle: z.string().optional().describe("The title of the resume to match against, as the user referred to it. Omit this entirely if the user did not name one — the app then uses the resume linked to the job, or their default resume."),
});

export type AgentMatchJobInput = z.infer<typeof AgentMatchJobSchema>;

// The canonical (fresh-native) variant: same shape and the same "no job id"
// rule, but an omitted resume resolves to the career profile, not a resume —
// the description must not promise behavior the canonical source picker does
// not have.
export const AgentCanonicalMatchJobSchema = z.object({
  resumeTitle: z.string().optional().describe("The title of the resume variant to match against, as the user referred to it. Omit this entirely if the user did not name one — the app then matches against their career profile instead of a resume variant."),
});

export type AgentCanonicalMatchJobInput = z.infer<
  typeof AgentCanonicalMatchJobSchema
>;

// No job field of any kind, for the same reason AgentMatchJobSchema has none:
// the letter is written for the job the user is viewing, and the id comes from
// server-held page context.
export const AgentCoverLetterSchema = z.object({
  resumeTitle: z.string().optional().describe("The title of the resume the letter should draw on, as the user referred to it. Omit this entirely if the user did not name one — the app then uses the resume linked to the job, or their default resume."),
});

export type AgentCoverLetterInput = z.infer<typeof AgentCoverLetterSchema>;

export const AgentListJobsSchema = z.object({});

export type AgentListJobsInput = z.infer<typeof AgentListJobsSchema>;

// jobId is the id list_jobs already returned for this user, or omitted so the
// server uses the page-context job. userId is never accepted from the model.
export const AgentGetJobSchema = z.object({
  jobId: z
    .string()
    .optional()
    .describe("Id of the job to read, as returned by list_jobs. Omit this entirely when the user is asking about the job currently open on the page."),
});

export type AgentGetJobInput = z.infer<typeof AgentGetJobSchema>;

// ─── EXT-NOTION ───────────────────────────────────────────────────────────
// Unknown/interrupted writes require manual reconciliation in Notion. The legacy
// verifiedNoDuplicate field is accepted but never enables retry.

export const AgentNotionSearchSchema = z.object({
  query: z.string().min(1).max(500).describe("Search keywords — a page title, a topic, or short specific terms. Notion searches pages and databases the connected workspace has shared with this integration."),
});

export type AgentNotionSearchInput = z.infer<typeof AgentNotionSearchSchema>;

export const AgentNotionReadSchema = z.object({
  target: z.string().min(1).max(2000).describe("A Notion page or database URL, or an id returned by an earlier notion_search result in this conversation. Never invent an id."),
});

export type AgentNotionReadInput = z.infer<typeof AgentNotionReadSchema>;

const notionWriteCommon = {
  verifiedNoDuplicate: z.boolean().optional().describe("Legacy compatibility flag; ignored for retry authorization. Unknown/interrupted writes remain blocked and require manual reconciliation in Notion."),
};

export const AgentNotionCreatePageSchema = z.object({
  target: z.string().max(2000).optional().describe("Optional parent — a Notion page or database URL/id the user named or an earlier tool returned. Omit to create a private page in the connected workspace."),
  targetType: z.enum(["page", "database"]).optional().describe("What target is. Required when target is a database: pages cannot be created under a database through page_id."),
  title: z.string().min(1).max(300).describe("The page title shown to the user on the approval card."),
  content: z.string().min(1).max(8000).describe("Markdown body for the new page. The approval card shows it verbatim — the user reviews exactly this text before it is sent."),
  properties: z.record(z.string(), z.unknown()).optional().describe("Optional database properties when target is a database, using the property names and value shapes notion_read showed for that database."),
  ...notionWriteCommon,
});

export type AgentNotionCreatePageInput = z.infer<
  typeof AgentNotionCreatePageSchema
>;

export const AgentNotionAppendContentSchema = z.object({
  target: z.string().min(1).max(2000).describe("The Notion page URL or id to append to — from an earlier notion_search/notion_read result or one the user named."),
  content: z.string().min(1).max(8000).describe("Markdown to append at the end of the page. The approval card shows it verbatim."),
  ...notionWriteCommon,
});

export type AgentNotionAppendContentInput = z.infer<
  typeof AgentNotionAppendContentSchema
>;

export const AgentNotionUpdateRecordSchema = z.object({
  target: z.string().min(1).max(2000).describe("The Notion database row (page) URL or id to update — from an earlier notion_search/notion_read result or one the user named."),
  properties: z.record(z.string(), z.unknown()).describe("Property updates only, using the property names and value shapes notion_read showed for the database. Read the record first; never guess a property name or format."),
  ...notionWriteCommon,
});

const notionContentEdit = z.object({
  oldText: z.string().min(1).max(8000).describe("Exact text copied from a notion_read of this page. It must match one place unless replaceAll is true."),
  newText: z.string().max(8000).describe("Replacement text. An empty string deletes oldText. To insert, keep the surrounding anchor inside newText."),
  replaceAll: z.boolean().optional().describe("Replace every exact match of oldText. Omit when the span is unique."),
});

export const AgentNotionUpdateContentSchema = z.object({
  target: z.string().min(1).max(2000).describe("The Notion page URL or id whose body to edit — from an earlier notion_search/notion_read result or one the user named."),
  edits: z.array(notionContentEdit).min(1).max(20).describe("In-place body edits applied together. This tool runs immediately and does not delete the page."),
}).superRefine((value, ctx) => {
  const total = value.edits.reduce((sum, edit) => sum + edit.oldText.length + edit.newText.length, 0);
  if (total > 8000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The edits together exceed 8000 characters. Split them into a later call.",
      path: ["edits"],
    });
  }
});

export type AgentNotionUpdateContentInput = z.infer<typeof AgentNotionUpdateContentSchema>;

export const AgentNotionDeletePagesSchema = z.object({
  targets: z.array(z.string().min(1).max(2000)).min(1).max(20).describe("Every page to move to Trash, in this one call. Pass the whole batch here — a second call asks the user again. Each entry is a URL or id from notion_search, notion_read, or the user. Database rows count as pages. Do not include a database itself."),
  ...notionWriteCommon,
});

export type AgentNotionDeletePagesInput = z.infer<typeof AgentNotionDeletePagesSchema>;

export type AgentNotionUpdateRecordInput = z.infer<
  typeof AgentNotionUpdateRecordSchema
>;

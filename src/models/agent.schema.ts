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

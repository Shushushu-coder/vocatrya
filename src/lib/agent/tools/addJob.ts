import { checkpointConversationTool, ConversationRequestError, type ConversationRequest } from "../conversationRequest";
import type { Prisma } from "@prisma/client";
import { tool } from "ai";
import { APP_CONSTANTS } from "@/lib/constants";
import { AGENT_TOOL_DESCRIPTIONS } from "@/lib/agent/prompt";
import { AgentAddJobParseSchema, AgentAddJobSchema } from "@/models/agent.schema";
import { createAgentOpportunity, createAgentOpportunityInTransaction } from "@/lib/career/createAgentOpportunity";
import { createJobFromNames, renderJobDescription } from "@/lib/jobs/createJobFromNames";
import { JobResolutionError } from "@/lib/jobs/resolve";
import { log } from "@/lib/telemetry";
import type { AgentAddJobResult } from "@/models/agent.model";

// The model usually reaches here having omitted jobDescription because the
// user's message looked pasted to it while no chip was made, so the recovery
// it needs is "copy it from the message", not "ask again" — asking again is
// what made it retry with a paraphrase and save a partial description.
const NO_DESCRIPTION = "No job description was supplied, and no pasted posting reached this turn. If the user's own message contains the posting or any description of the role, copy it into jobDescription verbatim and in full — never summarise, shorten or condense it — and call add_job again. Only if their message has no description at all, ask them to paste the posting or type the role's details, then try again.";

// What the card shows instead. The text above is addressed to the model, and
// the card would otherwise print all of it — field name, retry instruction
// and all — into the user's own transcript.
const NO_DESCRIPTION_DISPLAY = "no description came through with it. Paste the posting or say what the role involves, and it will be added.";

const SAVE_FAILED = "Saving the job failed. Try again, or add it from the Jobs page.";

function failed(validationError: string, displayError?: string): AgentAddJobResult {
  return { created: false, resolutions: [], validationError, displayError };
}

function namedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * userId and pastedText are captured from the route's authenticated session
 * and message array. Anything with those names inside the model's input is
 * ignored — this is the IDOR boundary and it has a dedicated test.
 *
 * canonical selects the Career A-side writer. It never falls back to the
 * legacy Job table when that writer fails.
 */
export function buildAddJobTool(
  userId: string,
  pastedText?: string,
  options?: { canonical?: boolean; request?: ConversationRequest },
) {
  const canonical = options?.canonical === true;
  return tool({
    description: canonical
      ? AGENT_TOOL_DESCRIPTIONS.add_job_canonical
      : AGENT_TOOL_DESCRIPTIONS.add_job,
    // Date transforms are deferred here so this schema doubles as the JSON
    // schema the model reads — see src/models/agent.schema.ts.
    inputSchema: canonical
      ? AgentAddJobSchema
      : AgentAddJobSchema.omit({ deadlineOn: true }),
    // Approval is asked for every call that could write, and skipped only for
    // one that execute is already certain to reject. The card renders before
    // execute runs, so a doomed call otherwise spends a Confirm and the retry
    // spends a second one — the user confirms the same job twice.
    needsApproval: (input: { jobDescription?: string; company?: string; jobTitle?: string }) => {
      if (canonical) {
        return Boolean(namedText(input?.company) && namedText(input?.jobTitle));
      }
      return Boolean(pastedText ?? input?.jobDescription);
    },
    execute: async (raw, exec): Promise<AgentAddJobResult> => {
      // Older/replayed callers can bypass the advertised schema. A Legacy
      // Job has no DateOnly carrier, so reject rather than invent midnight.
      if (!canonical && raw && "deadlineOn" in raw) {
        return failed("deadlineOn is not supported in this mode. Only an explicitly supplied dueDate instant with an offset is supported; do not invent a time for a calendar-day deadline.");
      }
      const parsed = AgentAddJobParseSchema.safeParse(raw);
      if (!parsed.success) {
        // Returned, not thrown, so the model can see why and retry.
        return failed(
          parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
            .join("; "),
        );
      }

      const input = parsed.data;
      const jobDescription = pastedText ?? input.jobDescription;
      if (!canonical && !jobDescription) {
        return failed(NO_DESCRIPTION, NO_DESCRIPTION_DISPLAY);
      }

      const renderedDescription = canonical ? undefined : renderJobDescription(jobDescription as string);
      const started = Date.now();
      try {
        const mutate = async (tx?: Prisma.TransactionClient): Promise<AgentAddJobResult> => {
          if (canonical) {
            const opportunityInput = {
              company: input.company,
              jobTitle: input.jobTitle,
              jobDescription,
              location: input.location,
              source: input.source,
              jobType: input.jobType,
              workplaceType: input.workplaceType,
              dueDate: input.dueDate,
              deadlineOn: input.deadlineOn,
              jobUrl: input.jobUrl,
              salaryRange: input.salaryRange,
              toolCallId: exec?.toolCallId,
            };
            const result = tx
              ? await createAgentOpportunityInTransaction(tx, opportunityInput, userId)
              : await createAgentOpportunity(opportunityInput, userId);
            log.info("[agent-chat] add_job", {
              tool: "add_job",
              result: result.replayed ? "replayed" : "created",
              jobOpportunityId: result.jobOpportunityId,
              hasDescription: result.hasDescription,
              elapsedMs: Date.now() - started,
            });
            return {
              created: true,
              jobId: result.jobOpportunityId,
              jobOpportunityId: result.jobOpportunityId,
              company: result.company,
              title: result.title,
              resolutions: result.resolutions,
              descriptionSource: jobDescription
                ? pastedText
                  ? "pasted"
                  : "model"
                : undefined,
              descriptionChars: jobDescription ? jobDescription.length : undefined,
            };
          }

          const result = await createJobFromNames(
            {
              ...input,
              jobDescription: jobDescription as string,
              createdVia: APP_CONSTANTS.AGENT_CHAT_CREATED_VIA,
            },
            userId,
            tx,
            renderedDescription,
          );

          // result.message is deliberately NOT returned: it is MCP-facing
          // protocol text naming update_job and allowDuplicate, neither of
          // which this surface exposes. The card composes its own copy.
          return {
            created: result.created,
            jobId: result.jobId,
            duplicateOf: result.duplicateOf,
            resolutions: result.resolutions,
            descriptionSource: pastedText ? "pasted" : "model",
            descriptionChars: (jobDescription as string).length,
            descriptionCompleteness: result.descriptionCompleteness,
        };
        };
        if (options?.request) {
          return await checkpointConversationTool(options.request, { toolName: "add_job", toolCallId: exec.toolCallId, input: raw }, tx => mutate(tx));
        }
        return await mutate();
      } catch (error) {
        if (error instanceof ConversationRequestError) throw error;
        log.error("[agent-chat] add_job failed", {
          tool: "add_job",
          result: "failed",
          hasDescription: Boolean(jobDescription && jobDescription !== "N/A"),
          elapsedMs: Date.now() - started,
          error: error instanceof JobResolutionError ? error.message : error instanceof Error ? error.name : "error",
        });
        // Our own text, naming the field and the values it accepts, so the
        // model can fix the argument instead of guessing — its guess was to
        // drop the field, losing a value the posting stated. Every other
        // error keeps the fixed string: provider and Prisma messages carry
        // request context that must not reach the model.
        if (error instanceof JobResolutionError) return failed(error.message);
        return failed(SAVE_FAILED);
      }
    },
  });
}

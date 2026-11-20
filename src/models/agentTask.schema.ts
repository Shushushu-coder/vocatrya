import { z } from "zod";
import { APP_CONSTANTS } from "@/lib/constants";

/**
 * Agent task handoff contract (interview sprint).
 *
 * The persisted state mixes two kinds of fields:
 *  - entity pointers (completedWork.*Ids), acceptanceSnapshot, constraints
 *    and the milestone are collected by CODE from the task row and domain
 *    queries — the model has no channel to write them;
 *  - prose (summary, nextActions[].action/toolHint, blocking) is the ONLY
 *    part a model produces, validated by AgentTaskHandoffProseSchema.
 * Every field is size-capped; the caps are what lets the rendered handoff
 * row fit APP_CONSTANTS.AGENT_TASK_HANDOFF_TOKENS.
 */

export const AGENT_TASK_HANDOFF_SCHEMA_VERSION = "agent-task-handoff-v1";

export const AGENT_TASK_HANDOFF_MILESTONES = [
  "PREPARING",
  "PRACTICING",
  "REVIEWING",
  "DONE",
] as const;

export const AGENT_TASK_HANDOFF_BLOCKING_REASONS = [
  "WAITING_USER_CONFIRMATION",
  "WAITING_SCHEDULE",
  "MISSING_FACTS",
  "EXTERNAL_REPLY",
] as const;

const pointerId = z.string().min(1).max(100);
const pointerList = z.array(pointerId).max(APP_CONSTANTS.AGENT_TASK_HANDOFF_MAX_POINTERS);

const BlockingSchema = z
  .object({
    isBlocked: z.boolean(),
    reason: z.enum(AGENT_TASK_HANDOFF_BLOCKING_REASONS).optional(),
    requiredInputKey: z.string().min(1).max(100).optional(),
  })
  .strict()
  .refine((blocking) => !blocking.isBlocked || blocking.reason !== undefined, {
    message: "blocking.reason is required when isBlocked",
  });

const NextActionProseSchema = z
  .object({
    action: z
      .string()
      .min(1)
      .max(APP_CONSTANTS.AGENT_TASK_HANDOFF_NEXT_ACTION_MAX_CHARS),
    toolHint: z.string().min(1).max(100).optional(),
  })
  .strict();

/** The only fields a model may write. */
export const AgentTaskHandoffProseSchema = z
  .object({
    summary: z.string().min(1).max(APP_CONSTANTS.AGENT_TASK_HANDOFF_SUMMARY_MAX_CHARS),
    nextActions: z
      .array(NextActionProseSchema)
      .min(1)
      .max(APP_CONSTANTS.AGENT_TASK_HANDOFF_MAX_NEXT_ACTIONS),
    blocking: BlockingSchema,
  })
  .strict();
export type AgentTaskHandoffProse = z.infer<typeof AgentTaskHandoffProseSchema>;

export const AgentTaskHandoffStateSchema = z
  .object({
    schemaVersion: z.literal(AGENT_TASK_HANDOFF_SCHEMA_VERSION),
    taskId: z.string().min(1).max(100),
    templateKey: z.literal("INTERVIEW_SPRINT"),
    milestone: z.enum(AGENT_TASK_HANDOFF_MILESTONES),
    completedWork: z
      .object({
        summary: z
          .string()
          .max(APP_CONSTANTS.AGENT_TASK_HANDOFF_SUMMARY_MAX_CHARS),
        jobOpportunityIds: pointerList,
        jobDescriptionVersionIds: pointerList,
        interviewPrepGoalIds: pointerList,
        matchAnalysisIds: pointerList,
        interviewSessionIds: pointerList,
      })
      .strict(),
    acceptanceSnapshot: z
      .array(
        z
          .object({
            key: z.string().min(1).max(100),
            passes: z.boolean(),
            evidenceRef: z.string().min(1).max(100).optional(),
          })
          .strict(),
      )
      .max(20),
    blocking: BlockingSchema,
    nextActions: z
      .array(
        NextActionProseSchema.extend({
          targetRef: z.string().min(1).max(100).optional(),
        }).strict(),
      )
      .min(1)
      .max(APP_CONSTANTS.AGENT_TASK_HANDOFF_MAX_NEXT_ACTIONS),
    criticalConstraints: z
      .array(z.string().min(1).max(APP_CONSTANTS.AGENT_TASK_HANDOFF_CONSTRAINT_MAX_CHARS))
      .max(APP_CONSTANTS.AGENT_TASK_HANDOFF_MAX_CONSTRAINTS),
    constraintSourceIds: pointerList,
  })
  .strict();
export type AgentTaskHandoffState = z.infer<typeof AgentTaskHandoffStateSchema>;

/** Entity pointer arrays of completedWork, with the domain kind each names. */
export const AGENT_TASK_HANDOFF_POINTER_KEYS = [
  "jobOpportunityIds",
  "jobDescriptionVersionIds",
  "interviewPrepGoalIds",
  "matchAnalysisIds",
  "interviewSessionIds",
] as const;
export type AgentTaskHandoffPointerKey =
  (typeof AGENT_TASK_HANDOFF_POINTER_KEYS)[number];
export type AgentTaskHandoffPointers = Pick<
  AgentTaskHandoffState["completedWork"],
  AgentTaskHandoffPointerKey
>;

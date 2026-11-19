import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { createAgentTask } from "@/lib/agent/task/agentTaskStore";
import { seedAccount } from "./backupTestDb";
import {
  AGENT_TASK_HANDOFF_SCHEMA_VERSION,
  type AgentTaskHandoffState,
} from "@/models/agentTask.schema";

/** Interview-sprint domain fixture for handoff specs (isolated test DB). */
export async function seedSprint(prisma: PrismaClient) {
  const userId = await seedAccount(prisma, `handoff-${randomUUID()}@example.com`);
  const company = await prisma.company.create({
    data: { label: "Acme", value: `acme-${randomUUID()}`, createdBy: userId },
  });
  const job = await prisma.jobOpportunity.create({
    data: { userId, companyId: company.id, title: "Staff Engineer" },
  });
  const jd = await prisma.jobDescriptionVersion.create({
    data: {
      jobOpportunityId: job.id,
      versionNumber: 1,
      rawContent: "JD text",
      capturedAt: new Date(),
      contentHash: `hash-${randomUUID()}`,
    },
  });
  const parse = await prisma.jobDescriptionParse.create({
    data: {
      jobDescriptionVersionId: jd.id,
      schemaVersion: "v1",
      parserVersion: "v1",
      structuredData: "{}",
      parseStatus: "COMPLETED",
      inputHash: `in-${randomUUID()}`,
    },
  });
  const match = await prisma.matchAnalysis.create({
    data: {
      userId,
      jobOpportunityId: job.id,
      jobDescriptionParseId: parse.id,
      analysisType: "JD_FIT",
      inputHash: `m-${randomUUID()}`,
      analysisSchemaVersion: "v1",
      status: "COMPLETED",
    },
  });
  const goal = await prisma.interviewPrepGoal.create({
    data: {
      userId,
      jobOpportunityId: job.id,
      pinnedJobDescriptionVersionId: jd.id,
      pinnedJdContentHash: jd.contentHash,
      requestKey: `req-${randomUUID()}`,
      liveSlot: job.id,
    },
  });
  const interview = await prisma.interviewSession.create({
    data: {
      userId,
      coachingMode: "PRACTICE",
      feedbackReleasePolicy: "IMMEDIATE",
      knowledgeBaseVersion: "kb-1",
      jobOpportunityId: job.id,
      jobDescriptionVersionId: jd.id,
      interviewPrepGoalId: goal.id,
    },
  });
  const { task } = await createAgentTask(prisma, { userId, jobOpportunityId: job.id });
  const conversation = await prisma.chatConversation.create({
    data: {
      userId,
      messages: JSON.stringify([
        { id: "u1", role: "user", parts: [{ type: "text", text: "Let's practice system design." }] },
        { id: "a1", role: "assistant", parts: [{ type: "text", text: "Started a mock session." }] },
      ]),
      agentRole: "pilot",
      agentTaskId: task.id,
    },
  });
  return { userId, job, jd, match, goal, interview, task, conversation };
}

export type Sprint = Awaited<ReturnType<typeof seedSprint>>;

export function handoffStateFor(
  sprint: Sprint,
  overrides: Partial<AgentTaskHandoffState> = {},
): AgentTaskHandoffState {
  return {
    schemaVersion: AGENT_TASK_HANDOFF_SCHEMA_VERSION,
    taskId: sprint.task.id,
    templateKey: "INTERVIEW_SPRINT",
    milestone: "PRACTICING",
    completedWork: {
      summary: "Reviewed JD fit; one mock session started.",
      jobOpportunityIds: [sprint.job.id],
      jobDescriptionVersionIds: [sprint.jd.id],
      interviewPrepGoalIds: [sprint.goal.id],
      matchAnalysisIds: [sprint.match.id],
      interviewSessionIds: [sprint.interview.id],
    },
    acceptanceSnapshot: [{ key: "prep-goal-active", passes: false }],
    blocking: { isBlocked: false },
    nextActions: [{ action: "Answer the first mock question." }],
    criticalConstraints: [],
    constraintSourceIds: [],
    ...overrides,
  };
}

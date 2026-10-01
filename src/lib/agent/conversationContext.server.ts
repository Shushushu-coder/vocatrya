import "server-only";

import prisma from "@/lib/db";
import { AIBusinessError } from "@/lib/ai/connections";
import {
  dedupeContextItems,
  type AgentConversationContextItem,
  type AgentConversationContextV1,
  type ContextItemRequest,
} from "./conversationContext";

const MAX_CONTEXT_ITEMS = 8;

function jobLabel(job: {
  JobTitle: { label: string } | null;
  Company: { label: string } | null;
}): string {
  return [job.JobTitle?.label, job.Company?.label].filter(Boolean).join(" · ");
}

async function loadOwnedJob(userId: string, entityId: string) {
  const job = await prisma.job.findFirst({
    where: { id: entityId, userId },
    select: {
      id: true,
      JobTitle: { select: { label: true } },
      Company: { select: { label: true } },
    },
  });
  if (!job) return null;
  return { id: job.id, label: jobLabel(job) || job.id };
}

async function loadOwnedResume(userId: string, entityId: string) {
  const resume = await prisma.resume.findFirst({
    where: { id: entityId, profile: { userId } },
    select: { id: true, title: true },
  });
  if (!resume) return null;
  return { id: resume.id, label: resume.title };
}

/**
 * Verifies every requested context entity belongs to the user and is a
 * legacy Job or Resume the agent can actually resolve. A JobOpportunity id
 * does not match `Job` and is rejected rather than forwarded.
 */
export async function resolveOwnedContext(
  userId: string,
  requested: ContextItemRequest[],
): Promise<AgentConversationContextV1> {
  if (requested.length > MAX_CONTEXT_ITEMS) {
    throw new AIBusinessError(
      "AGENT_TOOL_ARGUMENT_INVALID",
      "Too many conversation context items",
    );
  }
  const items: AgentConversationContextItem[] = [];
  for (const request of requested) {
    if (request.kind !== "job" && request.kind !== "resume") {
      throw new AIBusinessError(
        "AGENT_TOOL_ARGUMENT_INVALID",
        "Unsupported conversation context",
      );
    }
    if (request.source !== "AUTO" && request.source !== "MANUAL") {
      throw new AIBusinessError(
        "AGENT_TOOL_ARGUMENT_INVALID",
        "Unsupported conversation context source",
      );
    }
    if (typeof request.entityId !== "string" || !request.entityId.trim()) {
      throw new AIBusinessError(
        "AGENT_TOOL_ARGUMENT_INVALID",
        "Missing conversation context entity",
      );
    }
    const owned =
      request.kind === "job"
        ? await loadOwnedJob(userId, request.entityId)
        : await loadOwnedResume(userId, request.entityId);
    if (!owned) {
      throw new AIBusinessError(
        "AGENT_TOOL_ARGUMENT_INVALID",
        "Conversation context is not available to this user",
      );
    }
    items.push({
      kind: request.kind,
      entityId: owned.id,
      labelSnapshot: owned.label,
      source: request.source,
    });
  }
  return { version: 1, items: dedupeContextItems(items) };
}

/**
 * Page auto-attach. Missing ids are omitted: an A+B JobOpportunity id is
 * not a legacy Job, and the draft must not claim the assistant can see it.
 */
export async function resolvePageContextItems(
  userId: string,
  input: { jobId?: string | null; resumeId?: string | null },
): Promise<AgentConversationContextV1> {
  const items: AgentConversationContextItem[] = [];
  if (input.jobId) {
    const job = await loadOwnedJob(userId, input.jobId);
    if (job) {
      items.push({
        kind: "job",
        entityId: job.id,
        labelSnapshot: job.label,
        source: "AUTO",
      });
    }
  }
  if (input.resumeId) {
    const resume = await loadOwnedResume(userId, input.resumeId);
    if (resume) {
      items.push({
        kind: "resume",
        entityId: resume.id,
        labelSnapshot: resume.label,
        source: "AUTO",
      });
    }
  }
  return { version: 1, items };
}

export type AgentContextOption = {
  kind: "job" | "resume";
  id: string;
  label: string;
  secondary: string | null;
};

export async function listOwnedContextOptions(
  userId: string,
): Promise<{ jobs: AgentContextOption[]; resumes: AgentContextOption[] }> {
  const [jobs, resumes] = await Promise.all([
    prisma.job.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: {
        id: true,
        JobTitle: { select: { label: true } },
        Company: { select: { label: true } },
      },
    }),
    prisma.resume.findMany({
      where: { profile: { userId } },
      orderBy: { updatedAt: "desc" },
      take: 40,
      select: { id: true, title: true, updatedAt: true },
    }),
  ]);
  return {
    jobs: jobs.map((job) => ({
      kind: "job" as const,
      id: job.id,
      label: job.JobTitle?.label || "Job",
      secondary: job.Company?.label ?? null,
    })),
    resumes: resumes.map((resume) => ({
      kind: "resume" as const,
      id: resume.id,
      label: resume.title,
      secondary: null,
    })),
  };
}

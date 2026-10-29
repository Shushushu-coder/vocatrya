import "server-only";

import prisma from "@/lib/db";
import { AIBusinessError } from "@/lib/ai/connections";
import { getJob, listJobs } from "@/lib/career/jobsReadDispatch";
import { isArchivedCanonicalJobView } from "@/lib/career/uiStatus";
import {
  listAbResumeChoices,
  resolveResumeReadFamily,
} from "@/lib/career/resumeReadDispatch";
import {
  dedupeContextItems,
  type AgentConversationContextItem,
  type AgentConversationContextV1,
  type ContextItemRequest,
} from "./conversationContext";

const MAX_CONTEXT_ITEMS = 8;

function jobLabel(job: {
  id: string;
  JobTitle?: { label?: string | null } | null;
  Company?: { label?: string | null } | null;
}): string {
  const label = [job.JobTitle?.label, job.Company?.label]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" · ");
  return label || job.id;
}

async function loadOwnedJob(userId: string, entityId: string) {
  // One active read family. getJob does not fall back to the other table.
  const result = await getJob(prisma, userId, entityId);
  if (result.blocked || !result.job) return null;
  // Archived canonical jobs are invisible to AI: the reference resolves to
  // "not available" and no labelSnapshot is ever attached.
  if (isArchivedCanonicalJobView(result.job)) return null;
  return { id: result.job.id, label: jobLabel(result.job) };
}

async function loadOwnedResume(userId: string, entityId: string) {
  const family = await resolveResumeReadFamily(prisma);
  if (family.family === "blocked") return null;
  if (family.family === "ab") {
    const variant = await prisma.resumeVariant.findFirst({
      where: { id: entityId, userId, archivedAt: null },
      select: { id: true, name: true },
    });
    if (!variant) return null;
    return { id: variant.id, label: variant.name };
  }
  const resume = await prisma.resume.findFirst({
    where: { id: entityId, profile: { userId } },
    select: { id: true, title: true },
  });
  if (!resume) return null;
  return { id: resume.id, label: resume.title };
}

/**
 * Verifies every requested context entity belongs to the user. A job id is
 * resolved through the active jobs read family and stored as kind "job".
 * An id the family cannot see is rejected rather than forwarded.
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
 * Page auto-attach. Missing ids are omitted so a draft never claims a job
 * the active read family cannot see.
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
  const family = await resolveResumeReadFamily(prisma);
  const [listed, resumes] = await Promise.all([
    listJobs(prisma, userId, { take: 40 }),
    family.family === "ab"
      ? listAbResumeChoices(prisma, userId)
      : family.family === "legacy"
        ? prisma.resume.findMany({
            where: { profile: { userId } },
            orderBy: { updatedAt: "desc" },
            take: 40,
            select: { id: true, title: true },
          })
        : Promise.resolve([]),
  ]);
  const jobs = listed.blocked ? [] : listed.data;
  const visibleResumes = family.family === "ab"
    ? resumes.slice(0, 40)
    : resumes;
  return {
    jobs: jobs.map((job) => ({
      kind: "job" as const,
      id: job.id,
      label: job.JobTitle?.label || "Job",
      secondary: job.Company?.label ?? null,
    })),
    resumes: visibleResumes.map((resume) => ({
      kind: "resume" as const,
      id: resume.id,
      label: resume.title,
      secondary: null,
    })),
  };
}

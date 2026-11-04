import prisma from "@/lib/db";
import { resolveBusinessAIConfig } from "@/lib/ai/assignments";
import { canMutateJobsSurface } from "@/lib/career/freshSurfacePolicy";
import {
  listNextActionCandidates,
  selectNextActions,
  type NextActionItem,
} from "@/lib/career/nextActionsReadModel";
import {
  resolveJobsReadFamily,
  type JobsReadFamily,
} from "@/lib/career/jobsReadDispatch";
import {
  resolveResumeReadFamily,
  type ResumeReadFamily,
} from "@/lib/career/resumeReadDispatch";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { getUserTimeZone } from "@/lib/userSettings/timeZone.server";
import { requireUser } from "../shared";

// NEXT-ACTIONS overview read (frozen contract §4): deterministic rule hits
// only — no AI calls, no writes. Family gates and the account zone are
// resolved once here at the action boundary; the read model stays pure.
export type NextActionsData = {
  items: NextActionItem[];
  /** Candidates cut by the 3-item cap — rendered as "+N" (frozen §9 D4). */
  overflowCount: number;
  timeZone: string;
  jobsReadFamily: JobsReadFamily;
  resumeReadFamily: ResumeReadFamily;
};

export const getNextActions = async (): Promise<NextActionsData> => {
  const user = await requireUser();
  const [timeZone, jobs, resume, runtime, aiConfig] = await Promise.all([
    getUserTimeZone(user.id),
    resolveJobsReadFamily(prisma),
    resolveResumeReadFamily(prisma),
    resolveCareerRuntimeMode(prisma),
    // Frozen §9 D2: the homepage agent entry's own purpose, judged on the
    // stored assignment state — RESOLVED does not promise live reachability.
    resolveBusinessAIConfig({ userId: user.id, purpose: "CAREER_DIALOGUE" }),
  ]);

  const candidates = await listNextActionCandidates(prisma, user.id, {
    jobsFamily: jobs.family,
    resumeFamily: resume.family,
    jobMutationsEnabled: canMutateJobsSurface({
      origin: runtime.origin,
      mode: runtime.mode,
      rolloutScope: runtime.rolloutScope,
    }),
    aiConfigStatus: aiConfig.status,
    timeZone,
  });
  const { items, overflowCount } = selectNextActions(candidates);
  return {
    items,
    overflowCount,
    timeZone,
    jobsReadFamily: jobs.family,
    resumeReadFamily: resume.family,
  };
};

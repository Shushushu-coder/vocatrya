import prisma from "@/lib/db";
import type { JobResponse } from "@/models/job.model";

export type JobLookup =
  | { status: "ok"; job: JobResponse }
  | { status: "no_job" };

// Write-oriented lookup for match_job and generate_cover_letter. It stays on
// the legacy Job table so an A+B JobOpportunity id cannot be loaded and then
// persisted through the legacy writers. list_jobs and get_job use
// canonicalJobRead instead. pageContext is client-supplied, which is why
// userId is in the where clause rather than checked afterwards.
export async function resolveJobForAgent(
  userId: string,
  pageJobId?: string,
): Promise<JobLookup> {
  if (!pageJobId) return { status: "no_job" };

  const job = await prisma.job.findFirst({
    where: { id: pageJobId, userId },
    include: { JobTitle: true, Company: true, Location: true },
  });
  if (!job) return { status: "no_job" };

  // Prisma's generated shape is structurally what convertJobToText reads but
  // is not nominally job.model's JobResponse — same cast as resumeLookup.
  return { status: "ok", job: job as unknown as JobResponse };
}

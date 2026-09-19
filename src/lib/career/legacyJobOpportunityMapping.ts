/**
 * Owner-scoped read of the canonical Phase 3 Job → JobOpportunity map.
 *
 * This is a lookup of existing LegacyMigrationMap rows only. It does not
 * create mappings, opportunities, or attempts, and it never treats
 * legacy Job.id as JobOpportunity.id.
 */
import type { PrismaClient } from "@prisma/client";
import { LEGACY, TARGET } from "@/lib/legacy-migration/identities";

export async function resolveOwnedMappedOpportunityId(input: {
  db: PrismaClient;
  userId: string;
  legacyJobId: string;
}): Promise<string | null> {
  const legacyJobId = input.legacyJobId.trim();
  if (!legacyJobId) return null;

  const job = await input.db.job.findFirst({
    where: { id: legacyJobId, userId: input.userId },
    select: { id: true },
  });
  if (!job) return null;

  const maps = await input.db.legacyMigrationMap.findMany({
    where: {
      userId: input.userId,
      legacyEntityType: LEGACY.JOB,
      legacyEntityId: job.id,
      targetEntityType: TARGET.JOB_OPPORTUNITY,
    },
    select: { targetEntityId: true },
  });
  const opportunityIds = [...new Set(maps.map((row) => row.targetEntityId))];
  if (opportunityIds.length !== 1) return null;

  const opportunity = await input.db.jobOpportunity.findFirst({
    where: { id: opportunityIds[0], userId: input.userId },
    select: { id: true },
  });
  return opportunity?.id ?? null;
}

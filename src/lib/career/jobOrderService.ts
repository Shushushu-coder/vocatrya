import type { Prisma, PrismaClient } from "@prisma/client";
import {
  applyOrderChange,
  type JobOrderChange,
  type JobOrderRow,
} from "@/lib/jobs/jobOrder";

// The ordering universe is every job row the user owns in the active family —
// including rows the default list hides (legacy dismissed discoveries,
// archived opportunities) so their pin/order facts survive archive & restore
// and stay consistent under any filtered view.
async function loadOrderUniverse(
  db: PrismaClient | Prisma.TransactionClient,
  family: "legacy" | "ab",
  userId: string,
): Promise<JobOrderRow[]> {
  const select = {
    id: true,
    createdAt: true,
    sortOrder: true,
    pinnedAt: true,
  } as const;
  if (family === "ab") {
    return db.jobOpportunity.findMany({ where: { userId }, select });
  }
  return db.job.findMany({ where: { userId }, select });
}

// Read-modify-write in one transaction: the display order is recomputed from
// stored state, the change is applied on top, and every section is renumbered
// densely — only rows whose (sortOrder, pinnedAt) actually changed are
// written back. Rows on other pages keep their relative order because the
// renumber never reorders them; it only fills gaps.
export async function applyJobOrderChange(
  db: PrismaClient,
  family: "legacy" | "ab",
  userId: string,
  change: JobOrderChange,
): Promise<{ changed: number }> {
  return db.$transaction(async (tx) => {
    const rows = await loadOrderUniverse(tx, family, userId);
    const { updates } = applyOrderChange(rows, change);
    for (const update of updates) {
      const data = { sortOrder: update.sortOrder, pinnedAt: update.pinnedAt };
      if (family === "ab") {
        await tx.jobOpportunity.update({
          where: { id: update.id, userId },
          data,
        });
      } else {
        await tx.job.update({
          where: { id: update.id, userId },
          data,
        });
      }
    }
    return { changed: updates.length };
  });
}

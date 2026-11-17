import "server-only";
import type { Prisma, PrismaClient } from "@prisma/client";
import { decodeHistory } from "./historyCodec";

// Derived prose cannot be reliably redacted. Block replay of the whole
// transcript when it references archived data, preserving the owner's copy.
export async function hasArchivedJobReference(
  db: PrismaClient | Prisma.TransactionClient,
  userId: string,
  ...sources: unknown[]
): Promise<boolean> {
  const archived = await db.jobOpportunity.findMany({
    where: { userId, archivedAt: { not: null } },
    select: { id: true },
  });
  const serialized = JSON.stringify(sources.map(source => typeof source === "string" ? decodeHistory(source) : source));
  return archived.some(({ id }) => serialized.includes(id));
}

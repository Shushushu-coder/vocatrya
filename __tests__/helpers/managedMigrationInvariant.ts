import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { seedAccount } from "./backupTestDb";
export { assertRequiredMigrationInvariants } from "../../scripts/lib/required-migration-invariants.mjs";

/** Behavioral checks use real Prisma writes; SQL inspection alone is insufficient. */
export async function verifyActiveManagedConstraint(db: PrismaClient) {
  const userId = await seedAccount(db, `${randomUUID()}@invariant.example`);
  const otherUserId = await seedAccount(db, `${randomUUID()}@invariant.example`);
  const data = { userId, provider: "VOCATRYA", backendKind: "MANAGED_GATEWAY", authType: "MANAGED", displayName: "Managed", status: "DISCONNECTED" };
  const first = await db.aIConnection.create({ data });
  await expect(db.aIConnection.create({ data })).rejects.toMatchObject({ code: "P2002" });
  await expect(db.aIConnection.create({ data: { ...data, userId: otherUserId } })).resolves.toMatchObject({ userId: otherUserId });
  await db.aIConnection.update({ where: { id: first.id }, data: { archivedAt: new Date() } });
  await expect(db.aIConnection.create({ data })).resolves.toMatchObject({ userId });
  await expect(db.aIConnection.update({ where: { id: first.id }, data: { archivedAt: null } })).rejects.toMatchObject({ code: "P2002" });
}

import { PrismaClient } from "@prisma/client";
import { assertRequiredMigrationInvariants } from "./lib/required-migration-invariants.mjs";
const db = new PrismaClient();
try {
  await assertRequiredMigrationInvariants(db);
  console.log("PASS / REQUIRED_RAW_MIGRATION_INVARIANTS");
} finally {
  await db.$disconnect();
}

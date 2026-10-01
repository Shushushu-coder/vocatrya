import { configureE2EDatabase } from "./support/database";
import { setupTestUser } from "./support/setupTestUser";

export default async function globalSetup() {
  const database = configureE2EDatabase();
  console.log(`[E2E setup] SQLite file: ${database.path}`);
  // Prisma can load the env beside its generated client on import. Resolve
  // Next's env first so a shared node_modules cannot select another DB.
  const { PrismaClient, Prisma } = await import("@prisma/client");
  const prisma = new PrismaClient({ datasourceUrl: database.url });
  try {
    await setupTestUser(prisma);
    console.log("[E2E setup] Test identity and signup baseline ready.");
  } catch (error) {
    // Playwright prints thrown errors. Prisma invocation errors may contain
    // write arguments, so report only a safe error code, never password hashes.
    const code = error instanceof Prisma.PrismaClientKnownRequestError ? error.code : "database error";
    throw new Error(`[E2E setup] Failed (${code}). Check DATABASE_URL and apply existing migrations.`);
  } finally {
    await prisma.$disconnect();
  }
}

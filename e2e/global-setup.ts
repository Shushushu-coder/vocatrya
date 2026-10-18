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
  // R3 runs pin the legacy read/write family: a leaked FRESH_READY or
  // migrated marker would silently rewrite which surface every page
  // exercises, so the shared database is asserted before any test runs.
  if (process.env.R3_EVIDENCE_DIR) {
    // Lazy require, not import(): Playwright transforms files to CJS, so a
    // dynamic import() would hit the Node ESM loader and fail on .ts, while
    // require() goes through the transform hook. It stays lazy because this
    // module also runs under ts-node (test:e2e:setup), which cannot resolve
    // the "@/..." aliases inside the harness import chain.
    const { assertR3LegacyJobsFamily } =
      require("./support/r3Harness") as typeof import("./support/r3Harness");
    await assertR3LegacyJobsFamily(database.url);
  }
}

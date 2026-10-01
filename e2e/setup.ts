import globalSetup from "./global-setup";

globalSetup().catch(() => {
  // Prisma errors can include connection details; do not dump them to stdout.
  console.error("E2E setup failed. Check DATABASE_URL and apply the existing migrations.");
  process.exitCode = 1;
});

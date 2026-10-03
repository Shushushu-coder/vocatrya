import { vi } from "vitest";

// Re-run existing resume regressions without their usual Prisma CLI db push.
vi.mock("./backupTestDb", async (importOriginal) => {
  const original = await importOriginal<typeof import("./backupTestDb")>();
  const { initializeResumeExportTestDb } = await import("./resumeExportTestDb");
  return { ...original, pushSchema: initializeResumeExportTestDb };
});

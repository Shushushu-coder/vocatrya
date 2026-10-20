import type { PrismaClient } from "@prisma/client";
import { resolveJobsReadFamily } from "@/lib/career/jobsReadDispatch";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";
import { isFreshNativeFullSurface } from "@/lib/career/freshSurfacePolicy";
import { assertLegacyCareerWriteAllowed } from "@/lib/career/writeGuard";

// Resolve the actual synthetic instance contract before choosing assertions.
// Missing UI must never choose the branch or silently downgrade a test.
export async function readE2ERuntimeContract(prisma: PrismaClient) {
  const runtime = await resolveCareerRuntimeMode(prisma);
  const { family } = await resolveJobsReadFamily(prisma);
  if (family === "blocked") {
    throw new Error(`E2E jobs are blocked: ${runtime.reason}`);
  }
  let legacyWritesAllowed = true;
  try {
    await assertLegacyCareerWriteAllowed(prisma);
  } catch (error) {
    if ((error as { code?: string }).code !== "LEGACY_WRITE_BLOCKED") throw error;
    legacyWritesAllowed = false;
  }
  const contract = {
    family,
    freshNativeFull: isFreshNativeFullSurface(runtime),
    legacyWritesAllowed,
    origin: runtime.origin,
    mode: runtime.mode,
    rolloutScope: runtime.rolloutScope,
  };
  console.log(`[e2e-runtime] ${JSON.stringify(contract)}`);
  return contract;
}

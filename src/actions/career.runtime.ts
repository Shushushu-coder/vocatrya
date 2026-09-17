"use server";
import prisma from "@/lib/db";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";

export async function getCareerRuntimeSnapshot() {
  const resolved = await resolveCareerRuntimeMode(prisma);
  return {
    mode: resolved.mode,
    reason: resolved.reason,
    migrationStatus: resolved.migrationStatus,
    featureEnabled: resolved.featureEnabled,
    writeFamily: resolved.writeFamily,
  };
}

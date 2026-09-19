"use server";
import prisma from "@/lib/db";
import {
  isFullAbCapabilityEnabled,
  isResumeV1CapabilityEnabled,
  resolveAbRolloutScope,
} from "@/lib/career/capabilities";
import { resolveCareerRuntimeMode } from "@/lib/career/runtimeMode";

export async function getCareerRuntimeSnapshot() {
  const resolved = await resolveCareerRuntimeMode(prisma);
  const rolloutScope = resolveAbRolloutScope();
  return {
    mode: resolved.mode,
    reason: resolved.reason,
    migrationStatus: resolved.migrationStatus,
    featureEnabled: resolved.featureEnabled,
    writeFamily: resolved.writeFamily,
    rolloutScope,
    resumeV1Enabled: isResumeV1CapabilityEnabled(resolved.mode, rolloutScope),
    fullAbEnabled: isFullAbCapabilityEnabled(resolved.mode, rolloutScope),
  };
}

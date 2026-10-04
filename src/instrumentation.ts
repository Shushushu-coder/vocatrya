export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (process.env.NEXT_PHASE !== "phase-production-build") {
      await logEffectiveCareerRuntime();
    }
    const { syncSchedulerState } = await import("@/lib/scheduler");
    await syncSchedulerState();
  }
}

async function logEffectiveCareerRuntime(): Promise<void> {
  try {
    const prisma = (await import("@/lib/db")).default;
    const { resolveCareerRuntimeMode } = await import("@/lib/career/runtimeMode");
    const resolved = await resolveCareerRuntimeMode(prisma);
    const feature = resolved.featureEnabled ? "enabled" : "disabled";
    const line = [
      `state=${resolved.migrationStatus}`,
      `mode=${resolved.mode}`,
      `feature=${feature}`,
      `featureSource=${resolved.configSource.feature}`,
      `scope=${resolved.rolloutScope}`,
      `scopeSource=${resolved.configSource.scope}`,
      `writeFamily=${resolved.writeFamily}`,
    ].join(" ");
    console.info(`career-runtime ${line}`);
  } catch {
    console.info("career-runtime state=unavailable");
  }
}

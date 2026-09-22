import "server-only";

import prisma from "@/lib/db";
import { createInterviewRuntime, type InterviewRuntime } from "./services/application";
import type { InterviewModelPort } from "./hostPorts";

let cached: InterviewRuntime | null = null;

export function getInterviewRuntime(overrides?: {
  modelPort?: InterviewModelPort;
}): InterviewRuntime {
  if (overrides?.modelPort) {
    return createInterviewRuntime({ db: prisma, modelPort: overrides.modelPort });
  }
  cached ??= createInterviewRuntime({ db: prisma });
  return cached;
}

export function resetInterviewRuntimeForTests(): void {
  cached = null;
}

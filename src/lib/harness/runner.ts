import "server-only";

import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import prisma from "@/lib/db";
import type { ExecuteAIConnectionTextDeps } from "@/lib/ai/execution";
import { log } from "@/lib/telemetry";
import { executeDeepMatchTask } from "./deepMatch";
import { executeAgentWriteTask } from "./agentWrite";
import {
  claimNextHarnessTask,
  mintHarnessRunnerId,
  renewHarnessLease,
  sweepHarnessTasks,
  type HarnessClaim,
} from "./taskService";
import { HARNESS_TASK_KIND, HARNESS_TASK_STATUS } from "./types";

/**
 * Process-local harness runner — lives in the Next.js backend process
 * (the one Electron spawns; `next dev`/`next start` behave identically).
 * When the app closes the process dies and execution stops with it; on
 * the next start, instrumentation re-registers the runner and the
 * DB-backed claim rediscovers QUEUED work and reclaims expired leases.
 *
 * Execution is serial: one claimed task at a time. Concurrency control
 * is the database claim CAS — the in-process structures below are only
 * this runner's bookkeeping, never the authority.
 */

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 5_000;
const SWEEP_INTERVAL_MS = 15_000;

const RUNNER_ID = mintHarnessRunnerId();

type ActiveRun = {
  claim: HarnessClaim;
  abort: AbortController;
  heartbeat: NodeJS.Timeout;
};

const activeRuns = new Map<string, ActiveRun>();
let ticking = false;
let sweepTimer: NodeJS.Timeout | null = null;
let pendingKick = false;

function heartbeatTick(db: PrismaClient, run: ActiveRun): void {
  void (async () => {
    const renewed = await renewHarnessLease(db, run.claim, LEASE_MS);
    if (renewed.ok) return;
    // Lost the lease (newer claim) or the task flipped CANCELLING —
    // either way this execution must stop; the abort lets the model
    // call unwind and every guarded write is refused anyway.
    run.abort.abort();
  })().catch((error) => {
    log.error("[harness] lease heartbeat failed", {
      taskId: run.claim.taskId,
      error: String(error),
    });
  });
}

async function runClaimed(
  db: PrismaClient,
  claim: HarnessClaim,
  deps?: ExecuteAIConnectionTextDeps,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  const abort = new AbortController();
  const run: ActiveRun = {
    claim,
    abort,
    heartbeat: setInterval(() => heartbeatTick(db, run), HEARTBEAT_MS),
  };
  activeRuns.set(claim.taskId, run);
  try {
    // One claim/lease/heartbeat for every kind — the executor is the only
    // kind-specific part.
    if (claim.kind === HARNESS_TASK_KIND.AGENT_TOOL_WRITE) {
      await executeAgentWriteTask(db, claim, { signal: abort.signal, execDeps: deps });
    } else {
      await executeDeepMatchTask(db, claim, {
        deps,
        env,
        signal: abort.signal,
      });
    }
  } finally {
    clearInterval(run.heartbeat);
    if (activeRuns.get(claim.taskId) === run) {
      activeRuns.delete(claim.taskId);
    }
  }
}

/**
 * One scheduling pass: settle expired cancel-pending rows, then claim and
 * run available work serially until nothing is claimable. Overlapping
 * ticks coalesce — a tick in flight just marks the next pass pending.
 */
export async function harnessRunnerTick(
  db: PrismaClient = prisma,
  deps?: ExecuteAIConnectionTextDeps,
  env?: NodeJS.ProcessEnv,
): Promise<void> {
  if (ticking) {
    pendingKick = true;
    return;
  }
  ticking = true;
  try {
    do {
      pendingKick = false;
      await sweepHarnessTasks(db);
      for (;;) {
        const claim = await claimNextHarnessTask(db, {
          owner: RUNNER_ID,
          leaseMs: LEASE_MS,
        });
        if (!claim) break;
        await runClaimed(db, claim, deps, env);
      }
    } while (pendingKick);
  } finally {
    ticking = false;
  }
}

/** Non-blocking kick — used right after task creation and by the timer. */
export function kickHarnessRunner(
  db: PrismaClient = prisma,
  deps?: ExecuteAIConnectionTextDeps,
  env?: NodeJS.ProcessEnv,
): void {
  void harnessRunnerTick(db, deps, env).catch((error) => {
    log.error("[harness] runner tick failed", { error: String(error) });
  });
}

/**
 * Register the periodic discovery pass. Safe to call repeatedly — the
 * interval exists once per process. The interval is what catches leases
 * that expire *after* startup (a start-time-only sweep would miss them).
 */
export function startHarnessRunner(
  db: PrismaClient = prisma,
  deps?: ExecuteAIConnectionTextDeps,
  env?: NodeJS.ProcessEnv,
): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(
    () => kickHarnessRunner(db, deps, env),
    SWEEP_INTERVAL_MS,
  );
  // Do not hold the process open for the sweeper alone.
  sweepTimer.unref?.();
  kickHarnessRunner(db, deps, env);
}

export function stopHarnessRunnerForTests(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  for (const run of activeRuns.values()) {
    clearInterval(run.heartbeat);
    run.abort.abort();
  }
  activeRuns.clear();
}

/** Test introspection — which tasks this process currently executes. */
export function activeHarnessRuns(): string[] {
  return [...activeRuns.keys()];
}

export const HARNESS_RUNNER_CONSTANTS = {
  LEASE_MS,
  HEARTBEAT_MS,
  SWEEP_INTERVAL_MS,
  RUNNER_ID,
} as const;

export { HARNESS_TASK_STATUS };

/**
 * Mandatory Phase 2 auditor preflight for any writable backfill.
 *
 * Known-safe Phase 2 conclusions (Job.resumeId = DO_NOT_MAP, resume ordering
 * = ORDER_UNRECOVERABLE) do not block execution — Phase 3 already defines
 * their behavior.
 */

import {
  JOB_RESUME_ID_CLASSIFICATION,
  RESUME_ORDERING_CLASSIFICATION,
  runPhase2DryRun,
  type Phase2Report,
} from "./phase2Auditor";

export type PreflightResult = {
  ok: boolean;
  blockers: string[];
  report: Phase2Report;
};

export function evaluateWritablePreflight(report: Phase2Report): {
  ok: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];

  if (report.read_only_proof.BLOCKED_BY_SAFE_READ_ONLY_ACCESS) {
    blockers.push("Safe read-only preflight access could not be established");
  }
  if (report.job_status_matrix_reconciliation.JOB_STATUS_MAPPING === "BLOCKED") {
    blockers.push("Job lifecycle matrix does not reconcile with inventory");
  }
  if (report.dry_run_counts.unknownLifecycleStates > 0) {
    blockers.push(
      `Unknown JobStatus / unmapped lifecycle rows: ${report.dry_run_counts.unknownLifecycleStates}`,
    );
  }
  for (const blocker of report.phase3_blockers) {
    if (!blockers.includes(blocker)) blockers.push(blocker);
  }

  // Explicitly do not treat these as blockers.
  void JOB_RESUME_ID_CLASSIFICATION;
  void RESUME_ORDERING_CLASSIFICATION;

  return { ok: blockers.length === 0, blockers };
}

export function runWritablePreflight(options: {
  repoRoot: string;
  dbPath: string;
}): PreflightResult {
  const report = runPhase2DryRun({
    repoRoot: options.repoRoot,
    disposableDbPath: options.dbPath,
  });
  const evaluated = evaluateWritablePreflight(report);
  return { ...evaluated, report };
}

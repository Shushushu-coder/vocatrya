// Vocatrya A+B Phase 2 dry-run auditor CLI.
// Run: node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-sqlite scripts/legacy-migration-dry-run.mts
//
// Imports carry a .ts extension because Node's type stripping is ESM and needs
// explicit ones. tsconfig excludes scripts/, so tsc never sees this file.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { runPhase2DryRun } from "../src/lib/legacy-migration/phase2Auditor.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const OUTPUT_DIR = path.join(
  REPO_ROOT,
  "docs",
  "phases",
  "phase-ab-legacy-migration-dry-run",
);

function git(args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

const report = runPhase2DryRun({
  repoRoot: REPO_ROOT,
  outputDir: OUTPUT_DIR,
  git: {
    branch: git(["branch", "--show-current"]),
    head: git(["rev-parse", "HEAD"]),
    statusShort: git(["status", "--short"]),
    upstream: git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]),
  },
});

process.stdout.write(
  [
    `PHASE2_AUDIT_STATUS=${report.acceptance.PHASE2_AUDIT_STATUS}`,
    `PHASE3_MIGRATION_READINESS=${report.acceptance.PHASE3_MIGRATION_READINESS}`,
    `REAL_DATABASE_WRITE_OPERATIONS=0`,
    `JOB_RESUME_ID=${report.job_resume_id_assessment.classification}`,
    `RESUME_ORDERING=${report.resume_ordering_assessment.classification}`,
    `JOB_STATUS_MAPPING=${report.job_status_matrix_reconciliation.JOB_STATUS_MAPPING}`,
    `output=${OUTPUT_DIR}`,
    "",
  ].join("\n"),
);

if (report.acceptance.PHASE2_AUDIT_STATUS === "BLOCKED") {
  process.exitCode = 1;
}

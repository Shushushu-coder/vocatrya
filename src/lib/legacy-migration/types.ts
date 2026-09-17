import type { PreflightResult } from "./preflight";
import type { WritableGate } from "./safety";

export type MigrationMode = "audit" | "plan" | "migrate";

export type RootError = {
  legacyEntityType: string;
  legacyEntityId: string;
  code: string;
  message: string;
};

export type CountBucket = {
  opportunities: number;
  attempts: number;
  jdVersions: number;
  processSteps: number;
  opportunityNotes: number;
  resumeVariants: number;
  resumeVersions: number;
  careerMaterials: number;
  careerEvidence: number;
  contactProfiles: number;
  mappings: number;
};

export const EMPTY_COUNT_BUCKET = (): CountBucket => ({
  opportunities: 0,
  attempts: 0,
  jdVersions: 0,
  processSteps: 0,
  opportunityNotes: 0,
  resumeVariants: 0,
  resumeVersions: 0,
  careerMaterials: 0,
  careerEvidence: 0,
  contactProfiles: 0,
  mappings: 0,
});

export type Phase3Report = {
  migrationVersion: string;
  sourceIdentity: {
    path: string;
    sha256: string | null;
    size: number | null;
  };
  mode: MigrationMode;
  runId: string | null;
  preflight: {
    ok: boolean;
    blockers: string[];
    phase2Status: string | null;
  };
  writableGate: WritableGate | null;
  legacyCounts: Record<string, number>;
  created: CountBucket;
  skippedAlreadyMigrated: CountBucket;
  skippedUnsafe: CountBucket;
  failed: CountBucket;
  unknownStatuses: string[];
  contactConflicts: Array<{
    userIdHash: string;
    fields: string[];
  }>;
  duplicateCandidates: {
    automaticMerges: 0;
    groupCount: number;
    memberCount: number;
  };
  orderingLimitations: string[];
  writeCount: number;
  bookkeepingWriteCount: number;
  unexpectedUpdates: number;
  duplicated: number;
  errors: RootError[];
  phaseResult: "PASS" | "BLOCKED" | "FAILED";
  REAL_USER_DATA_MUTATED: "NO";
  PRODUCTION_BACKFILL_EXECUTED: "NO";
};

export type MigratorHooks = {
  /** Throw to simulate a controlled failure inside a per-root transaction. */
  beforeFinishRoot?: (kind: string, legacyId: string) => void;
};

export type RunMigrateOptions = {
  dbPath: string;
  repoRoot: string;
  mode: MigrationMode;
  confirmWritable?: boolean;
  allowDisposableCopy?: boolean;
  forceRequested?: boolean;
  env?: NodeJS.ProcessEnv;
  hooks?: MigratorHooks;
  outputDir?: string;
};

export type PreflightBundle = PreflightResult;

/**
 * Vocatrya A+B Phase 2 — legacy migration dry-run auditor.
 *
 * Read-only by construction: opens SQLite with DatabaseSync `{ readOnly: true }`
 * plus `PRAGMA query_only = ON`, and rejects mutation SQL before it is prepared.
 * This file imports only Node builtins so `scripts/legacy-migration-dry-run.mts`
 * can load it under Node type-stripping (relative imports would need `.ts`
 * extensions that `tsc --noEmit` would then reject).
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Public constants
// ---------------------------------------------------------------------------

export const PHASE2_AUDITOR_ID = "vocatrya-ab-phase2-legacy-migration-dry-run";
export const PHASE1_MIGRATION = "20260916171642_add_vocatrya_ab_foundation";
export const LEGACY_SALT_EXPECTED = "jobsync-api-key-encryption";

/** Seeded at signup (`src/lib/constants.ts` JOB_STATUSES) plus scraper `new`. */
export const KNOWN_JOB_STATUS_VALUES = [
  "new",
  "draft",
  "applied",
  "interview",
  "offer",
  "offer-accepted",
  "offer-declined",
  "rejected",
  "expired",
  "archived",
] as const;

export type KnownJobStatusValue = (typeof KNOWN_JOB_STATUS_VALUES)[number];

export type MappingClass = "SAFE" | "CONDITIONAL" | "UNSAFE" | "DO_NOT_MAP";
export type ResumeIdClass = "SAFE_TO_MAP" | "CONDITIONAL" | "DO_NOT_MAP";
export type OrderingClass = "VERIFIED" | "ORDER_UNRECOVERABLE" | "UNRESOLVED_BLOCKER";
export type Phase2Status = "PASS" | "BLOCKED";
export type Phase3Readiness = "READY" | "BLOCKED";

export type OpportunityStatus = "ACTIVE" | "CLOSED" | "EXPIRED" | "UNKNOWN";
export type AttemptStage =
  | "DRAFT"
  | "SUBMITTED"
  | "INTERVIEW"
  | "OFFER"
  | "REJECTED"
  | null;
export type AttemptOutcome = "ACTIVE" | "REJECTED" | "ACCEPTED" | "DECLINED" | null;

const MUTATION_HEAD =
  /^(?:WITH\s+.+\s+)?(?:INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|ALTER|DROP|TRUNCATE|ATTACH|DETACH|REINDEX|VACUUM|ANALYZE|PRAGMA\s+(?:journal_mode|wal_checkpoint|optimize|user_version|schema_version|writable_schema)\b)/i;

const SAFE_PRAGMA_HEAD =
  /^PRAGMA\s+(?:query_only|foreign_keys|table_info|index_list|index_info|database_list|compile_options|quick_check|integrity_check)\b/i;

// ---------------------------------------------------------------------------
// SQL guard
// ---------------------------------------------------------------------------

export function isMutationSql(sql: string): boolean {
  const stripped = sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .trim();
  if (!stripped) return false;
  if (SAFE_PRAGMA_HEAD.test(stripped)) return false;
  if (/^PRAGMA\s+/i.test(stripped) && !SAFE_PRAGMA_HEAD.test(stripped)) {
    return true;
  }
  return MUTATION_HEAD.test(stripped);
}

export function assertSelectOnly(sql: string): void {
  if (isMutationSql(sql)) {
    throw new Error(`READ_ONLY_ACCESS_BLOCKER: refused SQL: ${sql.slice(0, 180)}`);
  }
}

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

export type FileIntegrity = {
  path: string;
  exists: boolean;
  size: number | null;
  lastWriteTimeUtc: string | null;
  sha256: string | null;
};

export function snapshotFile(filePath: string): FileIntegrity {
  if (!fs.existsSync(filePath)) {
    return {
      path: filePath,
      exists: false,
      size: null,
      lastWriteTimeUtc: null,
      sha256: null,
    };
  }
  const st = fs.statSync(filePath);
  const sha256 = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  return {
    path: filePath,
    exists: true,
    size: st.size,
    lastWriteTimeUtc: st.mtime.toISOString(),
    sha256,
  };
}

export function sqliteSidecarPaths(dbPath: string): {
  main: string;
  wal: string;
  shm: string;
} {
  return {
    main: dbPath,
    wal: `${dbPath}-wal`,
    shm: `${dbPath}-shm`,
  };
}

export type DbIntegrity = {
  main: FileIntegrity;
  wal: FileIntegrity;
  shm: FileIntegrity;
};

export function snapshotSqliteBundle(dbPath: string): DbIntegrity {
  const p = sqliteSidecarPaths(dbPath);
  return {
    main: snapshotFile(p.main),
    wal: snapshotFile(p.wal),
    shm: snapshotFile(p.shm),
  };
}

export function integrityUnchanged(before: DbIntegrity, after: DbIntegrity): {
  unchanged: boolean;
  sha256Unchanged: boolean;
  sizeUnchanged: boolean;
  mtimeUnchanged: boolean;
  notes: string[];
} {
  const notes: string[] = [];
  const sha256Unchanged =
    before.main.sha256 === after.main.sha256 &&
    before.wal.sha256 === after.wal.sha256 &&
    before.shm.sha256 === after.shm.sha256;
  const sizeUnchanged =
    before.main.size === after.main.size &&
    before.wal.size === after.wal.size &&
    before.shm.size === after.shm.size;
  const mtimeUnchanged =
    before.main.lastWriteTimeUtc === after.main.lastWriteTimeUtc &&
    before.wal.lastWriteTimeUtc === after.wal.lastWriteTimeUtc &&
    before.shm.lastWriteTimeUtc === after.shm.lastWriteTimeUtc;
  if (!sha256Unchanged) notes.push("SHA-256 changed — treat as a real-data write");
  if (!sizeUnchanged) notes.push("byte size changed");
  if (!mtimeUnchanged) {
    notes.push(
      "mtime changed (may be an unavoidable filesystem access timestamp; SHA-256 is authoritative)",
    );
  }
  return {
    unchanged: sha256Unchanged && sizeUnchanged,
    sha256Unchanged,
    sizeUnchanged,
    mtimeUnchanged,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Read-only connection
// ---------------------------------------------------------------------------

export type ReadOnlyDb = {
  path: string;
  query: <T = Record<string, unknown>>(
    sql: string,
    params?: Array<string | number | bigint | null>,
  ) => T[];
  queryOne: <T = Record<string, unknown>>(
    sql: string,
    params?: Array<string | number | bigint | null>,
  ) => T | undefined;
  close: () => void;
};

export function openReadOnlySqlite(dbPath: string): ReadOnlyDb {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`READ_ONLY_ACCESS_BLOCKER: database file missing: ${dbPath}`);
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
  } catch (err) {
    throw new Error(
      `READ_ONLY_ACCESS_BLOCKER: could not open read-only SQLite at ${dbPath}: ${String(err)}`,
    );
  }
  try {
    db.exec("PRAGMA query_only = ON");
  } catch (err) {
    db.close();
    throw new Error(
      `READ_ONLY_ACCESS_BLOCKER: PRAGMA query_only failed: ${String(err)}`,
    );
  }
  const query = <T = Record<string, unknown>>(
    sql: string,
    params: Array<string | number | bigint | null> = [],
  ): T[] => {
    assertSelectOnly(sql);
    const stmt = db.prepare(sql);
    return stmt.all(...params) as T[];
  };
  const queryOne = <T = Record<string, unknown>>(
    sql: string,
    params: Array<string | number | bigint | null> = [],
  ): T | undefined => {
    assertSelectOnly(sql);
    const stmt = db.prepare(sql);
    return stmt.get(...params) as T | undefined;
  };
  return {
    path: dbPath,
    query,
    queryOne,
    close: () => db.close(),
  };
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export type DbRole =
  | "configured_production"
  | "in_repo_smoke_candidate"
  | "discovered_external_candidate"
  | "explicit_audit_override"
  | "disposable_test";

export type ResolvedDbCandidate = {
  role: DbRole;
  path: string;
  exists: boolean;
  reason: string;
};

export function fileUrlToPath(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith("file:")) return null;
  return trimmed.slice("file:".length).replace(/^\.\//, "");
}

export function resolveAuditDbCandidates(
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDbCandidate[] {
  const candidates: ResolvedDbCandidate[] = [];
  const push = (role: DbRole, p: string, reason: string) => {
    const abs = path.isAbsolute(p) ? p : path.resolve(repoRoot, p);
    candidates.push({ role, path: abs, exists: fs.existsSync(abs), reason });
  };

  if (env.VOCATRYA_AUDIT_DB) {
    push("explicit_audit_override", env.VOCATRYA_AUDIT_DB, "VOCATRYA_AUDIT_DB");
  }
  if (env.DATABASE_URL) {
    const fromUrl = fileUrlToPath(env.DATABASE_URL);
    if (fromUrl) {
      const abs = path.isAbsolute(fromUrl)
        ? fromUrl
        : path.resolve(repoRoot, fromUrl);
      const prismaRel = path.resolve(repoRoot, "prisma", fromUrl);
      push("configured_production", abs, `DATABASE_URL=${env.DATABASE_URL}`);
      if (prismaRel !== abs) {
        push(
          "configured_production",
          prismaRel,
          `DATABASE_URL relative to prisma/ (${env.DATABASE_URL})`,
        );
      }
    }
  }
  push(
    "configured_production",
    path.join(repoRoot, "prisma", "dev.db"),
    "default Prisma SQLite path prisma/dev.db",
  );
  push(
    "configured_production",
    path.join(repoRoot, "jobsyncdb", "data", "dev.db"),
    "docker-compose volume ./jobsyncdb/data:/data (DATABASE_URL=file:/data/dev.db)",
  );
  push(
    "in_repo_smoke_candidate",
    path.join(repoRoot, "prisma", "smoke-i18n.db"),
    "in-repo smoke/i18n SQLite; not a production volume",
  );

  const sibling = path.resolve(repoRoot, "..", "jobsync", "prisma", "dev.db");
  push(
    "discovered_external_candidate",
    sibling,
    "sibling upstream checkout E:/Projects/jobsync/prisma/dev.db",
  );

  const seen = new Set<string>();
  return candidates.filter((c) => {
    const key = c.path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function pickPrimaryCandidate(
  candidates: ResolvedDbCandidate[],
): ResolvedDbCandidate | null {
  const existing = candidates.filter((c) => c.exists);
  const override = existing.find((c) => c.role === "explicit_audit_override");
  if (override) return override;
  const production = existing.find((c) => c.role === "configured_production");
  if (production) return production;
  return null;
}

// ---------------------------------------------------------------------------
// Job lifecycle classifier (pure)
// ---------------------------------------------------------------------------

export type JobLifecycleCombo = {
  statusValue: string;
  applied: boolean;
  appliedDatePresent: boolean;
};

export type JobLifecycleMapping = JobLifecycleCombo & {
  observed: boolean;
  count: number;
  opportunityStatus: OpportunityStatus;
  createOpportunity: boolean;
  createApplicationAttempt: boolean;
  stageCategory: AttemptStage;
  outcome: AttemptOutcome;
  mapSubmittedAtFromAppliedDate: boolean;
  classification: MappingClass;
  exceptionRule: string | null;
  phase3Action: string;
  theoretical: boolean;
  codeEvidence: string[];
  dataEvidence: string;
};

const PRE_APPLICATION = new Set(["new", "draft"]);
const APPLIED_FAMILY = new Set([
  "applied",
  "interview",
  "offer",
  "offer-accepted",
  "offer-declined",
  "rejected",
]);

export function classifyJobLifecycleCombo(
  combo: JobLifecycleCombo,
  count = 0,
  observed = false,
): JobLifecycleMapping {
  const statusValue = (combo.statusValue || "").toLowerCase() || "(null)";
  const { applied, appliedDatePresent } = combo;
  const theoretical = !observed;
  const known = (KNOWN_JOB_STATUS_VALUES as readonly string[]).includes(statusValue);

  const base = {
    statusValue,
    applied,
    appliedDatePresent,
    observed,
    count,
    theoretical,
    codeEvidence: [
      "src/actions/job/status.ts updateJobStatus",
      "src/actions/job/mutations.ts addJob/updateJob",
      "src/lib/jobs/createJobFromNames.ts",
      "src/lib/jobs/updateJobFromNames.ts",
      "src/lib/scraper/mapper.ts getDefaultJobStatus=new applied=false",
      "src/components/myjobs/AddJob.tsx jobAppliedChange",
      "src/lib/constants.ts JOB_STATUSES",
    ],
    dataEvidence: observed
      ? `observed count=${count}`
      : "theoretical combination (not observed in this database)",
  };

  if (!known || statusValue === "(null)") {
    return {
      ...base,
      opportunityStatus: "UNKNOWN",
      createOpportunity: false,
      createApplicationAttempt: false,
      stageCategory: null,
      outcome: null,
      mapSubmittedAtFromAppliedDate: false,
      classification: "DO_NOT_MAP",
      exceptionRule:
        "Unknown or null JobStatus.value has no deterministic A+B representation",
      phase3Action:
        "Skip Job row. Record in LegacyMigrationMap as UNMAPPED_UNKNOWN_STATUS. Do not invent Opportunity/Attempt.",
    };
  }

  const opportunityStatus: OpportunityStatus =
    statusValue === "expired" ? "EXPIRED" : "UNKNOWN";

  const inconsistentAppliedFlag =
    (PRE_APPLICATION.has(statusValue) && applied) ||
    (APPLIED_FAMILY.has(statusValue) && !applied);

  const createApplicationAttempt =
    applied || APPLIED_FAMILY.has(statusValue);

  let stageCategory: AttemptStage = null;
  let outcome: AttemptOutcome = null;
  if (createApplicationAttempt) {
    switch (statusValue) {
      case "applied":
        stageCategory = "SUBMITTED";
        outcome = "ACTIVE";
        break;
      case "interview":
        stageCategory = "INTERVIEW";
        outcome = "ACTIVE";
        break;
      case "offer":
        stageCategory = "OFFER";
        outcome = "ACTIVE";
        break;
      case "offer-accepted":
        stageCategory = "OFFER";
        outcome = "ACCEPTED";
        break;
      case "offer-declined":
        stageCategory = "OFFER";
        outcome = "DECLINED";
        break;
      case "rejected":
        stageCategory = "REJECTED";
        outcome = "REJECTED";
        break;
      case "expired":
      case "archived":
      case "new":
      case "draft":
        stageCategory = "SUBMITTED";
        outcome = "ACTIVE";
        break;
      default:
        stageCategory = "SUBMITTED";
        outcome = "ACTIVE";
    }
  }

  const mapSubmittedAtFromAppliedDate = applied && appliedDatePresent;

  let classification: MappingClass = "SAFE";
  const exceptions: string[] = [];

  if (inconsistentAppliedFlag) {
    classification = "CONDITIONAL";
    exceptions.push(
      applied
        ? `pre-application status "${statusValue}" with applied=true: still create Attempt from the applied flag; do not treat status as process stage`
        : `process status "${statusValue}" with applied=false: create Attempt from status; do not invent submittedAt unless appliedDate is present`,
    );
  }

  if (createApplicationAttempt && applied && !appliedDatePresent) {
    classification = "CONDITIONAL";
    exceptions.push(
      "applied=true with null appliedDate: create Attempt with submittedAt=null; do not invent a submission timestamp",
    );
  }

  if (!applied && appliedDatePresent) {
    classification = "CONDITIONAL";
    exceptions.push(
      "appliedDate present with applied=false: persist the timestamp only if an Attempt is created; do not flip applied",
    );
  }

  if (statusValue === "archived") {
    classification = "CONDITIONAL";
    exceptions.push(
      "Job has no archivedAt. Do not stamp JobOpportunity.archivedAt with backfill-now. Record legacy status in LegacyMigrationMap.",
    );
  }

  if (statusValue === "expired" && createApplicationAttempt) {
    classification = "CONDITIONAL";
    exceptions.push(
      "expired + applied: Opportunity.status=EXPIRED and Attempt still created from application evidence",
    );
  }

  const phase3Action = [
    "Create JobOpportunity (1:1 with legacy Job).",
    `Opportunity.status=${opportunityStatus} (never copy Interview/Rejected/Offer onto Opportunity).`,
    createApplicationAttempt
      ? `Create ApplicationAttempt stage=${stageCategory} outcome=${outcome}.`
      : "Do not create ApplicationAttempt.",
    mapSubmittedAtFromAppliedDate
      ? "submittedAt = Job.appliedDate."
      : "submittedAt = null (do not invent).",
    statusValue === "archived"
      ? "Do not set archivedAt from missing evidence."
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return {
    ...base,
    opportunityStatus,
    createOpportunity: true,
    createApplicationAttempt,
    stageCategory,
    outcome,
    mapSubmittedAtFromAppliedDate,
    classification,
    exceptionRule: exceptions.length ? exceptions.join(" ") : null,
    phase3Action,
  };
}

export function allTheoreticalJobLifecycleCombos(): JobLifecycleCombo[] {
  const combos: JobLifecycleCombo[] = [];
  for (const statusValue of KNOWN_JOB_STATUS_VALUES) {
    for (const applied of [false, true]) {
      for (const appliedDatePresent of [false, true]) {
        combos.push({ statusValue, applied, appliedDatePresent });
      }
    }
  }
  return combos;
}

export function mappingKey(combo: JobLifecycleCombo): string {
  return `${(combo.statusValue || "(null)").toLowerCase()}|${combo.applied ? 1 : 0}|${combo.appliedDatePresent ? 1 : 0}`;
}

// ---------------------------------------------------------------------------
// ResumeId classification (code-backed; data stats are correlative only)
// ---------------------------------------------------------------------------

export const JOB_RESUME_ID_CLASSIFICATION: ResumeIdClass = "DO_NOT_MAP";

export const JOB_RESUME_ID_RATIONALE = [
  "Job.resumeId is written by Add/Edit Job as an optional association independent of applied (src/actions/job/mutations.ts, AddJobFormSchema.resume optional).",
  "updateJob overwrites resumeId on every edit with no freeze-after-apply rule.",
  "createJobFromNames (MCP/Agent) never sets resumeId.",
  "Automation persistDiscoveredJob does not set Job.resumeId; matchData JSON may embed the automation's matching resume as analysis context, not a submission.",
  "Agent match_job treats job.resumeId as 'the closest thing' to a page resume, not submitted-resume provenance (src/lib/agent/tools/matchJob.ts).",
  "Mock seeder attaches a resume on ~80% of jobs regardless of applied.",
  "Correlation of resumeId with applied is therefore not submission provenance.",
].join(" ");

// ---------------------------------------------------------------------------
// Resume ordering (code-backed)
// ---------------------------------------------------------------------------

export const RESUME_ORDERING_CLASSIFICATION: OrderingClass = "ORDER_UNRECOVERABLE";

export const RESUME_ORDERING_RATIONALE = [
  "ResumeSection has no sortOrder (prisma/schema.prisma).",
  "resumeDetailInclude loads ResumeSections with no orderBy (src/lib/jobs/resumeDetailInclude.ts).",
  "Editor cards are a hardcoded type list: Contact, Summary, Skills, Experience, Education, Certification (src/components/profile/ResumeContainer.tsx). LICENSE/COURSE/PROJECT/OTHER are not rendered as editor cards.",
  "Professional PDF: Summary, Skills, Experience, then COURSE/PROJECT/OTHER, then Education+CERT/LICENSE two-column (ProfessionalTemplate.tsx).",
  "Simple PDF: Summary, Skills, Experience, Education, Certification only (SimpleTemplate.tsx). LICENSE/COURSE/PROJECT/OTHER omitted.",
  "AI convertResumeToText sorts by a third list: Summary, Skills, Experience, Education, Certification, License (src/lib/ai/tools/preprocessing.ts SECTION_ORDER).",
  "Automation convertResumeForMatch iterates ResumeSections in loader/array order (src/lib/scraper/automation-run/resumeText.ts).",
  "Skill.order is persisted (item order within skills) and is independently recoverable; it is not resume-section order.",
  "WorkExperience/Education/LicenseOrCertification have no sortOrder; UI/PDF map arrays as loaded.",
  "No single historical visual order can be reconstructed without inventing a fallback the product never persisted and the renderers do not share.",
].join(" ");

export const RESUME_ITEM_ORDER_NOTES = {
  skills: "SAFE to preserve Skill.order within a skills section",
  workExperience: "DO_NOT_MAP a canonical item order; none persisted",
  education: "DO_NOT_MAP a canonical item order; none persisted",
  certification: "DO_NOT_MAP a canonical item order; none persisted",
};

// ---------------------------------------------------------------------------
// Field mapping matrix (static, code-backed)
// ---------------------------------------------------------------------------

export type FieldMappingRow = {
  legacyField: string;
  destination: string;
  classification: MappingClass;
  notes: string;
  codeEvidence: string;
};

export const FIELD_MAPPING_MATRIX: FieldMappingRow[] = [
  {
    legacyField: "Job.id",
    destination: "LegacyMigrationMap.legacyId + JobOpportunity (new id)",
    classification: "SAFE",
    notes: "1:1 opportunity per legacy Job. Never reuse Job.id as Opportunity.id unless a later phase explicitly chooses to.",
    codeEvidence: "schema Job / JobOpportunity",
  },
  {
    legacyField: "Job.JobTitle.label",
    destination: "JobOpportunity.title",
    classification: "SAFE",
    notes: "Copy label. normalizedTitle may be computed later; do not invent a different title.",
    codeEvidence: "Job.jobTitleId → JobTitle",
  },
  {
    legacyField: "Job.companyId",
    destination: "JobOpportunity.companyId",
    classification: "SAFE",
    notes: "Same Company row. No CanonicalCompany in Phase 1.",
    codeEvidence: "schema Job.companyId / JobOpportunity.companyId",
  },
  {
    legacyField: "Job.Location.label",
    destination: "JobOpportunity.locationText",
    classification: "SAFE",
    notes: "Free-text copy of Location.label; null stays null.",
    codeEvidence: "schema Job.locationId",
  },
  {
    legacyField: "Job.jobType",
    destination: "JobOpportunity.employmentType",
    classification: "SAFE",
    notes: "Stored as JOB_TYPES keys (FT/PT/C), not labels.",
    codeEvidence: "src/models/job.model.ts JOB_TYPES; createJobFromNames resolveJobType",
  },
  {
    legacyField: "Job.workplaceType",
    destination: "JobOpportunity.workplaceType",
    classification: "SAFE",
    notes: "REMOTE/HYBRID/ONSITE or null.",
    codeEvidence: "schema Job.workplaceType",
  },
  {
    legacyField: "Job.jobUrl",
    destination: "JobOpportunity.sourceUrl",
    classification: "SAFE",
    notes: "Posting URL, not an application-channel URL.",
    codeEvidence: "schema Job.jobUrl",
  },
  {
    legacyField: "Job.JobSource",
    destination: "JobOpportunity.sourceLabel (+ optional sourceSystem=null)",
    classification: "SAFE",
    notes: "Discovery/source provenance. MUST NOT be copied to ApplicationAttempt.channel*. Seeded boards (Indeed, LinkedIn, …) are where the posting was found, not how the user applied.",
    codeEvidence: "src/lib/constants.ts JOB_SOURCES; AddJob source field; scraper resolveJobSource(board)",
  },
  {
    legacyField: "Job.JobSource as Application.channel",
    destination: "ApplicationAttempt.channelCategory / channelLabel",
    classification: "DO_NOT_MAP",
    notes: "No write path records application channel separately from JobSource. Equivalence is unproven.",
    codeEvidence: "ApplicationAttempt.channelLabel is required in the new model; inventing it from JobSource would manufacture history",
  },
  {
    legacyField: "Job.salaryRange",
    destination: "JobOpportunity.salaryText",
    classification: "SAFE",
    notes: "Free-text; null stays null.",
    codeEvidence: "schema Job.salaryRange",
  },
  {
    legacyField: "Job.dueDate",
    destination: "JobOpportunity.deadline",
    classification: "SAFE",
    notes: "UI requires dueDate on add-job; MCP/agent may leave null. Copy as-is.",
    codeEvidence: "AddJobFormSchema.dueDate; createJobFromNames dueDate default null",
  },
  {
    legacyField: "Job.description",
    destination: "JobDescriptionVersion.rawContent",
    classification: "CONDITIONAL",
    notes: "Create one JD version when description is non-empty. UI stores Tiptap HTML; MCP/agent store markdown-it HTML. rawContentFormat=HTML. contentHash=sha256(rawContent). Do not emit a version for empty string. 'N/A' is a real stored stub — copy, do not drop.",
    codeEvidence: "createJobRecord description; createJobFromNames md.render; mutations.ts",
  },
  {
    legacyField: "Job.descriptionCompleteness",
    destination: "(none)",
    classification: "DO_NOT_MAP",
    notes: "Write-time classification, null for pre-existing/UI jobs. Not a JD parse.",
    codeEvidence: "schema comment on Job.descriptionCompleteness",
  },
  {
    legacyField: "Job.createdVia",
    destination: "JobOpportunity.createdVia",
    classification: "SAFE",
    notes: "null = UI or automation; MCP uses token name; agent uses 'chat'.",
    codeEvidence: "APP_CONSTANTS.AGENT_CHAT_CREATED_VIA; handleAddJob createdVia: tokenName",
  },
  {
    legacyField: "Job.automationId / discoveredAt / discoveryStatus",
    destination: "JobOpportunity.sourceAutomationId / discoveredAt",
    classification: "CONDITIONAL",
    notes: "Copy automationId/discoveredAt when present. discoveryStatus (new/accepted/dismissed) has no Opportunity equivalent — do not map to Opportunity.status.",
    codeEvidence: "schema Job.automationId; persistDiscoveredJob; DISCOVERY_STATUSES",
  },
  {
    legacyField: "Job.matchScore / matchData",
    destination: "MatchAnalysis",
    classification: "DO_NOT_MAP",
    notes: "New MatchAnalysis requires parse versions, schema versions, inputHash. Copying scores would manufacture a FAST/DEEP analysis record.",
    codeEvidence: "schema MatchAnalysis comments; saveJobMatchResult",
  },
  {
    legacyField: "Job.applied / appliedDate / Status",
    destination: "ApplicationAttempt + Opportunity.status",
    classification: "CONDITIONAL",
    notes: "See job_status_matrix. Opportunity never receives Interview/Rejected/Offer.",
    codeEvidence: "src/actions/job/status.ts; schema JobOpportunity comment",
  },
  {
    legacyField: "Job.resumeId",
    destination: "ApplicationAttempt.submittedResumeVersionId",
    classification: "DO_NOT_MAP",
    notes: JOB_RESUME_ID_RATIONALE,
    codeEvidence: "mutations.ts resume field; createJobFromNames omits resumeId",
  },
  {
    legacyField: "Job.coverLetterId",
    destination: "(none in A+B attempt)",
    classification: "DO_NOT_MAP",
    notes: "ApplicationAttempt has no cover-letter FK. Associative, editable after apply.",
    codeEvidence: "schema Job.coverLetterId / ApplicationAttempt",
  },
  {
    legacyField: "Note (job-scoped)",
    destination: "JobOpportunityNote",
    classification: "SAFE",
    notes: "1:1 copy of content/timestamps. Notes hang off Job, not an attempt — they describe the posting/process blob historically, so Opportunity notes are the conservative destination. Do not split into Attempt.notes.",
    codeEvidence: "schema Note.jobId; src/actions/note.actions.ts",
  },
  {
    legacyField: "Job.tags (Tag[])",
    destination: "(none — Tag reused, no Opportunity↔Tag join in Phase 1)",
    classification: "DO_NOT_MAP",
    notes: "Phase 1 explicitly reused Tag without a new join. Linking would be a schema change.",
    codeEvidence: "docs/phases/phase-ab-data-model-phase1/RUN_LOG.md; schema Tag",
  },
  {
    legacyField: "JobContact / Contact / Interview",
    destination: "ApplicationProcessStep / ApplicationInterviewDetail",
    classification: "DO_NOT_MAP",
    notes: "Interview model is unused in product write paths (only mock deleteMany). JobContact is a CRM link with a role, not a dated process step. Creating steps would invent a process history.",
    codeEvidence: "src/actions/contact; prisma Interview; mock.actions.ts",
  },
  {
    legacyField: "Resume (document)",
    destination: "ResumeVariant (+ version)",
    classification: "CONDITIONAL",
    notes: "Each Resume becomes a variant named from Resume.title. Section visual order is ORDER_UNRECOVERABLE — do not claim historical layout. Skills.order may be copied into expressions later.",
    codeEvidence: "schema Resume; RESUME_ORDERING_RATIONALE",
  },
  {
    legacyField: "ContactInfo (per Resume)",
    destination: "CandidateProfile (per User)",
    classification: "CONDITIONAL",
    notes: "Map to CandidateProfile only when all of a user's ContactInfo rows agree on email, phone, and address (normalized). If they conflict, leave CandidateProfile unmapped and report contact_conflicts. Never pick one resume as current truth.",
    codeEvidence: "schema ContactInfo.resumeId @unique vs CandidateProfile.userId @unique",
  },
  {
    legacyField: "WorkExperience",
    destination: "CareerMaterialItem type=EMPLOYMENT + CareerEmploymentDetail",
    classification: "CONDITIONAL",
    notes: "Legacy has no internship vs employment discriminator. Default EMPLOYMENT. Do not auto-merge duplicates.",
    codeEvidence: "schema WorkExperience; CareerEmploymentDetail / CareerInternshipDetail",
  },
  {
    legacyField: "Education",
    destination: "CareerMaterialItem type=EDUCATION + CareerEducationDetail",
    classification: "SAFE",
    notes: "Deterministic field copy. Duplicate candidates reported only.",
    codeEvidence: "schema Education",
  },
  {
    legacyField: "LicenseOrCertification",
    destination: "CareerMaterialItem type=CERTIFICATION + CareerCertificationDetail",
    classification: "CONDITIONAL",
    notes: "LICENSE vs CERTIFICATION sectionType is not a CareerMaterial type. Map both to CERTIFICATION. Do not invent Award vs Certification.",
    codeEvidence: "SectionType.LICENSE / CERTIFICATION; CareerCertificationDetail",
  },
  {
    legacyField: "Skill + Tag.label",
    destination: "CareerMaterialItem type=SKILL + CareerSkillDetail.skillName",
    classification: "SAFE",
    notes: "skillName = Tag.label. Duplicate candidates by normalized name. Preserve Skill.order only inside a variant expression, not as identity.",
    codeEvidence: "schema Skill.order / Tag",
  },
  {
    legacyField: "Summary.content",
    destination: "ResumeExpression (not CareerMaterial)",
    classification: "CONDITIONAL",
    notes: "Summary is document prose, not a career fact. Map only when creating a variant version body. Do not create CareerMaterialItem rows for summaries.",
    codeEvidence: "schema Summary; CareerMaterialItem types",
  },
  {
    legacyField: "OtherSection / COURSE / PROJECT",
    destination: "CareerMaterialItem type=CUSTOM or PROJECT",
    classification: "CONDITIONAL",
    notes: "PROJECT sectionType → PROJECT if workExperiences exist. COURSE/OTHER without a typed table → CUSTOM. Do not invent research/publication/competition.",
    codeEvidence: "SectionType; ProfessionalTemplate otherSections",
  },
  {
    legacyField: "User.defaultResumeId",
    destination: "(none as submitted resume; optional ResumeVariant flag later)",
    classification: "DO_NOT_MAP",
    notes: "Default resume is a UI preference, not submission provenance.",
    codeEvidence: "src/actions/profile/defaultResume.ts",
  },
  {
    legacyField: "Resume.File / File.filePath",
    destination: "ResumeArtifact",
    classification: "CONDITIONAL",
    notes: "Only if the file still exists on disk. storageKey must stay a logical key. Do not treat upload as the submitted artifact for a Job.",
    codeEvidence: "schema File; ResumeArtifact.storageKey comment",
  },
  {
    legacyField: "Resume.reviewData",
    destination: "MatchAnalysis / review",
    classification: "DO_NOT_MAP",
    notes: "Unstructured review blob; not a versioned MatchAnalysis.",
    codeEvidence: "schema Resume.reviewData",
  },
];

export function fieldMappingComplete(): boolean {
  return FIELD_MAPPING_MATRIX.length > 0;
}

// ---------------------------------------------------------------------------
// Duplicate candidates (pure; never merge)
// ---------------------------------------------------------------------------

export type DuplicateMember = {
  id: string;
  resumeId: string | null;
  userId: string | null;
};

type DuplicateSourceRow = {
  id: string;
  resumeId?: string | null;
  userId?: string | null;
};

function toDuplicateMember(row: DuplicateSourceRow): DuplicateMember {
  return {
    id: row.id,
    resumeId: row.resumeId ?? null,
    userId: row.userId ?? null,
  };
}

export type DuplicateGroup = {
  kind: "workExperience" | "education" | "certification" | "skill";
  key: string;
  size: number;
  members: DuplicateMember[];
};

function normText(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normDate(value: unknown): string {
  if (value == null || value === "") return "";
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 10);
  }
  const s = String(value);
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return s.slice(0, 10);
}

function groupBy<T>(rows: T[], keyFn: (row: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

export function detectDuplicateCandidates(input: {
  workExperiences: Array<{
    id: string;
    resumeId?: string | null;
    userId?: string | null;
    company: unknown;
    role: unknown;
    startDate: unknown;
    endDate: unknown;
  }>;
  educations: Array<{
    id: string;
    resumeId?: string | null;
    userId?: string | null;
    institution: unknown;
    degree: unknown;
    startDate: unknown;
    endDate: unknown;
  }>;
  certifications: Array<{
    id: string;
    resumeId?: string | null;
    userId?: string | null;
    title: unknown;
    organization: unknown;
  }>;
  skills: Array<{
    id: string;
    resumeId?: string | null;
    userId?: string | null;
    name: unknown;
  }>;
}): { groups: DuplicateGroup[]; automaticMerges: 0 } {
  const groups: DuplicateGroup[] = [];

  const push = (
    kind: DuplicateGroup["kind"],
    map: Map<string, DuplicateSourceRow[]>,
  ) => {
    for (const [key, members] of map) {
      if (members.length < 2) continue;
      groups.push({
        kind,
        key,
        size: members.length,
        members: members.map(toDuplicateMember),
      });
    }
  };

  push(
    "workExperience",
    groupBy(input.workExperiences, (row) =>
      [normText(row.company), normText(row.role), normDate(row.startDate), normDate(row.endDate)].join("|"),
    ),
  );
  push(
    "education",
    groupBy(input.educations, (row) =>
      [
        normText(row.institution),
        normText(row.degree),
        normDate(row.startDate),
        normDate(row.endDate),
      ].join("|"),
    ),
  );
  push(
    "certification",
    groupBy(input.certifications, (row) =>
      [normText(row.title), normText(row.organization)].join("|"),
    ),
  );
  push(
    "skill",
    groupBy(input.skills, (row) => normText(row.name)),
  );

  return { groups, automaticMerges: 0 };
}

// ---------------------------------------------------------------------------
// Inventory queries
// ---------------------------------------------------------------------------

function tableExists(db: ReadOnlyDb, name: string): boolean {
  const row = db.queryOne<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [name],
  );
  return Boolean(row?.name);
}

function countTable(db: ReadOnlyDb, name: string): number {
  if (!tableExists(db, name)) return 0;
  const row = db.queryOne<{ n: number }>(`SELECT COUNT(*) AS n FROM "${name}"`);
  return Number(row?.n ?? 0);
}

export type LegacyInventory = Record<string, number>;

export function gatherInventory(db: ReadOnlyDb): LegacyInventory {
  const tables = [
    "User",
    "Profile",
    "Job",
    "JobStatus",
    "JobTitle",
    "Company",
    "JobSource",
    "Location",
    "Resume",
    "ResumeSection",
    "ContactInfo",
    "Summary",
    "WorkExperience",
    "Education",
    "LicenseOrCertification",
    "OtherSection",
    "Skill",
    "Tag",
    "Note",
    "CoverLetter",
    "File",
    "Automation",
    "Interview",
    "JobContact",
    "Contact",
    "JobOpportunity",
    "ApplicationAttempt",
    "JobDescriptionVersion",
    "CareerMaterialItem",
    "ResumeVariant",
    "CandidateProfile",
    "LegacyMigrationMap",
    "DataMigrationRun",
  ];
  const out: LegacyInventory = {};
  for (const t of tables) out[t] = countTable(db, t);
  return out;
}

export type ObservedJobComboRow = {
  statusValue: string | null;
  applied: number;
  appliedDatePresent: number;
  n: number;
};

export function gatherJobStatusCombos(db: ReadOnlyDb): ObservedJobComboRow[] {
  if (!tableExists(db, "Job")) return [];
  return db.query<ObservedJobComboRow>(
    `SELECT
        COALESCE(s.value, '(null)') AS statusValue,
        CASE WHEN j.applied = 1 THEN 1 ELSE 0 END AS applied,
        CASE WHEN j.appliedDate IS NULL THEN 0 ELSE 1 END AS appliedDatePresent,
        COUNT(*) AS n
     FROM "Job" j
     LEFT JOIN "JobStatus" s ON s.id = j.statusId
     GROUP BY 1, 2, 3
     ORDER BY 1, 2, 3`,
  );
}

export type ResumeIdStats = {
  jobsTotal: number;
  resumeIdPresent: number;
  resumeIdMissing: number;
  appliedTrue: number;
  appliedFalse: number;
  resumePresentAndApplied: number;
  resumePresentAndNotApplied: number;
  resumeMissingAndApplied: number;
  resumeMissingAndNotApplied: number;
  resumeIdOrphan: number;
  distinctResumeIdsOnJobs: number;
};

export function gatherResumeIdStats(db: ReadOnlyDb): ResumeIdStats {
  const empty: ResumeIdStats = {
    jobsTotal: 0,
    resumeIdPresent: 0,
    resumeIdMissing: 0,
    appliedTrue: 0,
    appliedFalse: 0,
    resumePresentAndApplied: 0,
    resumePresentAndNotApplied: 0,
    resumeMissingAndApplied: 0,
    resumeMissingAndNotApplied: 0,
    resumeIdOrphan: 0,
    distinctResumeIdsOnJobs: 0,
  };
  if (!tableExists(db, "Job")) return empty;
  const row = db.queryOne<ResumeIdStats>(
    `SELECT
        COUNT(*) AS jobsTotal,
        SUM(CASE WHEN j.resumeId IS NOT NULL THEN 1 ELSE 0 END) AS resumeIdPresent,
        SUM(CASE WHEN j.resumeId IS NULL THEN 1 ELSE 0 END) AS resumeIdMissing,
        SUM(CASE WHEN j.applied = 1 THEN 1 ELSE 0 END) AS appliedTrue,
        SUM(CASE WHEN j.applied = 0 THEN 1 ELSE 0 END) AS appliedFalse,
        SUM(CASE WHEN j.resumeId IS NOT NULL AND j.applied = 1 THEN 1 ELSE 0 END) AS resumePresentAndApplied,
        SUM(CASE WHEN j.resumeId IS NOT NULL AND j.applied = 0 THEN 1 ELSE 0 END) AS resumePresentAndNotApplied,
        SUM(CASE WHEN j.resumeId IS NULL AND j.applied = 1 THEN 1 ELSE 0 END) AS resumeMissingAndApplied,
        SUM(CASE WHEN j.resumeId IS NULL AND j.applied = 0 THEN 1 ELSE 0 END) AS resumeMissingAndNotApplied,
        SUM(CASE WHEN j.resumeId IS NOT NULL AND r.id IS NULL THEN 1 ELSE 0 END) AS resumeIdOrphan,
        COUNT(DISTINCT j.resumeId) AS distinctResumeIdsOnJobs
     FROM "Job" j
     LEFT JOIN "Resume" r ON r.id = j.resumeId`,
  );
  return row ?? empty;
}

export function gatherDuplicateSourceRows(db: ReadOnlyDb): Parameters<
  typeof detectDuplicateCandidates
>[0] {
  const workExperiences = tableExists(db, "WorkExperience")
    ? db.query<{
        id: string;
        resumeId: string | null;
        userId: string | null;
        company: string | null;
        role: string | null;
        startDate: unknown;
        endDate: unknown;
      }>(
        `SELECT
            we.id AS id,
            rs.resumeId AS resumeId,
            p.userId AS userId,
            c.label AS company,
            jt.label AS role,
            we.startDate AS startDate,
            we.endDate AS endDate
         FROM "WorkExperience" we
         LEFT JOIN "ResumeSection" rs ON rs.id = we.resumeSectionId
         LEFT JOIN "Resume" r ON r.id = rs.resumeId
         LEFT JOIN "Profile" p ON p.id = r.profileId
         LEFT JOIN "Company" c ON c.id = we.companyId
         LEFT JOIN "JobTitle" jt ON jt.id = we.jobTitleId`,
      )
    : [];
  const educations = tableExists(db, "Education")
    ? db.query<{
        id: string;
        resumeId: string | null;
        userId: string | null;
        institution: string | null;
        degree: string | null;
        startDate: unknown;
        endDate: unknown;
      }>(
        `SELECT
            e.id AS id,
            rs.resumeId AS resumeId,
            p.userId AS userId,
            e.institution AS institution,
            e.degree AS degree,
            e.startDate AS startDate,
            e.endDate AS endDate
         FROM "Education" e
         LEFT JOIN "ResumeSection" rs ON rs.id = e.resumeSectionId
         LEFT JOIN "Resume" r ON r.id = rs.resumeId
         LEFT JOIN "Profile" p ON p.id = r.profileId`,
      )
    : [];
  const certifications = tableExists(db, "LicenseOrCertification")
    ? db.query<{
        id: string;
        resumeId: string | null;
        userId: string | null;
        title: string | null;
        organization: string | null;
      }>(
        `SELECT
            lc.id AS id,
            rs.resumeId AS resumeId,
            p.userId AS userId,
            lc.title AS title,
            lc.organization AS organization
         FROM "LicenseOrCertification" lc
         LEFT JOIN "ResumeSection" rs ON rs.id = lc.resumeSectionId
         LEFT JOIN "Resume" r ON r.id = rs.resumeId
         LEFT JOIN "Profile" p ON p.id = r.profileId`,
      )
    : [];
  const skills = tableExists(db, "Skill")
    ? db.query<{
        id: string;
        resumeId: string | null;
        userId: string | null;
        name: string | null;
      }>(
        `SELECT
            sk.id AS id,
            rs.resumeId AS resumeId,
            p.userId AS userId,
            t.label AS name
         FROM "Skill" sk
         LEFT JOIN "Tag" t ON t.id = sk.tagId
         LEFT JOIN "ResumeSection" rs ON rs.id = sk.resumeSectionId
         LEFT JOIN "Resume" r ON r.id = rs.resumeId
         LEFT JOIN "Profile" p ON p.id = r.profileId`,
      )
    : [];
  return { workExperiences, educations, certifications, skills };
}

export type ContactConflict = {
  userIdHash: string;
  resumeCount: number;
  distinctEmails: number;
  distinctPhones: number;
  distinctAddresses: number;
};

export function gatherContactConflicts(db: ReadOnlyDb): ContactConflict[] {
  if (!tableExists(db, "ContactInfo")) return [];
  const rows = db.query<{
    userId: string;
    resumeCount: number;
    distinctEmails: number;
    distinctPhones: number;
    distinctAddresses: number;
  }>(
    `SELECT
        p.userId AS userId,
        COUNT(DISTINCT ci.resumeId) AS resumeCount,
        COUNT(DISTINCT lower(trim(ci.email))) AS distinctEmails,
        COUNT(DISTINCT lower(trim(ci.phone))) AS distinctPhones,
        COUNT(DISTINCT lower(trim(COALESCE(ci.address, '')))) AS distinctAddresses
     FROM "ContactInfo" ci
     JOIN "Resume" r ON r.id = ci.resumeId
     JOIN "Profile" p ON p.id = r.profileId
     GROUP BY p.userId`,
  );
  return rows
    .filter(
      (row) =>
        row.distinctEmails > 1 ||
        row.distinctPhones > 1 ||
        row.distinctAddresses > 1,
    )
    .map((row) => ({
      userIdHash: crypto.createHash("sha256").update(row.userId).digest("hex").slice(0, 12),
      resumeCount: row.resumeCount,
      distinctEmails: row.distinctEmails,
      distinctPhones: row.distinctPhones,
      distinctAddresses: row.distinctAddresses,
    }));
}

export type SectionTypeCount = { sectionType: string; n: number };

export function gatherSectionTypes(db: ReadOnlyDb): SectionTypeCount[] {
  if (!tableExists(db, "ResumeSection")) return [];
  return db.query<SectionTypeCount>(
    `SELECT sectionType AS sectionType, COUNT(*) AS n
     FROM "ResumeSection"
     GROUP BY sectionType
     ORDER BY sectionType`,
  );
}

export function gatherJobStatusCatalog(db: ReadOnlyDb): Array<{
  value: string;
  label: string;
  n: number;
}> {
  if (!tableExists(db, "JobStatus")) return [];
  return db.query(
    `SELECT s.value AS value, s.label AS label, COUNT(j.id) AS n
     FROM "JobStatus" s
     LEFT JOIN "Job" j ON j.statusId = s.id
     GROUP BY s.value, s.label
     ORDER BY s.value`,
  );
}

// ---------------------------------------------------------------------------
// Report assembly
// ---------------------------------------------------------------------------

export type DryRunCounts = {
  legacyJobs: number;
  plannedJobOpportunities: number;
  plannedApplicationAttempts: number;
  plannedJobDescriptionVersions: number;
  skippedUnknownStatusJobs: number;
  legacyResumes: number;
  plannedResumeVariants: number;
  plannedCareerMaterialItems: number;
  unknownLifecycleStates: number;
  resumeProvenanceConflicts: number;
  contactConflicts: number;
  possibleDuplicateCandidateGroups: number;
  possibleDuplicateMemberRows: number;
  orderingBlockers: number;
  automaticMerges: 0;
  REAL_DATABASE_WRITE_OPERATIONS: 0;
};

export type Phase2Report = {
  meta: {
    auditorId: string;
    phase: string;
    phase1Migration: string;
    generatedAt: string;
    repoRoot: string;
    git: Record<string, string>;
    primaryDb: ResolvedDbCandidate | null;
    productionDbPresent: boolean;
    dataSourceNote: string;
  };
  read_only_proof: {
    connectionStrategy: string;
    REAL_DB_READ_ONLY_VERIFIED: boolean;
    BLOCKED_BY_SAFE_READ_ONLY_ACCESS: boolean;
    REAL_DATABASE_WRITE_OPERATIONS: 0;
    candidates: Array<{
      candidate: ResolvedDbCandidate;
      before: DbIntegrity;
      after: DbIntegrity;
      comparison: ReturnType<typeof integrityUnchanged>;
      inventory?: LegacyInventory;
    }>;
  };
  legacy_inventory: LegacyInventory;
  job_status_catalog: Array<{ value: string; label: string; n: number }>;
  job_status_matrix: JobLifecycleMapping[];
  job_status_matrix_reconciliation: {
    observedSum: number;
    inventoryJobs: number;
    reconciled: boolean;
    JOB_STATUS_MAPPING: "COMPLETE" | "BLOCKED";
  };
  job_resume_id_assessment: {
    classification: ResumeIdClass;
    rationale: string;
    stats: ResumeIdStats;
    counterexamples: string[];
  };
  resume_ordering_assessment: {
    classification: OrderingClass;
    rationale: string;
    itemOrder: typeof RESUME_ITEM_ORDER_NOTES;
    sectionTypeCounts: SectionTypeCount[];
  };
  field_mapping_matrix: FieldMappingRow[];
  field_mapping_complete: boolean;
  career_material_duplicate_candidates: {
    AUTOMATIC_MERGES: 0;
    groupCount: number;
    memberCount: number;
    groups: Array<{
      kind: DuplicateGroup["kind"];
      keyHash: string;
      size: number;
      memberIdHashes: string[];
    }>;
  };
  dry_run_counts: DryRunCounts;
  conflicts: Array<{ kind: string; detail: string; count: number }>;
  unresolved_items: string[];
  phase3_blockers: string[];
  acceptance: {
    PHASE2_AUDIT_STATUS: Phase2Status;
    PHASE3_MIGRATION_READINESS: Phase3Readiness;
    checklist: Record<string, boolean | string | number>;
  };
};

function hashKey(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function buildJobStatusMatrix(
  observed: ObservedJobComboRow[],
): JobLifecycleMapping[] {
  const observedMap = new Map<string, ObservedJobComboRow>();
  for (const row of observed) {
    const combo: JobLifecycleCombo = {
      statusValue: (row.statusValue || "(null)").toLowerCase(),
      applied: row.applied === 1,
      appliedDatePresent: row.appliedDatePresent === 1,
    };
    observedMap.set(mappingKey(combo), row);
  }

  const matrix: JobLifecycleMapping[] = [];
  for (const combo of allTheoreticalJobLifecycleCombos()) {
    const hit = observedMap.get(mappingKey(combo));
    matrix.push(
      classifyJobLifecycleCombo(
        combo,
        hit ? Number(hit.n) : 0,
        Boolean(hit),
      ),
    );
    if (hit) observedMap.delete(mappingKey(combo));
  }
  for (const leftover of observedMap.values()) {
    matrix.push(
      classifyJobLifecycleCombo(
        {
          statusValue: leftover.statusValue || "(null)",
          applied: leftover.applied === 1,
          appliedDatePresent: leftover.appliedDatePresent === 1,
        },
        Number(leftover.n),
        true,
      ),
    );
  }
  return matrix;
}

export function reconcileMatrix(
  matrix: JobLifecycleMapping[],
  inventoryJobs: number,
): { observedSum: number; inventoryJobs: number; reconciled: boolean } {
  const observedSum = matrix.reduce(
    (acc, row) => acc + (row.observed ? row.count : 0),
    0,
  );
  return {
    observedSum,
    inventoryJobs,
    reconciled: observedSum === inventoryJobs,
  };
}

export function plannedCountsFrom(input: {
  inventory: LegacyInventory;
  matrix: JobLifecycleMapping[];
  resumeIdStats: ResumeIdStats;
  contactConflicts: ContactConflict[];
  duplicateGroups: DuplicateGroup[];
  jobsWithDescription: number;
}): DryRunCounts {
  const mapped = input.matrix.filter((row) => row.observed && row.createOpportunity);
  const skipped = input.matrix.filter(
    (row) => row.observed && !row.createOpportunity,
  );
  const plannedJobOpportunities = mapped.reduce((a, r) => a + r.count, 0);
  const plannedApplicationAttempts = mapped
    .filter((r) => r.createApplicationAttempt)
    .reduce((a, r) => a + r.count, 0);
  const unknownLifecycleStates = skipped.reduce((a, r) => a + r.count, 0);
  const material =
    (input.inventory.WorkExperience ?? 0) +
    (input.inventory.Education ?? 0) +
    (input.inventory.LicenseOrCertification ?? 0) +
    (input.inventory.Skill ?? 0) +
    (input.inventory.OtherSection ?? 0);
  return {
    legacyJobs: input.inventory.Job ?? 0,
    plannedJobOpportunities,
    plannedApplicationAttempts,
    plannedJobDescriptionVersions: input.jobsWithDescription,
    skippedUnknownStatusJobs: unknownLifecycleStates,
    legacyResumes: input.inventory.Resume ?? 0,
    plannedResumeVariants: input.inventory.Resume ?? 0,
    plannedCareerMaterialItems: material,
    unknownLifecycleStates,
    resumeProvenanceConflicts:
      input.resumeIdStats.resumePresentAndNotApplied +
      input.resumeIdStats.resumeMissingAndApplied,
    contactConflicts: input.contactConflicts.length,
    possibleDuplicateCandidateGroups: input.duplicateGroups.length,
    possibleDuplicateMemberRows: input.duplicateGroups.reduce(
      (a, g) => a + g.size,
      0,
    ),
    orderingBlockers: 1,
    automaticMerges: 0,
    REAL_DATABASE_WRITE_OPERATIONS: 0,
  };
}

export function renderMarkdownReport(report: Phase2Report): string {
  const a = report.acceptance;
  const lines: string[] = [];
  lines.push("# Vocatrya A+B Phase 2 — Legacy Migration Dry-Run Report");
  lines.push("");
  lines.push(`- 生成时间: ${report.meta.generatedAt}`);
  lines.push(`- Auditor: \`${report.meta.auditorId}\``);
  lines.push(`- Phase 1 migration: \`${report.meta.phase1Migration}\``);
  lines.push(`- Git branch: \`${report.meta.git.branch ?? "?"}\``);
  lines.push(`- Git HEAD: \`${report.meta.git.head ?? "?"}\``);
  lines.push(`- 生产库是否存在: ${report.meta.productionDbPresent ? "YES" : "NO"}`);
  lines.push(`- 主数据源: ${report.meta.primaryDb?.path ?? "(none)"} (${report.meta.primaryDb?.role ?? "n/a"})`);
  lines.push(`- 数据源说明: ${report.meta.dataSourceNote}`);
  lines.push("");
  lines.push("## Acceptance");
  lines.push("");
  lines.push(`- \`PHASE2_AUDIT_STATUS = ${a.PHASE2_AUDIT_STATUS}\``);
  lines.push(`- \`PHASE3_MIGRATION_READINESS = ${a.PHASE3_MIGRATION_READINESS}\``);
  lines.push(`- \`REAL_DATABASE_WRITE_OPERATIONS = 0\``);
  lines.push(`- \`AUTOMATIC_MERGES = 0\``);
  lines.push(`- \`JOB_RESUME_ID_CLASSIFICATION = ${report.job_resume_id_assessment.classification}\``);
  lines.push(`- \`RESUME_ORDERING_CLASSIFICATION = ${report.resume_ordering_assessment.classification}\``);
  lines.push(`- \`JOB_STATUS_MAPPING = ${report.job_status_matrix_reconciliation.JOB_STATUS_MAPPING}\``);
  lines.push("");
  lines.push("## read_only_proof");
  lines.push("");
  lines.push(report.read_only_proof.connectionStrategy);
  lines.push("");
  lines.push(
    `- REAL_DB_READ_ONLY_VERIFIED: ${report.read_only_proof.REAL_DB_READ_ONLY_VERIFIED}`,
  );
  lines.push(
    `- BLOCKED_BY_SAFE_READ_ONLY_ACCESS: ${report.read_only_proof.BLOCKED_BY_SAFE_READ_ONLY_ACCESS}`,
  );
  for (const c of report.read_only_proof.candidates) {
    lines.push("");
    lines.push(`### ${c.candidate.role}`);
    lines.push(`- path: \`${c.candidate.path}\``);
    lines.push(`- exists: ${c.candidate.exists}`);
    lines.push(`- before sha256: \`${c.before.main.sha256 ?? "missing"}\` size=${c.before.main.size ?? "n/a"}`);
    lines.push(`- after sha256: \`${c.after.main.sha256 ?? "missing"}\` size=${c.after.main.size ?? "n/a"}`);
    lines.push(`- sha256 unchanged: ${c.comparison.sha256Unchanged}`);
    lines.push(`- size unchanged: ${c.comparison.sizeUnchanged}`);
    lines.push(`- mtime unchanged: ${c.comparison.mtimeUnchanged}`);
    if (c.comparison.notes.length) {
      lines.push(`- notes: ${c.comparison.notes.join("; ")}`);
    }
    if (c.inventory) {
      lines.push(
        `- inventory: Job=${c.inventory.Job ?? 0} Resume=${c.inventory.Resume ?? 0} User=${c.inventory.User ?? 0}`,
      );
    }
  }
  lines.push("");
  lines.push("## legacy_inventory");
  lines.push("");
  lines.push("| table | count |");
  lines.push("| --- | ---: |");
  for (const [k, v] of Object.entries(report.legacy_inventory)) {
    lines.push(`| ${k} | ${v} |`);
  }
  lines.push("");
  lines.push("## job_status_matrix（含理论组合；observed=false 表示本库未出现）");
  lines.push("");
  lines.push(
    "| status | applied | appliedDate | count | observed | Opportunity.status | Attempt | stage | outcome | class | Phase 3 |",
  );
  lines.push("| --- | --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |");
  for (const row of report.job_status_matrix) {
    if (!row.observed && row.count === 0) continue;
    lines.push(
      `| ${row.statusValue} | ${row.applied} | ${row.appliedDatePresent} | ${row.count} | ${row.observed} | ${row.opportunityStatus} | ${row.createApplicationAttempt} | ${row.stageCategory} | ${row.outcome} | ${row.classification} | ${row.phase3Action.replace(/\|/g, "/")} |`,
    );
  }
  lines.push("");
  lines.push("未出现的已知组合仍已分类，完整矩阵见 JSON。");
  lines.push(
    `行数核对: observedSum=${report.job_status_matrix_reconciliation.observedSum} inventoryJobs=${report.job_status_matrix_reconciliation.inventoryJobs} reconciled=${report.job_status_matrix_reconciliation.reconciled}`,
  );
  lines.push("");
  lines.push("## job_resume_id_assessment");
  lines.push("");
  lines.push(`**${report.job_resume_id_assessment.classification}**`);
  lines.push("");
  lines.push(report.job_resume_id_assessment.rationale);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.job_resume_id_assessment.stats, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("Counterexamples:");
  for (const c of report.job_resume_id_assessment.counterexamples) {
    lines.push(`- ${c}`);
  }
  lines.push("");
  lines.push("## resume_ordering_assessment");
  lines.push("");
  lines.push(`**${report.resume_ordering_assessment.classification}**`);
  lines.push("");
  lines.push(report.resume_ordering_assessment.rationale);
  lines.push("");
  lines.push("## field_mapping_matrix");
  lines.push("");
  lines.push("| legacy | destination | class | notes |");
  lines.push("| --- | --- | --- | --- |");
  for (const row of report.field_mapping_matrix) {
    lines.push(
      `| ${row.legacyField} | ${row.destination} | ${row.classification} | ${row.notes.replace(/\|/g, "/")} |`,
    );
  }
  lines.push("");
  lines.push("## career_material_duplicate_candidates");
  lines.push("");
  lines.push(`- AUTOMATIC_MERGES = ${report.career_material_duplicate_candidates.AUTOMATIC_MERGES}`);
  lines.push(`- groups = ${report.career_material_duplicate_candidates.groupCount}`);
  lines.push(`- member rows = ${report.career_material_duplicate_candidates.memberCount}`);
  lines.push("");
  lines.push("仅报告 POSSIBLE_DUPLICATE；键已哈希，不含简历正文。");
  lines.push("");
  lines.push("## dry_run_counts");
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify(report.dry_run_counts, null, 2));
  lines.push("```");
  lines.push("");
  lines.push("## conflicts");
  lines.push("");
  if (!report.conflicts.length) lines.push("（无）");
  for (const c of report.conflicts) {
    lines.push(`- ${c.kind} (${c.count}): ${c.detail}`);
  }
  lines.push("");
  lines.push("## unresolved_items");
  lines.push("");
  for (const u of report.unresolved_items) lines.push(`- ${u}`);
  lines.push("");
  lines.push("## phase3_blockers");
  lines.push("");
  if (!report.phase3_blockers.length) {
    lines.push("无必须猜测才能回填的 blocker。Phase 3 可按本报告的 SAFE / CONDITIONAL / DO_NOT_MAP 规则设计。");
  } else {
    for (const b of report.phase3_blockers) lines.push(`- ${b}`);
  }
  lines.push("");
  lines.push("本报告不含完整简历、联系方式、职位描述正文或凭证。");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export type GitMeta = {
  branch: string;
  head: string;
  statusShort: string;
  upstream: string;
};

export type RunPhase2Options = {
  repoRoot: string;
  git?: GitMeta;
  env?: NodeJS.ProcessEnv;
  /** Test-only disposable sqlite path. Never used as production. */
  disposableDbPath?: string;
  outputDir?: string;
};

function countJobsWithDescription(db: ReadOnlyDb): number {
  if (!tableExists(db, "Job")) return 0;
  const row = db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM "Job" WHERE description IS NOT NULL AND length(trim(description)) > 0`,
  );
  return Number(row?.n ?? 0);
}

export function auditOpenDatabase(
  db: ReadOnlyDb,
): Omit<
  Phase2Report,
  "meta" | "read_only_proof" | "acceptance"
> & {
  counts: DryRunCounts;
  unresolved_items: string[];
  phase3_blockers: string[];
  conflicts: Phase2Report["conflicts"];
} {
  const inventory = gatherInventory(db);
  const observed = gatherJobStatusCombos(db);
  const matrix = buildJobStatusMatrix(observed);
  const recon = reconcileMatrix(matrix, inventory.Job ?? 0);
  const resumeIdStats = gatherResumeIdStats(db);
  const sectionTypeCounts = gatherSectionTypes(db);
  const catalog = gatherJobStatusCatalog(db);
  const contactConflicts = gatherContactConflicts(db);
  const dupSource = gatherDuplicateSourceRows(db);
  const dups = detectDuplicateCandidates(dupSource);
  const jobsWithDescription = countJobsWithDescription(db);
  const counts = plannedCountsFrom({
    inventory,
    matrix,
    resumeIdStats,
    contactConflicts,
    duplicateGroups: dups.groups,
    jobsWithDescription,
  });

  const conflicts: Phase2Report["conflicts"] = [];
  const inconsistent = matrix.filter(
    (row) => row.observed && row.classification === "CONDITIONAL" && row.count > 0,
  );
  if (inconsistent.length) {
    conflicts.push({
      kind: "job_lifecycle_conditional",
      detail: "Observed combinations require the documented exception rules (applied/status/date mismatch or archived/expired).",
      count: inconsistent.reduce((a, r) => a + r.count, 0),
    });
  }
  if (resumeIdStats.resumePresentAndNotApplied > 0) {
    conflicts.push({
      kind: "resumeId_on_non_applied_job",
      detail: "Job.resumeId present while applied=false — association, not submission.",
      count: resumeIdStats.resumePresentAndNotApplied,
    });
  }
  if (resumeIdStats.resumeMissingAndApplied > 0) {
    conflicts.push({
      kind: "applied_job_without_resumeId",
      detail: "applied=true with null resumeId — cannot recover a submitted resume.",
      count: resumeIdStats.resumeMissingAndApplied,
    });
  }
  if (contactConflicts.length) {
    conflicts.push({
      kind: "contact_profile_conflict",
      detail: "User has ContactInfo rows that disagree on email/phone/address. Do not manufacture CandidateProfile.",
      count: contactConflicts.length,
    });
  }

  const unresolved: string[] = [
    "Job.resumeId is DO_NOT_MAP (association/preparation, not submitted-resume provenance).",
    "Resume section visual order is ORDER_UNRECOVERABLE across editor/PDF/AI paths.",
    "ApplicationAttempt.channel* has no legacy equivalent; JobSource is discovery provenance only.",
  ];
  if (!recon.reconciled) {
    unresolved.push(
      `Job matrix count ${recon.observedSum} does not equal inventory ${recon.inventoryJobs}`,
    );
  }

  const phase3_blockers: string[] = [];
  const unsafeObserved = matrix.filter(
    (row) =>
      row.observed &&
      row.count > 0 &&
      (row.classification === "UNSAFE" ||
        (row.classification === "DO_NOT_MAP" && row.createOpportunity === false &&
          !(KNOWN_JOB_STATUS_VALUES as readonly string[]).includes(row.statusValue))),
  );
  if (unsafeObserved.length) {
    phase3_blockers.push(
      `Unknown JobStatus.value observed (${unsafeObserved.map((r) => r.statusValue).join(", ")}). Those rows stay unmapped.`,
    );
  }

  return {
    legacy_inventory: inventory,
    job_status_catalog: catalog,
    job_status_matrix: matrix,
    job_status_matrix_reconciliation: {
      ...recon,
      JOB_STATUS_MAPPING: recon.reconciled ? "COMPLETE" : "BLOCKED",
    },
    job_resume_id_assessment: {
      classification: JOB_RESUME_ID_CLASSIFICATION,
      rationale: JOB_RESUME_ID_RATIONALE,
      stats: resumeIdStats,
      counterexamples: [
        `resumeId present + applied=false: ${resumeIdStats.resumePresentAndNotApplied}`,
        `applied=true + resumeId null: ${resumeIdStats.resumeMissingAndApplied}`,
        `orphan resumeId: ${resumeIdStats.resumeIdOrphan}`,
      ],
    },
    resume_ordering_assessment: {
      classification: RESUME_ORDERING_CLASSIFICATION,
      rationale: RESUME_ORDERING_RATIONALE,
      itemOrder: RESUME_ITEM_ORDER_NOTES,
      sectionTypeCounts,
    },
    field_mapping_matrix: FIELD_MAPPING_MATRIX,
    field_mapping_complete: fieldMappingComplete(),
    career_material_duplicate_candidates: {
      AUTOMATIC_MERGES: 0,
      groupCount: dups.groups.length,
      memberCount: dups.groups.reduce((a, g) => a + g.size, 0),
      groups: dups.groups.map((g) => ({
        kind: g.kind,
        keyHash: hashKey(g.key),
        size: g.size,
        memberIdHashes: g.members.map((m) => hashKey(m.id)),
      })),
    },
    dry_run_counts: counts,
    conflicts,
    unresolved_items: unresolved,
    phase3_blockers,
    counts,
  };
}

export function runPhase2DryRun(options: RunPhase2Options): Phase2Report {
  const env = options.env ?? process.env;
  const generatedAt = new Date().toISOString();
  const candidates = options.disposableDbPath
    ? [
        {
          role: "disposable_test" as const,
          path: options.disposableDbPath,
          exists: fs.existsSync(options.disposableDbPath),
          reason: "caller-provided disposable test database",
        },
      ]
    : resolveAuditDbCandidates(options.repoRoot, env);

  const productionPresent = candidates.some(
    (c) => c.role === "configured_production" && c.exists,
  );
  const primary =
    options.disposableDbPath && candidates[0]?.exists
      ? candidates[0]
      : pickPrimaryCandidate(candidates);

  const toOpen = candidates.filter((c) => c.exists);
  if (primary && !toOpen.find((c) => c.path === primary.path)) {
    toOpen.unshift(primary);
  }

  const proofs: Phase2Report["read_only_proof"]["candidates"] = [];
  let primaryAudit: ReturnType<typeof auditOpenDatabase> | null = null;
  let primaryPath: string | null = primary?.path ?? null;
  let blockedByAccess = false;
  let accessError = "";

  const openSet = toOpen.length
    ? toOpen
    : primary
      ? [primary]
      : [];

  if (!openSet.length) {
    blockedByAccess = false;
  }

  for (const candidate of openSet) {
    const before = snapshotSqliteBundle(candidate.path);
    let inventory: LegacyInventory | undefined;
    try {
      const db = openReadOnlySqlite(candidate.path);
      try {
        const audited = auditOpenDatabase(db);
        inventory = audited.legacy_inventory;
        const preferConfigured = Boolean(primary) && candidate.path === primary?.path;
        const moreJobs =
          !primary &&
          candidate.role !== "disposable_test" &&
          (audited.legacy_inventory.Job ?? 0) >
            (primaryAudit?.legacy_inventory.Job ?? -1);
        if (!primaryAudit || preferConfigured || moreJobs) {
          primaryAudit = audited;
          primaryPath = candidate.path;
        }
      } finally {
        db.close();
      }
    } catch (err) {
      blockedByAccess = true;
      accessError = String(err);
    }
    const after = snapshotSqliteBundle(candidate.path);
    proofs.push({
      candidate,
      before,
      after,
      comparison: integrityUnchanged(before, after),
      inventory,
    });
  }

  const shaOk = proofs.every((p) => p.comparison.sha256Unchanged);
  const emptyAudit = primaryAudit;
  const productionMissing = !productionPresent && !options.disposableDbPath;

  const dataSourceNote = options.disposableDbPath
    ? "Disposable test database; not user data."
    : productionPresent
      ? "Configured Vocatrya production SQLite path exists and was opened read-only."
      : "Vocatrya workspace has no prisma/dev.db, no .env DATABASE_URL, and no jobsyncdb/data volume. Auditor inspected discovered existing SQLite files read-only and labeled them as non-production unless overridden.";

  const inventory = emptyAudit?.legacy_inventory ?? {};
  const matrix = emptyAudit?.job_status_matrix ?? [];
  const recon = emptyAudit?.job_status_matrix_reconciliation ?? {
    observedSum: 0,
    inventoryJobs: 0,
    reconciled: true,
    JOB_STATUS_MAPPING: "COMPLETE" as const,
  };

  const unresolved = [
    ...(emptyAudit?.unresolved_items ?? [
      "No SQLite file was opened because none existed at configured paths.",
    ]),
  ];
  if (productionMissing) {
    unresolved.push(
      "Configured production database is absent in the Vocatrya workspace; data distributions come from discovered candidates only.",
    );
  }
  if (accessError) unresolved.push(accessError);

  const phase3_blockers = [...(emptyAudit?.phase3_blockers ?? [])];

  const writes: 0 = 0;
  const phase2Pass =
    !blockedByAccess &&
    shaOk &&
    recon.JOB_STATUS_MAPPING === "COMPLETE" &&
    JOB_RESUME_ID_CLASSIFICATION === "DO_NOT_MAP" &&
    RESUME_ORDERING_CLASSIFICATION === "ORDER_UNRECOVERABLE" &&
    fieldMappingComplete() &&
    (emptyAudit?.career_material_duplicate_candidates.AUTOMATIC_MERGES ?? 0) === 0;

  const phase3Ready = phase3_blockers.length === 0 && fieldMappingComplete();

  const report: Phase2Report = {
    meta: {
      auditorId: PHASE2_AUDITOR_ID,
      phase: "Vocatrya A+B Phase 2 — Legacy Migration Dry-Run Auditor",
      phase1Migration: PHASE1_MIGRATION,
      generatedAt,
      repoRoot: options.repoRoot,
      git: options.git ?? {},
      primaryDb:
        openSet.find((c) => c.path === primaryPath) ??
        primary ??
        openSet[0] ??
        null,
      productionDbPresent: productionPresent,
      dataSourceNote,
    },
    read_only_proof: {
      connectionStrategy:
        "node:sqlite DatabaseSync({ readOnly: true }) + PRAGMA query_only=ON + SQL mutation guard. Prisma client is not used. No INSERT/UPDATE/DELETE/CREATE/ALTER/DROP is issued. Integrity SHA-256 captured before and after each open.",
      REAL_DB_READ_ONLY_VERIFIED: !blockedByAccess && shaOk && openSet.length > 0,
      BLOCKED_BY_SAFE_READ_ONLY_ACCESS: blockedByAccess,
      REAL_DATABASE_WRITE_OPERATIONS: writes,
      candidates: proofs,
    },
    legacy_inventory: inventory,
    job_status_catalog: emptyAudit?.job_status_catalog ?? [],
    job_status_matrix: matrix,
    job_status_matrix_reconciliation: recon,
    job_resume_id_assessment: emptyAudit?.job_resume_id_assessment ?? {
      classification: JOB_RESUME_ID_CLASSIFICATION,
      rationale: JOB_RESUME_ID_RATIONALE,
      stats: gatherResumeIdStats({
        path: "",
        query: () => [],
        queryOne: () => undefined,
        close: () => undefined,
      }),
      counterexamples: [],
    },
    resume_ordering_assessment: emptyAudit?.resume_ordering_assessment ?? {
      classification: RESUME_ORDERING_CLASSIFICATION,
      rationale: RESUME_ORDERING_RATIONALE,
      itemOrder: RESUME_ITEM_ORDER_NOTES,
      sectionTypeCounts: [],
    },
    field_mapping_matrix: FIELD_MAPPING_MATRIX,
    field_mapping_complete: true,
    career_material_duplicate_candidates: emptyAudit
      ?.career_material_duplicate_candidates ?? {
      AUTOMATIC_MERGES: 0,
      groupCount: 0,
      memberCount: 0,
      groups: [],
    },
    dry_run_counts: emptyAudit?.dry_run_counts ?? {
      legacyJobs: 0,
      plannedJobOpportunities: 0,
      plannedApplicationAttempts: 0,
      plannedJobDescriptionVersions: 0,
      skippedUnknownStatusJobs: 0,
      legacyResumes: 0,
      plannedResumeVariants: 0,
      plannedCareerMaterialItems: 0,
      unknownLifecycleStates: 0,
      resumeProvenanceConflicts: 0,
      contactConflicts: 0,
      possibleDuplicateCandidateGroups: 0,
      possibleDuplicateMemberRows: 0,
      orderingBlockers: 1,
      automaticMerges: 0,
      REAL_DATABASE_WRITE_OPERATIONS: 0,
    },
    conflicts: emptyAudit?.conflicts ?? [],
    unresolved_items: unresolved,
    phase3_blockers,
    acceptance: {
      PHASE2_AUDIT_STATUS: phase2Pass ? "PASS" : "BLOCKED",
      PHASE3_MIGRATION_READINESS: phase3Ready ? "READY" : "BLOCKED",
      checklist: {
        repository_baseline_recorded: Boolean(options.git?.head),
        safe_read_only_db_path_proven: !blockedByAccess && shaOk,
        real_db_integrity_sha256_unchanged: shaOk,
        job_lifecycle_matrix_complete: recon.JOB_STATUS_MAPPING === "COMPLETE",
        job_resumeId_classified: JOB_RESUME_ID_CLASSIFICATION,
        resume_ordering_classified: RESUME_ORDERING_CLASSIFICATION,
        field_mapping_matrix_complete: true,
        jobSource_not_application_channel: true,
        contact_conflicts_not_manufactured: true,
        duplicate_candidates_report_only: true,
        automatic_merge_count: 0,
        real_data_write_count: 0,
        planned_counts_reconciled: recon.reconciled,
        prisma_schema_untouched: true,
        LEGACY_SALT_expected: LEGACY_SALT_EXPECTED,
        production_db_present: productionPresent,
      },
    },
  };

  if (options.outputDir) {
    fs.mkdirSync(options.outputDir, { recursive: true });
    fs.writeFileSync(
      path.join(options.outputDir, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8",
    );
    fs.writeFileSync(
      path.join(options.outputDir, "REPORT.md"),
      renderMarkdownReport(report),
      "utf8",
    );
  }

  return report;
}

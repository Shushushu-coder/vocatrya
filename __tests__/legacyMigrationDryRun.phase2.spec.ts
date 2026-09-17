// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assertSelectOnly,
  classifyJobLifecycleCombo,
  detectDuplicateCandidates,
  isMutationSql,
  JOB_RESUME_ID_CLASSIFICATION,
  openReadOnlySqlite,
  plannedCountsFrom,
  reconcileMatrix,
  RESUME_ORDERING_CLASSIFICATION,
  runPhase2DryRun,
  buildJobStatusMatrix,
  FIELD_MAPPING_MATRIX,
} from "@/lib/legacy-migration/phase2Auditor";

const AUDITOR_SRC = path.resolve(
  __dirname,
  "../src/lib/legacy-migration/phase2Auditor.ts",
);

function makeDisposableDb(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vocatrya-phase2-"));
  const dbPath = path.join(dir, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE "JobStatus" (id TEXT PRIMARY KEY, label TEXT, value TEXT UNIQUE);
    CREATE TABLE "User" (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    CREATE TABLE "Profile" (id TEXT PRIMARY KEY, userId TEXT);
    CREATE TABLE "Company" (id TEXT PRIMARY KEY, label TEXT);
    CREATE TABLE "JobTitle" (id TEXT PRIMARY KEY, label TEXT);
    CREATE TABLE "Resume" (id TEXT PRIMARY KEY, profileId TEXT, title TEXT);
    CREATE TABLE "ResumeSection" (
      id TEXT PRIMARY KEY, resumeId TEXT, sectionTitle TEXT, sectionType TEXT
    );
    CREATE TABLE "Job" (
      id TEXT PRIMARY KEY,
      userId TEXT,
      statusId TEXT,
      applied INTEGER,
      appliedDate TEXT,
      resumeId TEXT,
      description TEXT
    );
    CREATE TABLE "WorkExperience" (
      id TEXT PRIMARY KEY,
      resumeSectionId TEXT,
      companyId TEXT,
      jobTitleId TEXT,
      startDate TEXT,
      endDate TEXT
    );
    CREATE TABLE "Education" (
      id TEXT PRIMARY KEY,
      resumeSectionId TEXT,
      institution TEXT,
      degree TEXT,
      startDate TEXT,
      endDate TEXT
    );
    CREATE TABLE "LicenseOrCertification" (
      id TEXT PRIMARY KEY,
      resumeSectionId TEXT,
      title TEXT,
      organization TEXT
    );
    CREATE TABLE "Skill" (
      id TEXT PRIMARY KEY,
      resumeSectionId TEXT,
      tagId TEXT,
      "order" INTEGER
    );
    CREATE TABLE "Tag" (id TEXT PRIMARY KEY, label TEXT);
    CREATE TABLE "ContactInfo" (
      id TEXT PRIMARY KEY,
      resumeId TEXT,
      email TEXT,
      phone TEXT,
      address TEXT
    );
    INSERT INTO "JobStatus" VALUES
      ('s-draft','Draft','draft'),
      ('s-applied','Applied','applied'),
      ('s-interview','Interview','interview'),
      ('s-new','New','new');
    INSERT INTO "User" VALUES ('u1','t','t@example.com');
    INSERT INTO "Profile" VALUES ('p1','u1');
    INSERT INTO "Resume" VALUES ('r1','p1','A'), ('r2','p1','B');
    INSERT INTO "Job" VALUES
      ('j1','u1','s-draft',0,NULL,NULL,'desc 1'),
      ('j2','u1','s-applied',1,'2024-01-02T00:00:00.000Z','r1','desc 2'),
      ('j3','u1','s-interview',1,NULL,'r1','desc 3'),
      ('j4','u1','s-applied',0,NULL,NULL,'desc 4'),
      ('j5','u1','s-draft',1,'2024-01-03T00:00:00.000Z','r2','desc 5');
    INSERT INTO "Company" VALUES ('c1','Acme');
    INSERT INTO "JobTitle" VALUES ('t1','Engineer');
    INSERT INTO "ResumeSection" VALUES
      ('sec1','r1','Experience','experience'),
      ('sec2','r2','Experience','experience'),
      ('sec3','r1','Skills','skills');
    INSERT INTO "WorkExperience" VALUES
      ('we1','sec1','c1','t1','2020-01-01','2021-01-01'),
      ('we2','sec2','c1','t1','2020-01-01','2021-01-01');
    INSERT INTO "Tag" VALUES ('tag1','TypeScript');
    INSERT INTO "Skill" VALUES ('sk1','sec3','tag1',0);
  `);
  db.close();
  return { dir, dbPath };
}

describe("Phase 2 dry-run auditor", () => {
  it("rejects mutation SQL and unknown PRAGMA writes", () => {
    expect(isMutationSql("SELECT 1")).toBe(false);
    expect(isMutationSql("PRAGMA query_only = ON")).toBe(false);
    expect(isMutationSql("INSERT INTO Job VALUES (1)")).toBe(true);
    expect(isMutationSql("UPDATE Job SET applied = 1")).toBe(true);
    expect(isMutationSql("DELETE FROM Job")).toBe(true);
    expect(isMutationSql("CREATE TABLE x (id TEXT)")).toBe(true);
    expect(isMutationSql("ALTER TABLE Job ADD COLUMN x TEXT")).toBe(true);
    expect(isMutationSql("DROP TABLE Job")).toBe(true);
    expect(isMutationSql("REPLACE INTO Job VALUES (1)")).toBe(true);
    expect(isMutationSql("PRAGMA journal_mode = WAL")).toBe(true);
    expect(isMutationSql("VACUUM")).toBe(true);
    expect(() => assertSelectOnly("INSERT INTO Job VALUES (1)")).toThrow(
      /READ_ONLY_ACCESS_BLOCKER/,
    );
  });

  it("does not call Prisma mutation APIs or application mutation services", () => {
    const src = fs.readFileSync(AUDITOR_SRC, "utf8");
    expect(src).not.toMatch(/from ["']@\/lib\/db["']/);
    expect(src).not.toMatch(/from ["']@prisma\/client["']/);
    expect(src).not.toMatch(/new PrismaClient/);
    expect(src).not.toMatch(
      /prisma\.\w+\.(create|update|delete|upsert|createMany|updateMany|deleteMany)/,
    );
    expect(src).not.toMatch(
      /from ["']@\/actions\/job\/mutations["']|from ["']@\/lib\/jobs\/createJobRecord["']/,
    );
  });

  it("classifies known synthetic lifecycle combinations and does not fall through unknown values", () => {
    const applied = classifyJobLifecycleCombo({
      statusValue: "applied",
      applied: true,
      appliedDatePresent: true,
    });
    expect(applied.createOpportunity).toBe(true);
    expect(applied.createApplicationAttempt).toBe(true);
    expect(applied.stageCategory).toBe("SUBMITTED");
    expect(applied.opportunityStatus).toBe("UNKNOWN");
    expect(applied.classification).toBe("SAFE");

    const draft = classifyJobLifecycleCombo({
      statusValue: "draft",
      applied: false,
      appliedDatePresent: false,
    });
    expect(draft.createApplicationAttempt).toBe(false);
    expect(draft.classification).toBe("SAFE");

    const interviewNoDate = classifyJobLifecycleCombo({
      statusValue: "interview",
      applied: true,
      appliedDatePresent: false,
    });
    expect(interviewNoDate.createApplicationAttempt).toBe(true);
    expect(interviewNoDate.mapSubmittedAtFromAppliedDate).toBe(false);
    expect(interviewNoDate.classification).toBe("CONDITIONAL");

    const draftApplied = classifyJobLifecycleCombo({
      statusValue: "draft",
      applied: true,
      appliedDatePresent: true,
    });
    expect(draftApplied.createApplicationAttempt).toBe(true);
    expect(draftApplied.classification).toBe("CONDITIONAL");

    const expired = classifyJobLifecycleCombo({
      statusValue: "expired",
      applied: false,
      appliedDatePresent: false,
    });
    expect(expired.opportunityStatus).toBe("EXPIRED");
    expect(expired.createApplicationAttempt).toBe(false);

    const unknown = classifyJobLifecycleCombo({
      statusValue: "waiting-for-feedback",
      applied: true,
      appliedDatePresent: true,
    });
    expect(unknown.classification).toBe("DO_NOT_MAP");
    expect(unknown.createOpportunity).toBe(false);
    expect(unknown.createApplicationAttempt).toBe(false);
    expect(unknown.phase3Action).toMatch(/UNMAPPED_UNKNOWN_STATUS/);
  });

  it("never silently maps unknown observed combinations in the matrix", () => {
    const matrix = buildJobStatusMatrix([
      { statusValue: "mystery", applied: 1, appliedDatePresent: 0, n: 3 },
    ]);
    const mystery = matrix.find((row) => row.statusValue === "mystery");
    expect(mystery).toBeTruthy();
    expect(mystery?.observed).toBe(true);
    expect(mystery?.count).toBe(3);
    expect(mystery?.classification).toBe("DO_NOT_MAP");
    expect(mystery?.createOpportunity).toBe(false);
  });

  it("detects duplicate candidates without merging", () => {
    const result = detectDuplicateCandidates({
      workExperiences: [
        {
          id: "a",
          resumeId: "r1",
          userId: "u",
          company: "Acme",
          role: "Eng",
          startDate: "2020-01-01",
          endDate: "2021-01-01",
        },
        {
          id: "b",
          resumeId: "r2",
          userId: "u",
          company: " acme ",
          role: "Eng",
          startDate: "2020-01-01",
          endDate: "2021-01-01",
        },
      ],
      educations: [],
      certifications: [],
      skills: [
        { id: "s1", name: "TypeScript", resumeId: "r1", userId: "u" },
        { id: "s2", name: "typescript", resumeId: "r2", userId: "u" },
      ],
    });
    expect(result.automaticMerges).toBe(0);
    expect(result.groups).toHaveLength(2);
    expect(result.groups.every((g) => g.size === 2)).toBe(true);
    const ids = result.groups.flatMap((g) => g.members.map((m) => m.id)).sort();
    expect(ids).toEqual(["a", "b", "s1", "s2"]);
  });

  it("reconciles matrix counts with inventory", () => {
    const matrix = buildJobStatusMatrix([
      { statusValue: "draft", applied: 0, appliedDatePresent: 0, n: 2 },
      { statusValue: "applied", applied: 1, appliedDatePresent: 1, n: 5 },
    ]);
    const recon = reconcileMatrix(matrix, 7);
    expect(recon.reconciled).toBe(true);
    expect(recon.observedSum).toBe(7);
    const counts = plannedCountsFrom({
      inventory: {
        Job: 7,
        Resume: 1,
        WorkExperience: 2,
        Education: 0,
        LicenseOrCertification: 0,
        Skill: 0,
        OtherSection: 0,
      },
      matrix,
      resumeIdStats: {
        jobsTotal: 7,
        resumeIdPresent: 0,
        resumeIdMissing: 7,
        appliedTrue: 5,
        appliedFalse: 2,
        resumePresentAndApplied: 0,
        resumePresentAndNotApplied: 0,
        resumeMissingAndApplied: 5,
        resumeMissingAndNotApplied: 2,
        resumeIdOrphan: 0,
        distinctResumeIdsOnJobs: 0,
      },
      contactConflicts: [],
      duplicateGroups: [],
      jobsWithDescription: 7,
    });
    expect(counts.legacyJobs).toBe(7);
    expect(counts.plannedJobOpportunities).toBe(7);
    expect(counts.plannedApplicationAttempts).toBe(5);
    expect(counts.automaticMerges).toBe(0);
    expect(counts.REAL_DATABASE_WRITE_OPERATIONS).toBe(0);
  });

  it("fails closed when the database path does not exist", () => {
    expect(() =>
      openReadOnlySqlite(path.join(os.tmpdir(), "vocatrya-missing-phase2.db")),
    ).toThrow(/READ_ONLY_ACCESS_BLOCKER/);
  });

  it("opens SQLite read-only and refuses writes; dry-run does not change bytes", () => {
    const { dir, dbPath } = makeDisposableDb();
    const before = fs.readFileSync(dbPath);
    const db = openReadOnlySqlite(dbPath);
    expect(db.queryOne<{ n: number }>("SELECT COUNT(*) AS n FROM \"Job\"")?.n).toBe(5);
    expect(() => db.query('INSERT INTO "Job" VALUES (1,2,3,0,NULL,NULL,"x")')).toThrow(
      /READ_ONLY_ACCESS_BLOCKER/,
    );
    db.close();

    const report = runPhase2DryRun({
      repoRoot: path.resolve(__dirname, ".."),
      disposableDbPath: dbPath,
      git: {
        branch: "test",
        head: "test",
        statusShort: "",
        upstream: "",
      },
    });
    const after = fs.readFileSync(dbPath);
    expect(Buffer.compare(before, after)).toBe(0);
    expect(report.read_only_proof.REAL_DATABASE_WRITE_OPERATIONS).toBe(0);
    expect(report.read_only_proof.REAL_DB_READ_ONLY_VERIFIED).toBe(true);
    expect(report.job_status_matrix_reconciliation.reconciled).toBe(true);
    expect(report.dry_run_counts.legacyJobs).toBe(5);
    expect(report.dry_run_counts.plannedJobOpportunities).toBe(5);
    expect(report.job_resume_id_assessment.classification).toBe("DO_NOT_MAP");
    expect(report.resume_ordering_assessment.classification).toBe(
      "ORDER_UNRECOVERABLE",
    );
    expect(JOB_RESUME_ID_CLASSIFICATION).toBe("DO_NOT_MAP");
    expect(RESUME_ORDERING_CLASSIFICATION).toBe("ORDER_UNRECOVERABLE");
    expect(report.career_material_duplicate_candidates.AUTOMATIC_MERGES).toBe(0);
    expect(
      report.career_material_duplicate_candidates.groupCount,
    ).toBeGreaterThanOrEqual(1);
    expect(FIELD_MAPPING_MATRIX.some((r) => r.legacyField.includes("JobSource as Application.channel"))).toBe(
      true,
    );
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EPERM" && code !== "EBUSY") throw err;
    }
  });
});

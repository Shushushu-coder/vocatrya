import fs from "fs";
import path from "path";
import {
  BACKUP_FORMAT_VERSION,
  BackupDataSchema,
  ManifestSchema,
  SUPPORTED_BACKUP_FORMAT_VERSIONS,
} from "@/lib/backup/schema";
import {
  DEFERRED_FKS,
  INSERT_ORDER,
  MODEL_SPECS,
  QUESTION_BANK_IN_DELETE_ORDER,
} from "@/lib/backup/ordering";
import {
  backupCoverageStatus,
  BACKUP_COVERAGE_STATUS,
  INTENTIONALLY_EXCLUDED_PRISMA_MODELS,
} from "@/lib/backup/coverage";
import { IdMap } from "@/lib/backup/idmap";
import { remapLegacyMigrationMapIds } from "@/lib/backup/migrationMap";
import {
  isAbsoluteStorageKey,
  logicalResumeArtifactStorageKey,
} from "@/lib/backup/normalize";
import { LEGACY, TARGET } from "@/lib/legacy-migration/identities";

const SCHEMA_PATH = path.resolve(__dirname, "../prisma/schema.prisma");

describe("Phase 4 backup contract", () => {
  it("writes formatVersion 11 and still reads v1-v10", () => {
    expect(BACKUP_FORMAT_VERSION).toBe(11);
    expect([...SUPPORTED_BACKUP_FORMAT_VERSIONS]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(ManifestSchema.parse({
      formatVersion: 1,
      appVersion: "1.0.0",
      exportedAt: "2026-01-01T00:00:00.000Z",
      sourceEmail: "a@b.com",
      counts: {},
    }).formatVersion).toBe(1);
  });

  it("does not serialize DataMigrationRun", () => {
    expect(Object.keys(BackupDataSchema.shape)).not.toContain("DataMigrationRun");
    const parsed = BackupDataSchema.parse({
      DataMigrationRun: [
        { id: "run-1", counts: JSON.stringify({ sourcePath: "C:\\\\prod\\\\dev.db" }) },
      ],
    });
    expect(parsed).not.toHaveProperty("DataMigrationRun");
    expect(JSON.stringify(parsed)).not.toContain("sourcePath");
  });

  it("classifies every Prisma model as backed up or intentionally excluded", () => {
    const schema = fs.readFileSync(SCHEMA_PATH, "utf8");
    const models = [...schema.matchAll(/^model (\w+)/gm)].map((match) => match[1]);
    expect(models.length).toBeGreaterThan(40);

    const missing: string[] = [];
    for (const model of models) {
      if (!backupCoverageStatus(model)) missing.push(model);
    }
    expect(missing).toEqual([]);
    expect(backupCoverageStatus("DataMigrationRun")).toBe(
      BACKUP_COVERAGE_STATUS.INTENTIONALLY_EXCLUDED,
    );
    expect(backupCoverageStatus("ApiKey")).toBe(
      BACKUP_COVERAGE_STATUS.INTENTIONALLY_EXCLUDED,
    );
    expect([...INTENTIONALLY_EXCLUDED_PRISMA_MODELS]).toContain("DataMigrationRun");
    for (const model of INSERT_ORDER) {
      expect(backupCoverageStatus(model)).toBe(BACKUP_COVERAGE_STATUS.BACKED_UP);
    }
  });

  it("excludes derived conversation summaries while preserving transcripts", () => {
    expect(backupCoverageStatus("ConversationSummary")).toBe(
      BACKUP_COVERAGE_STATUS.INTENTIONALLY_EXCLUDED,
    );
    expect(backupCoverageStatus("ChatConversation")).toBe(
      BACKUP_COVERAGE_STATUS.BACKED_UP,
    );
    expect(BackupDataSchema.shape).not.toHaveProperty("ConversationSummary");
    expect(BackupDataSchema.shape).toHaveProperty("ChatConversation");
    expect(INSERT_ORDER).not.toContain("ConversationSummary");
  });

  it("keeps QuestionBank as covered reference data without a format bump", () => {
    // Spec v1 §14–§16, §20–§21, §30: QuestionBank stays in the payload as
    // REFERENCE_DATA_SNAPSHOT (present in export, used during restore, never
    // user-wiped) — still BACKED_UP, never INTENTIONALLY_EXCLUDED. Later
    // format bumps came from DateTime V1 sidecars, the career contract and
    // the skill↔Tag link, not from any QuestionBank payload change.
    expect(BACKUP_FORMAT_VERSION).toBeGreaterThanOrEqual(8);
    expect(backupCoverageStatus("QuestionBank")).toBe(
      BACKUP_COVERAGE_STATUS.BACKED_UP,
    );
    expect(backupCoverageStatus("QuestionBankItem")).toBe(
      BACKUP_COVERAGE_STATUS.BACKED_UP,
    );
    expect([...INTENTIONALLY_EXCLUDED_PRISMA_MODELS]).not.toContain(
      "QuestionBank",
    );
    expect([...INTENTIONALLY_EXCLUDED_PRISMA_MODELS]).not.toContain(
      "QuestionBankItem",
    );
    expect(QUESTION_BANK_IN_DELETE_ORDER).toBe(false);
    expect(BackupDataSchema.shape).toHaveProperty("QuestionBank");
    expect(BackupDataSchema.shape).toHaveProperty("QuestionBankItem");
  });

  it("leaves global/infra models untouched by the QuestionBank reference rule", () => {
    // Step 29 audit: adding wipeMode none for QuestionBank must not change
    // AbMigrationState (instance singleton, still whole-set replaced),
    // LegacyMigrationMap (still user-owned), or JobStatus infra (still
    // intentionally excluded, resolved by natural key outside the transaction).
    expect(MODEL_SPECS.AbMigrationState.wipeMode).toBeUndefined();
    expect(MODEL_SPECS.LegacyMigrationMap.owner).toBe("userId");
    expect(backupCoverageStatus("JobStatus")).toBe(
      BACKUP_COVERAGE_STATUS.INTENTIONALLY_EXCLUDED,
    );
    expect(INSERT_ORDER).toContain("AbMigrationState");
    expect(INSERT_ORDER).toContain("LegacyMigrationMap");
  });

  it("covers every required A+B user-state model", () => {
    const required = [
      "RecruitmentCampaign",
      "JobOpportunity",
      "JobDescriptionVersion",
      "JobDescriptionParse",
      "JobOpportunityNote",
      "ApplicationAttempt",
      "ApplicationProcessStep",
      "ApplicationInterviewDetail",
      "ApplicationInterviewReflectionItem",
      "ApplicationAssessmentDetail",
      "ApplicationOfferDetail",
      "JobSearchPreference",
      "CareerMaterialItem",
      "CareerInternshipDetail",
      "CareerEmploymentDetail",
      "CareerProjectDetail",
      "CareerResearchDetail",
      "CareerPublicationDetail",
      "CareerCompetitionDetail",
      "CareerCampusActivityDetail",
      "CareerEducationDetail",
      "CareerAwardDetail",
      "CareerSkillDetail",
      "CareerCertificationDetail",
      "CareerCustomDetail",
      "CareerEvidence",
      "CandidateProfile",
      "CandidateSensitiveInfo",
      "CandidateFamilyMember",
      "ResumeVariant",
      "ResumeVariantVersion",
      "ResumeVariantSection",
      "ResumeVariantSectionItem",
      "ResumeExpression",
      "ResumeExpressionEvidence",
      "ResumeArtifact",
      "MatchAnalysis",
      "FastScreeningDetail",
      "DeepMatchDetail",
      "MatchEvidenceLink",
      "LegacyMigrationMap",
      "AbMigrationState",
    ];
    for (const model of required) {
      expect(INSERT_ORDER).toContain(model);
      expect(MODEL_SPECS[model as keyof typeof MODEL_SPECS]).toBeTruthy();
      expect(BackupDataSchema.shape).toHaveProperty(model);
    }
  });

  it("keeps deferred FKs out of the linear FK map", () => {
    const fields = DEFERRED_FKS.map((entry) => `${entry.model}.${entry.field}`).sort();
    expect(fields).toEqual([
      "AgentOperationProposal.supersedesId",
      "AnswerAttempt.activeRevisionId",
      "ApplicationAttempt.transferredFromAttemptId",
      "ChatConversation.agentTaskId",
      "InterviewSession.currentQuestionInstanceId",
      "JobDescriptionVersion.currentParseId",
      "JobOpportunity.currentJdVersionId",
      "ResumeVariant.currentVersionId",
      "ResumeVariantVersion.parentVersionId",
      "ResumeVariantVersion.sourceMatchAnalysisId",
    ]);
  });

  it("preserves Company A+B fields and defaults missing v1 keys", () => {
    const withFields = BackupDataSchema.parse({
      Company: [
        {
          id: "c1",
          label: "Acme",
          value: "acme",
          logoUrl: null,
          notes: "n",
          sizeLabel: "L",
          headquarters: "Beijing",
        },
      ],
    });
    expect(withFields.Company[0]).toMatchObject({
      notes: "n",
      sizeLabel: "L",
      headquarters: "Beijing",
    });

    const v1 = BackupDataSchema.parse({
      Company: [{ id: "c1", label: "Acme", value: "acme", logoUrl: null }],
    });
    expect(v1.Company[0].notes).toBeUndefined();
    expect(v1.JobOpportunity).toEqual([]);
    expect(v1.LegacyMigrationMap).toEqual([]);
  });

  it("rejects a malformed v2 JobOpportunity group", () => {
    const res = BackupDataSchema.safeParse({
      JobOpportunity: [{ id: "opp-1", title: "Missing required companyId" }],
    });
    expect(res.success).toBe(false);
  });

  it("rebuilds ResumeArtifact storage keys as logical paths", () => {
    expect(isAbsoluteStorageKey("C:\\\\Users\\\\HP\\\\resume.pdf")).toBe(true);
    expect(isAbsoluteStorageKey("C:/Users/HP/resume.pdf")).toBe(true);
    expect(isAbsoluteStorageKey("/var/data/resume.pdf")).toBe(true);
    expect(isAbsoluteStorageKey("resume-artifacts/id/file.pdf")).toBe(false);
    const key = logicalResumeArtifactStorageKey("new-id", "C:\\\\Users\\\\HP\\\\resume.pdf");
    expect(key).toBe("resume-artifacts/new-id/resume.pdf");
    expect(key).not.toMatch(/C:/);
    expect(isAbsoluteStorageKey(key)).toBe(false);
  });

  it("remaps LegacyMigrationMap semantic ids through the restore IdMap", () => {
    const idMap = new IdMap();
    const jobNew = idMap.mint("job-old");
    const oppNew = idMap.mint("opp-old");
    const remapped = remapLegacyMigrationMapIds(
      {
        legacyEntityType: LEGACY.JOB,
        legacyEntityId: "job-old",
        targetEntityType: TARGET.JOB_OPPORTUNITY,
        targetEntityId: "opp-old",
      },
      idMap,
      "session-user",
    );
    expect(remapped.legacyEntityId).toBe(jobNew);
    expect(remapped.targetEntityId).toBe(oppNew);
  });

  it("rewrites UserContactInfo legacy ids to the session user", () => {
    const idMap = new IdMap();
    const profileNew = idMap.mint("profile-old");
    const remapped = remapLegacyMigrationMapIds(
      {
        legacyEntityType: LEGACY.USER_CONTACT_INFO,
        legacyEntityId: "source-user",
        targetEntityType: TARGET.CANDIDATE_PROFILE,
        targetEntityId: "profile-old",
      },
      idMap,
      "session-user",
    );
    expect(remapped.legacyEntityId).toBe("session-user");
    expect(remapped.targetEntityId).toBe(profileNew);
    expect(remapped.targetEntityType).toBe(TARGET.CANDIDATE_PROFILE);
  });

  it("remaps legacy ResumeContactProfile mapping targets to CandidateProfile", () => {
    const idMap = new IdMap();
    const profileNew = idMap.mint("profile-old");
    const remapped = remapLegacyMigrationMapIds(
      {
        legacyEntityType: LEGACY.USER_CONTACT_INFO,
        legacyEntityId: "source-user",
        targetEntityType: "ResumeContactProfile",
        targetEntityId: "profile-old",
      },
      idMap,
      "session-user",
    );
    expect(remapped.legacyEntityId).toBe("session-user");
    expect(remapped.targetEntityId).toBe(profileNew);
    expect(remapped.targetEntityType).toBe(TARGET.CANDIDATE_PROFILE);
  });

  it("fails closed when a mapping points at an unknown type or missing row", () => {
    const idMap = new IdMap();
    expect(() =>
      remapLegacyMigrationMapIds(
        {
          legacyEntityType: "NotAModel",
          legacyEntityId: "x",
          targetEntityType: TARGET.JOB_OPPORTUNITY,
          targetEntityId: "y",
        },
        idMap,
        "u",
      ),
    ).toThrow(/not in the backup remap table/);
    expect(() =>
      remapLegacyMigrationMapIds(
        {
          legacyEntityType: LEGACY.JOB,
          legacyEntityId: "missing",
          targetEntityType: TARGET.JOB_OPPORTUNITY,
          targetEntityId: "also-missing",
        },
        idMap,
        "u",
      ),
    ).toThrow(/not in the restored id map/);
  });
});

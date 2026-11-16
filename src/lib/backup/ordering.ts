// The single table that drives export scoping, wipe scoping, FK rewriting and
// ownership injection. Dataset membership is declared on each spec so standard
// vs sensitive restore cannot drift into a second handwritten list.
//
// InterviewDx frozen spec identity (spec v1) — the sole domain semantic source
// for the Interview backup implementation (READ_ONLY, never redefined here):
//   docs/INTERVIEW_PERSISTENCE_DATA_CONTRACT.md
//   docs/INTERVIEW_RESTORE_TOPOLOGY.md
//   docs/INTERVIEW_BACKUP_ROUNDTRIP_INVARIANTS.md
//   src/backup/interviewPersistenceModels.ts
//   src/backup/backupManifest.ts
//   src/backup/restoreTopology.ts
//   src/backup/questionBankRestorePolicy.ts
//   + canonical round-trip fixture / questionbank restore fixtures / roundtripAssertions.ts
// Direction: InterviewDx frozen spec → Vocatrya implementation → conformance audit.
export const INTERVIEW_SPEC_TAG = "interview-vocatrya-spec-v1" as const;
export const INTERVIEW_SPEC_COMMIT =
  "a7a8e2ed75e3797c207851f62e3a13732d405f6d" as const;

// QuestionBank natural identity + canonical metadata (spec v1 §9–§11, frozen).
// Identity: (bankKey, version). Canonical metadata: title/locale/kind.
// Comparison explicitly ignores id/createdAt/updatedAt.
export const QUESTION_BANK_IDENTITY_FIELDS = ["bankKey", "version"] as const;
export const QUESTION_BANK_CANONICAL_METADATA_FIELDS = [
  "title",
  "locale",
  "kind",
] as const;
export const QUESTION_BANK_EXCLUDED_COMPARISON_FIELDS = [
  "id",
  "createdAt",
  "updatedAt",
] as const;

// Normative restore error (spec v1 §12 Case C, frozen).
export const QUESTION_BANK_VERSION_CONFLICT =
  "QUESTION_BANK_VERSION_CONFLICT" as const;

// QuestionBank ∉ per-user wipe/delete set (spec v1 §15, frozen).
export const QUESTION_BANK_IN_DELETE_ORDER = false as const;

// TranscriptRevision cross-user author rule (spec v1 §19, frozen):
// non-null createdByUserId → normalized to importing user (ACCEPTED).
export const TRANSCRIPT_REVISION_AUTHOR_POLICY =
  "NORMALIZED_TO_IMPORTING_USER_ON_CROSS_USER_RESTORE" as const;
// Explicit provenance trade-off (spec v1 §19, frozen). Never describe as
// AUTHOR_PROVENANCE_LOSS: NONE.
export const KNOWN_PROVENANCE_TRADEOFF =
  "original author identity is not preserved across cross-user restore" as const;

export type BackupModel =
  | "Company"
  | "JobTitle"
  | "Location"
  | "JobSource"
  | "Tag"
  | "ActivityType"
  | "Profile"
  | "File"
  | "Resume"
  | "ContactInfo"
  | "Summary"
  | "ResumeSection"
  | "WorkExperience"
  | "Education"
  | "LicenseOrCertification"
  | "OtherSection"
  | "Skill"
  | "CoverLetter"
  | "Automation"
  | "Job"
  | "Note"
  | "Interview"
  | "Contact"
  | "ContactRole"
  | "JobContact"
  | "Task"
  | "Question"
  | "AIConnection"
  | "AIBusinessAssignment"
  | "ChatConversation"
  | "AgentOperationProposal"
  | "AutomationRun"
  | "UserSettings"
  | "AbMigrationState"
  | "JobSearchPreference"
  | "RecruitmentCampaign"
  | "JobOpportunity"
  | "JobDescriptionVersion"
  | "JobDescriptionParse"
  | "JobOpportunityNote"
  | "CareerMaterialItem"
  | "CareerInternshipDetail"
  | "CareerEmploymentDetail"
  | "CareerProjectDetail"
  | "CareerResearchDetail"
  | "CareerPublicationDetail"
  | "CareerCompetitionDetail"
  | "CareerCampusActivityDetail"
  | "CareerEducationDetail"
  | "CareerAwardDetail"
  | "CareerSkillDetail"
  | "CareerCertificationDetail"
  | "CareerCustomDetail"
  | "CareerLanguageDetail"
  | "CareerEvidence"
  | "CandidateProfile"
  | "CandidateSensitiveInfo"
  | "CandidateFamilyMember"
  | "CandidateReferee"
  | "CandidateAttachment"
  | "ResumeVariant"
  | "ResumeVariantVersion"
  | "ResumeVariantSection"
  | "ResumeVariantSectionItem"
  | "ResumeExpression"
  | "ResumeExpressionEvidence"
  | "ResumeArtifact"
  | "MatchAnalysis"
  | "FastScreeningDetail"
  | "DeepMatchDetail"
  | "MatchEvidenceLink"
  | "ApplicationAttempt"
  | "ApplicationProcessStep"
  | "ApplicationInterviewDetail"
  | "ApplicationInterviewReflectionItem"
  | "ApplicationAssessmentDetail"
  | "ApplicationOfferDetail"
  | "LegacyMigrationMap"
  | "QuestionBank"
  | "QuestionBankItem"
  | "InterviewPrepGoal"
  | "InterviewSession"
  | "QuestionInstance"
  | "AnswerAttempt"
  | "AnswerInputArtifact"
  | "Transcript"
  | "TranscriptRevision"
  | "FeedbackGeneration"
  | "FeedbackItem"
  | "SessionSummaryGeneration"
  | "SessionSummaryInput"
  | "CoachingConversation"
  | "DialogueTurn"
  | "Reminder";

export type BackupDataset = "standard" | "sensitive";

export interface ModelSpec {
  // Prisma client delegate key, e.g. prisma[spec.delegate].findMany(...)
  delegate: string;
  // Ownership column written from the session user, never read from the file.
  owner?: "userId" | "createdBy";
  // Resolved by (value, createdBy) upsert rather than minted fresh.
  lookup?: boolean;
  // Foreign-key column -> the model whose ids it points at.
  // Cyclic "current pointer" FKs are NOT listed here; they live in DEFERRED_FKS
  // and are patched after every referenced row exists.
  fks: Record<string, BackupModel>;
  // Ownership-scoped where clause, per CLAUDE.md's IDOR rules.
  scope: (userId: string) => Record<string, unknown>;
  // Omitted dataset means standard. Sensitive models are opt-in on export
  // and wiped only when the backup manifest declares containsSensitiveData.
  dataset?: BackupDataset;
  // Wipe scope for per-user restore. Omitted means "user" (scoped rows are
  // deleted on restore). "none" means the model is never deleted by a
  // per-user restore — used for system-managed global reference data
  // (spec v1: QuestionBank = REFERENCE_DATA, never wiped).
  wipeMode?: "user" | "none";
}

const byUser = (userId: string) => ({ userId });
const byCreatedBy = (userId: string) => ({ createdBy: userId });
const byProfile = (userId: string) => ({ profile: { userId } });
const byResume = (userId: string) => ({ Resume: { profile: { userId } } });
const bySection = (userId: string) => ({
  ResumeSection: { Resume: { profile: { userId } } },
});
const byOpportunity = (userId: string) => ({ jobOpportunity: { userId } });
const byJdVersion = (userId: string) => ({
  jobDescriptionVersion: { jobOpportunity: { userId } },
});
const byAttempt = (userId: string) => ({ applicationAttempt: { userId } });
const byProcessStep = (userId: string) => ({
  processStep: { applicationAttempt: { userId } },
});
const byInterviewDetail = (userId: string) => ({
  applicationInterviewDetail: {
    processStep: { applicationAttempt: { userId } },
  },
});
const byMaterial = (userId: string) => ({ materialItem: { userId } });
const byVariant = (userId: string) => ({ resumeVariant: { userId } });
const byVariantVersion = (userId: string) => ({
  version: { resumeVariant: { userId } },
});
const byVariantSection = (userId: string) => ({
  section: { version: { resumeVariant: { userId } } },
});
const bySectionItem = (userId: string) => ({
  sectionItem: { section: { version: { resumeVariant: { userId } } } },
});
const byExpression = (userId: string) => ({
  resumeExpression: {
    sectionItem: { section: { version: { resumeVariant: { userId } } } },
  },
});
const byMatch = (userId: string) => ({ matchAnalysis: { userId } });
const bySensitiveInfo = (userId: string) => ({ sensitiveInfo: { userId } });
const byInterviewSession = (userId: string) => ({ session: { userId } });

export const MODEL_SPECS: Record<BackupModel, ModelSpec> = {
  Company: {
    delegate: "company",
    owner: "createdBy",
    lookup: true,
    fks: {},
    scope: byCreatedBy,
  },
  JobTitle: {
    delegate: "jobTitle",
    owner: "createdBy",
    lookup: true,
    fks: {},
    scope: byCreatedBy,
  },
  Location: {
    delegate: "location",
    owner: "createdBy",
    lookup: true,
    fks: {},
    scope: byCreatedBy,
  },
  JobSource: {
    delegate: "jobSource",
    owner: "createdBy",
    lookup: true,
    fks: {},
    scope: byCreatedBy,
  },
  Tag: {
    delegate: "tag",
    owner: "createdBy",
    lookup: true,
    fks: {},
    scope: byCreatedBy,
  },
  ActivityType: {
    delegate: "activityType",
    owner: "createdBy",
    lookup: true,
    fks: {},
    scope: byCreatedBy,
  },

  Profile: { delegate: "profile", owner: "userId", fks: {}, scope: byUser },

  // File holds no foreign key — Resume.FileId points at it — so it is scoped
  // through the back-relation, matching deleteFile in profile.actions.ts.
  File: { delegate: "file", fks: {}, scope: byResume },

  Resume: {
    delegate: "resume",
    fks: { profileId: "Profile", FileId: "File" },
    scope: byProfile,
  },

  // ContactInfo hangs off Resume, not ResumeSection: resumeId @unique, and the
  // relation field is lower-case `resume` unlike ResumeSection's `Resume`.
  ContactInfo: {
    delegate: "contactInfo",
    fks: { resumeId: "Resume" },
    scope: (userId) => ({ resume: { profile: { userId } } }),
  },

  // Summary holds no foreign key either — ResumeSection.summaryId points at it.
  Summary: { delegate: "summary", fks: {}, scope: bySection },

  ResumeSection: {
    delegate: "resumeSection",
    fks: { resumeId: "Resume", summaryId: "Summary" },
    scope: byResume,
  },
  WorkExperience: {
    delegate: "workExperience",
    fks: {
      companyId: "Company",
      jobTitleId: "JobTitle",
      locationId: "Location",
      resumeSectionId: "ResumeSection",
    },
    scope: bySection,
  },
  Education: {
    delegate: "education",
    fks: { locationId: "Location", resumeSectionId: "ResumeSection" },
    scope: bySection,
  },
  LicenseOrCertification: {
    delegate: "licenseOrCertification",
    fks: { resumeSectionId: "ResumeSection" },
    scope: bySection,
  },
  OtherSection: {
    delegate: "otherSection",
    fks: { resumeSectionId: "ResumeSection" },
    scope: bySection,
  },
  Skill: {
    delegate: "skill",
    fks: { tagId: "Tag", resumeSectionId: "ResumeSection" },
    scope: bySection,
  },
  CoverLetter: {
    delegate: "coverLetter",
    fks: { profileId: "Profile" },
    scope: byProfile,
  },
  Automation: {
    delegate: "automation",
    owner: "userId",
    fks: { resumeId: "Resume" },
    scope: byUser,
  },
  Job: {
    delegate: "job",
    owner: "userId",
    fks: {
      jobTitleId: "JobTitle",
      companyId: "Company",
      jobSourceId: "JobSource",
      locationId: "Location",
      resumeId: "Resume",
      coverLetterId: "CoverLetter",
      automationId: "Automation",
    },
    scope: byUser,
  },
  Note: {
    delegate: "note",
    owner: "userId",
    fks: { jobId: "Job" },
    scope: byUser,
  },
  Interview: {
    delegate: "interview",
    fks: { jobId: "Job" },
    scope: (userId) => ({ job: { userId } }),
  },
  Contact: {
    delegate: "contact",
    owner: "createdBy",
    fks: {
      interviewId: "Interview",
      companyId: "Company",
      locationId: "Location",
      workedAtCompanyId: "Company",
      roleId: "ContactRole",
    },
    scope: byCreatedBy,
  },
  // A lookup like every other (value, createdBy) reference table, so a restore
  // into an account that already has the seeded roles does not double them.
  ContactRole: {
    delegate: "contactRole",
    owner: "createdBy",
    lookup: true,
    fks: {},
    scope: byCreatedBy,
  },
  JobContact: {
    delegate: "jobContact",
    fks: { jobId: "Job", contactId: "Contact", roleId: "ContactRole" },
    scope: (userId) => ({ Job: { userId } }),
  },
  Task: {
    delegate: "task",
    owner: "userId",
    fks: { activityTypeId: "ActivityType" },
    scope: byUser,
  },
  Question: {
    delegate: "question",
    owner: "createdBy",
    fks: {},
    scope: byCreatedBy,
  },
  // Phase B account-login foundation: user business config, so both models
  // travel in the standard backup. Connection metadata only — credentials
  // and runtime login state never leave the machine, so a restored
  // ACCOUNT_LOGIN row is normalized to REAUTH_REQUIRED on import.
  AIConnection: {
    delegate: "aIConnection",
    owner: "userId",
    fks: {},
    scope: byUser,
  },
  // connectionId is required fail-closed: an assignment without its
  // connection is meaningless, so it is intentionally absent from
  // OPTIONAL_FKS.
  AIBusinessAssignment: {
    delegate: "aIBusinessAssignment",
    owner: "userId",
    fks: { connectionId: "AIConnection" },
    scope: byUser,
  },
  // resolvedConnectionId is a provenance pointer, not a hard FK: a restore
  // where the connection was never exported keeps the raw id so the
  // conversation reports ASSIGNED_CONNECTION_UNAVAILABLE at run time
  // rather than silently falling back to legacy (PRESERVE_DANGLING_FKS in
  // idmap.ts is what differs from OPTIONAL_FKS here).
  ChatConversation: {
    delegate: "chatConversation",
    owner: "userId",
    fks: { resolvedConnectionId: "AIConnection" },
    scope: byUser,
  },
  // Durable operation proposals are user state: the row carries the
  // decision/dispatch evidence the transcript part only displays. The
  // runtime links (harnessTaskId) are cleared on import — never backed-up
  // task rows to resurrect. conversationId is SetNull (OPTIONAL_FKS);
  // supersedesId remaps through this model's own id map.
  AgentOperationProposal: {
    delegate: "agentOperationProposal",
    owner: "userId",
    fks: {
      conversationId: "ChatConversation",
    },
    scope: byUser,
  },
  AutomationRun: {
    delegate: "automationRun",
    fks: { automationId: "Automation", resolvedConnectionId: "AIConnection" },
    scope: (userId) => ({ automation: { userId } }),
  },
  UserSettings: {
    delegate: "userSettings",
    owner: "userId",
    fks: {},
    scope: byUser,
  },

  // Instance-level singleton. Restored with the ZIP because it decides whether
  // the restored database may enter A+B runtime. Feature flag still defaults off.
  AbMigrationState: {
    delegate: "abMigrationState",
    fks: {},
    scope: () => ({}),
  },

  JobSearchPreference: {
    delegate: "jobSearchPreference",
    owner: "userId",
    fks: {},
    scope: byUser,
  },
  RecruitmentCampaign: {
    delegate: "recruitmentCampaign",
    owner: "userId",
    fks: { companyId: "Company" },
    scope: byUser,
  },
  JobOpportunity: {
    delegate: "jobOpportunity",
    owner: "userId",
    fks: {
      companyId: "Company",
      campaignId: "RecruitmentCampaign",
      sourceAutomationId: "Automation",
    },
    scope: byUser,
  },
  JobDescriptionVersion: {
    delegate: "jobDescriptionVersion",
    fks: { jobOpportunityId: "JobOpportunity" },
    scope: byOpportunity,
  },
  JobDescriptionParse: {
    delegate: "jobDescriptionParse",
    fks: {
      jobDescriptionVersionId: "JobDescriptionVersion",
      resolvedConnectionId: "AIConnection",
    },
    scope: byJdVersion,
  },
  JobOpportunityNote: {
    delegate: "jobOpportunityNote",
    owner: "userId",
    fks: { jobOpportunityId: "JobOpportunity" },
    scope: byUser,
  },
  CareerMaterialItem: {
    delegate: "careerMaterialItem",
    owner: "userId",
    fks: {},
    scope: byUser,
  },
  CareerInternshipDetail: {
    delegate: "careerInternshipDetail",
    fks: { materialItemId: "CareerMaterialItem", companyId: "Company" },
    scope: byMaterial,
  },
  CareerEmploymentDetail: {
    delegate: "careerEmploymentDetail",
    fks: { materialItemId: "CareerMaterialItem", companyId: "Company" },
    scope: byMaterial,
  },
  CareerProjectDetail: {
    delegate: "careerProjectDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerResearchDetail: {
    delegate: "careerResearchDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerPublicationDetail: {
    delegate: "careerPublicationDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerCompetitionDetail: {
    delegate: "careerCompetitionDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerCampusActivityDetail: {
    delegate: "careerCampusActivityDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerEducationDetail: {
    delegate: "careerEducationDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerAwardDetail: {
    delegate: "careerAwardDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerSkillDetail: {
    delegate: "careerSkillDetail",
    fks: { materialItemId: "CareerMaterialItem", tagId: "Tag" },
    scope: byMaterial,
  },
  CareerCertificationDetail: {
    delegate: "careerCertificationDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerCustomDetail: {
    delegate: "careerCustomDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerLanguageDetail: {
    delegate: "careerLanguageDetail",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CareerEvidence: {
    delegate: "careerEvidence",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byMaterial,
  },
  CandidateProfile: {
    delegate: "candidateProfile",
    owner: "userId",
    fks: {},
    scope: byUser,
  },
  CandidateSensitiveInfo: {
    delegate: "candidateSensitiveInfo",
    owner: "userId",
    fks: {},
    scope: byUser,
    dataset: "sensitive",
  },
  CandidateFamilyMember: {
    delegate: "candidateFamilyMember",
    fks: { sensitiveInfoId: "CandidateSensitiveInfo" },
    scope: bySensitiveInfo,
    dataset: "sensitive",
  },
  CandidateReferee: {
    delegate: "candidateReferee",
    fks: { sensitiveInfoId: "CandidateSensitiveInfo" },
    scope: bySensitiveInfo,
    dataset: "sensitive",
  },
  CandidateAttachment: {
    delegate: "candidateAttachment",
    owner: "userId",
    fks: { materialItemId: "CareerMaterialItem" },
    scope: byUser,
    dataset: "sensitive",
  },
  ResumeVariant: {
    delegate: "resumeVariant",
    owner: "userId",
    fks: { targetJobOpportunityId: "JobOpportunity" },
    scope: byUser,
  },
  ResumeVariantVersion: {
    delegate: "resumeVariantVersion",
    fks: {
      resumeVariantId: "ResumeVariant",
      targetJdVersionId: "JobDescriptionVersion",
      resolvedConnectionId: "AIConnection",
    },
    scope: byVariant,
  },
  ResumeVariantSection: {
    delegate: "resumeVariantSection",
    fks: { resumeVariantVersionId: "ResumeVariantVersion" },
    scope: byVariantVersion,
  },
  ResumeVariantSectionItem: {
    delegate: "resumeVariantSectionItem",
    fks: {
      resumeVariantSectionId: "ResumeVariantSection",
      careerMaterialItemId: "CareerMaterialItem",
    },
    scope: byVariantSection,
  },
  ResumeExpression: {
    delegate: "resumeExpression",
    fks: { resumeVariantSectionItemId: "ResumeVariantSectionItem" },
    scope: bySectionItem,
  },
  ResumeExpressionEvidence: {
    delegate: "resumeExpressionEvidence",
    fks: {
      resumeExpressionId: "ResumeExpression",
      careerEvidenceId: "CareerEvidence",
    },
    scope: byExpression,
  },
  ResumeArtifact: {
    delegate: "resumeArtifact",
    fks: { resumeVariantVersionId: "ResumeVariantVersion" },
    scope: byVariantVersion,
  },
  MatchAnalysis: {
    delegate: "matchAnalysis",
    owner: "userId",
    fks: {
      jobOpportunityId: "JobOpportunity",
      jobDescriptionParseId: "JobDescriptionParse",
      resumeVariantVersionId: "ResumeVariantVersion",
      resolvedConnectionId: "AIConnection",
    },
    scope: byUser,
  },
  FastScreeningDetail: {
    delegate: "fastScreeningDetail",
    fks: { matchAnalysisId: "MatchAnalysis" },
    scope: byMatch,
  },
  DeepMatchDetail: {
    delegate: "deepMatchDetail",
    fks: { matchAnalysisId: "MatchAnalysis" },
    scope: byMatch,
  },
  MatchEvidenceLink: {
    delegate: "matchEvidenceLink",
    fks: {
      matchAnalysisId: "MatchAnalysis",
      careerEvidenceId: "CareerEvidence",
      resumeExpressionId: "ResumeExpression",
    },
    scope: byMatch,
  },
  ApplicationAttempt: {
    delegate: "applicationAttempt",
    owner: "userId",
    fks: {
      jobOpportunityId: "JobOpportunity",
      submittedResumeVersionId: "ResumeVariantVersion",
      submittedResumeArtifactId: "ResumeArtifact",
      submittedAgainstJdVersionId: "JobDescriptionVersion",
    },
    scope: byUser,
  },
  ApplicationProcessStep: {
    delegate: "applicationProcessStep",
    fks: { applicationAttemptId: "ApplicationAttempt" },
    scope: byAttempt,
  },
  ApplicationInterviewDetail: {
    delegate: "applicationInterviewDetail",
    fks: { applicationProcessStepId: "ApplicationProcessStep" },
    scope: byProcessStep,
  },
  ApplicationInterviewReflectionItem: {
    delegate: "applicationInterviewReflectionItem",
    fks: {
      applicationInterviewDetailId: "ApplicationInterviewDetail",
      // Nullable back-link into the user's own question bank; remapped through
      // the Question id map, absent ids degrade to NULL (OPTIONAL_FKS).
      sourceQuestionId: "Question",
    },
    scope: byInterviewDetail,
  },
  ApplicationAssessmentDetail: {
    delegate: "applicationAssessmentDetail",
    fks: { applicationProcessStepId: "ApplicationProcessStep" },
    scope: byProcessStep,
  },
  ApplicationOfferDetail: {
    delegate: "applicationOfferDetail",
    fks: { applicationProcessStepId: "ApplicationProcessStep" },
    scope: byProcessStep,
  },
  // Semantic IDs (legacyEntityId / targetEntityId) are rewritten by a dedicated
  // remapper, not by fks — they are not Prisma-declared foreign keys.
  LegacyMigrationMap: {
    delegate: "legacyMigrationMap",
    owner: "userId",
    fks: {},
    scope: byUser,
  },
  // Interview models are included in product backup starting from this change.
  // QuestionBank is system-managed global reference data (spec v1 §8, §14–§15:
  // REFERENCE_DATA_SNAPSHOT, not USER_DATA, never per-user wiped):
  // identity = (bankKey, version); canonical metadata = title/locale/kind;
  // restore resolves each referenced bank BEFORE its QuestionBankItems
  // (missing → CREATE, equal → REUSE existing id, conflict → FAIL CLOSED with
  // QUESTION_BANK_VERSION_CONFLICT). It exports every bank so a restore can
  // rebuild a missing referenced canonical bank, but a per-user restore must
  // never delete unrelated or existing canonical banks.
  // QuestionBankItem is user-scoped membership (spec v1 §16): ownership via
  // QuestionBankItem.questionId → Question.createdBy; a per-user export only
  // carries memberships for that user's own questions and a restore only
  // replaces the current user's memberships.
  QuestionBank: {
    delegate: "questionBank",
    fks: {},
    scope: () => ({}),
    wipeMode: "none",
  },
  QuestionBankItem: {
    delegate: "questionBankItem",
    fks: { bankId: "QuestionBank", questionId: "Question" },
    scope: (userId) => ({ question: { createdBy: userId } }),
  },
  // Long-lived user business state (never a runtime ledger): the goal pins
  // the JD version it prepares against, so both FKs are required. The bound
  // practice session points back through InterviewSession.interviewPrepGoalId
  // (nullable — a goal without a session is the normal pre-practice state,
  // and a session whose goal row is absent degrades to unbound).
  InterviewPrepGoal: {
    delegate: "interviewPrepGoal",
    owner: "userId",
    fks: {
      jobOpportunityId: "JobOpportunity",
      pinnedJobDescriptionVersionId: "JobDescriptionVersion",
    },
    scope: byUser,
  },
  InterviewSession: {
    delegate: "interviewSession",
    owner: "userId",
    fks: {
      jobOpportunityId: "JobOpportunity",
      jobDescriptionVersionId: "JobDescriptionVersion",
      resolvedConnectionId: "AIConnection",
      interviewPrepGoalId: "InterviewPrepGoal",
    },
    scope: byUser,
  },
  QuestionInstance: {
    delegate: "questionInstance",
    fks: { sessionId: "InterviewSession", sourceQuestionId: "Question" },
    scope: byInterviewSession,
  },
  AnswerAttempt: {
    delegate: "answerAttempt",
    fks: {
      questionInstanceId: "QuestionInstance",
      sessionId: "InterviewSession",
    },
    scope: byInterviewSession,
  },
  AnswerInputArtifact: {
    delegate: "answerInputArtifact",
    fks: { answerAttemptId: "AnswerAttempt", sessionId: "InterviewSession" },
    scope: byInterviewSession,
  },
  Transcript: {
    delegate: "transcript",
    fks: {
      sessionId: "InterviewSession",
      answerAttemptId: "AnswerAttempt",
      sourceArtifactId: "AnswerInputArtifact",
    },
    scope: byInterviewSession,
  },
  TranscriptRevision: {
    delegate: "transcriptRevision",
    fks: { transcriptId: "Transcript", answerAttemptId: "AnswerAttempt" },
    scope: (userId) => ({ transcript: { session: { userId } } }),
  },
  FeedbackGeneration: {
    delegate: "feedbackGeneration",
    fks: {
      answerAttemptId: "AnswerAttempt",
      questionInstanceId: "QuestionInstance",
      sessionId: "InterviewSession",
      inputRevisionId: "TranscriptRevision",
    },
    scope: byInterviewSession,
  },
  FeedbackItem: {
    delegate: "feedbackItem",
    fks: {
      sessionId: "InterviewSession",
      transcriptId: "Transcript",
      generationId: "FeedbackGeneration",
    },
    scope: byInterviewSession,
  },
  SessionSummaryGeneration: {
    delegate: "sessionSummaryGeneration",
    fks: { sessionId: "InterviewSession" },
    scope: byInterviewSession,
  },
  SessionSummaryInput: {
    delegate: "sessionSummaryInput",
    fks: {
      summaryGenerationId: "SessionSummaryGeneration",
      sessionId: "InterviewSession",
      questionInstanceId: "QuestionInstance",
      feedbackGenerationId: "FeedbackGeneration",
    },
    scope: (userId) => ({ summary: { session: { userId } } }),
  },
  CoachingConversation: {
    delegate: "coachingConversation",
    fks: { sessionId: "InterviewSession" },
    scope: byInterviewSession,
  },
  DialogueTurn: {
    delegate: "dialogueTurn",
    fks: {
      sessionId: "InterviewSession",
      conversationId: "CoachingConversation",
      questionInstanceId: "QuestionInstance",
      answerAttemptId: "AnswerAttempt",
      commercialFeedbackItemId: "FeedbackItem",
      summaryGenerationId: "SessionSummaryGeneration",
    },
    scope: byInterviewSession,
  },
  // targetId is polymorphic (PROCESS_STEP -> ApplicationProcessStep,
  // JOB_DUE -> Job), so it cannot ride the declared-fks remap: import.ts
  // rewrites it per sourceType, and a target absent from the backup leaves
  // the row restored as CANCELLED rather than pointing at nothing.
  Reminder: {
    delegate: "reminder",
    owner: "userId",
    fks: {},
    scope: byUser,
  },
};

export const INSERT_ORDER: BackupModel[] = [
  "Company",
  "JobTitle",
  "Location",
  "JobSource",
  "Tag",
  "ActivityType",
  "ContactRole",
  "Profile",
  "File",
  "Resume",
  "ContactInfo",
  "Summary",
  "ResumeSection",
  "WorkExperience",
  "Education",
  "LicenseOrCertification",
  "OtherSection",
  "Skill",
  "CoverLetter",
  "Automation",
  "Job",
  "Note",
  "Interview",
  "Contact",
  "JobContact",
  "Task",
  "Question",
  // AIConnection must precede every model that can lock onto it:
  // AIBusinessAssignment, AutomationRun, JobDescriptionParse,
  // ResumeVariantVersion, MatchAnalysis, InterviewSession,
  // ChatConversation.
  "AIConnection",
  "AIBusinessAssignment",
  "ChatConversation",
  "AgentOperationProposal",
  "AutomationRun",
  "UserSettings",
  "AbMigrationState",
  "JobSearchPreference",
  "RecruitmentCampaign",
  "JobOpportunity",
  "JobDescriptionVersion",
  "JobDescriptionParse",
  "JobOpportunityNote",
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
  "CareerLanguageDetail",
  "CareerEvidence",
  "CandidateProfile",
  "CandidateSensitiveInfo",
  "CandidateFamilyMember",
  "CandidateReferee",
  "CandidateAttachment",
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
  "ApplicationAttempt",
  "ApplicationProcessStep",
  "ApplicationInterviewDetail",
  "ApplicationInterviewReflectionItem",
  "ApplicationAssessmentDetail",
  "ApplicationOfferDetail",
  "LegacyMigrationMap",
  "QuestionBank",
  "QuestionBankItem",
  // Prep goals insert before sessions because InterviewSession carries the
  // goal binding FK; wipe reverses this so sessions go first.
  "InterviewPrepGoal",
  "InterviewSession",
  "QuestionInstance",
  "AnswerAttempt",
  "AnswerInputArtifact",
  "Transcript",
  "TranscriptRevision",
  "FeedbackGeneration",
  "FeedbackItem",
  "SessionSummaryGeneration",
  "SessionSummaryInput",
  "CoachingConversation",
  "DialogueTurn",
  // Derived delivery state: wiped (reverse order) before its sources, and on
  // insert every target id is already minted regardless of position.
  "Reminder",
];

export const DELETE_ORDER: BackupModel[] = [...INSERT_ORDER]
  .reverse()
  .filter((model) => MODEL_SPECS[model].wipeMode !== "none");

// Per-user wipe order (spec v1 topology §6): QuestionBank is restored but
// never wiped, so the wipe set is the reverse insert order minus reference
// data. modelsForWipe() filters this by dataset; callers must use
// modelsForWipe()/DELETE_ORDER/USER_WIPE_ORDER, never a hand-rolled
// `if (model === QuestionBank) continue` outside this metadata.
export const USER_WIPE_ORDER: BackupModel[] = [...DELETE_ORDER];

export function backupDataset(model: BackupModel): BackupDataset {
  return MODEL_SPECS[model].dataset ?? "standard";
}

export function includedInStandardBackup(model: BackupModel): boolean {
  return backupDataset(model) === "standard";
}

export function includedInSensitiveBackup(model: BackupModel): boolean {
  return backupDataset(model) === "sensitive";
}

export const STANDARD_BACKUP_MODELS: BackupModel[] = INSERT_ORDER.filter(
  includedInStandardBackup,
);

export const SENSITIVE_BACKUP_MODELS: BackupModel[] = INSERT_ORDER.filter(
  includedInSensitiveBackup,
);

export function modelsForBackup(includeSensitiveData: boolean): BackupModel[] {
  return includeSensitiveData ? [...INSERT_ORDER] : [...STANDARD_BACKUP_MODELS];
}

export function modelsForWipe(containsSensitiveData: boolean): BackupModel[] {
  return DELETE_ORDER.filter(
    (model) => includedInStandardBackup(model) || containsSensitiveData,
  );
}

export const LOOKUP_MODELS: BackupModel[] = INSERT_ORDER.filter(
  (m) => MODEL_SPECS[m].lookup,
);

// Cyclic / forward references that cannot be written on insert because SQLite
// enforces FKs immediately. Insert the row with the column null, then patch.
export const DEFERRED_FKS: ReadonlyArray<{
  model: BackupModel;
  field: string;
  target: BackupModel;
}> = [
  {
    model: "JobOpportunity",
    field: "currentJdVersionId",
    target: "JobDescriptionVersion",
  },
  {
    model: "JobDescriptionVersion",
    field: "currentParseId",
    target: "JobDescriptionParse",
  },
  {
    model: "ResumeVariant",
    field: "currentVersionId",
    target: "ResumeVariantVersion",
  },
  {
    model: "ResumeVariantVersion",
    field: "parentVersionId",
    target: "ResumeVariantVersion",
  },
  {
    model: "ResumeVariantVersion",
    field: "sourceMatchAnalysisId",
    target: "MatchAnalysis",
  },
  {
    model: "ApplicationAttempt",
    field: "transferredFromAttemptId",
    target: "ApplicationAttempt",
  },
  {
    model: "InterviewSession",
    field: "currentQuestionInstanceId",
    target: "QuestionInstance",
  },
  {
    model: "AnswerAttempt",
    field: "activeRevisionId",
    target: "TranscriptRevision",
  },
  // Self-history chain — insert null, patch once every row of the model
  // exists; a dangling pointer degrades to null like any SetNull FK.
  {
    model: "AgentOperationProposal",
    field: "supersedesId",
    target: "AgentOperationProposal",
  },
];

export const DEFERRED_FK_FIELDS = new Set(
  DEFERRED_FKS.map((entry) => `${entry.model}.${entry.field}`),
);

// signup() seeds a JobSource per JOB_SOURCES entry, so no account is ever
// literally empty. Counting content models only keeps the destructive
// confirmation meaningful on a fresh instance. Profile is in the list because
// reads use findFirst — a second profile is a silent coin flip, not an error.
export const EMPTINESS_MODELS: BackupModel[] = [
  "Profile",
  "Resume",
  "CoverLetter",
  "Job",
  "Note",
  "Contact",
  "Task",
  "Question",
  "Automation",
  "JobOpportunity",
  "RecruitmentCampaign",
  "CareerMaterialItem",
  "ResumeVariant",
  "CandidateProfile",
  "JobSearchPreference",
  "MatchAnalysis",
  "ApplicationAttempt",
  "InterviewSession",
  "InterviewPrepGoal",
  "AIConnection",
  "AIBusinessAssignment",
  "CandidateReferee",
  "CandidateAttachment",
];

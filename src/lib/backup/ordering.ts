// The single table that drives export scoping, wipe scoping, FK rewriting and
// ownership injection. Dataset membership is declared on each spec so standard
// vs sensitive restore cannot drift into a second handwritten list.

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
  | "Activity"
  | "Question"
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
  | "CareerEvidence"
  | "CandidateProfile"
  | "CandidateSensitiveInfo"
  | "CandidateFamilyMember"
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
  | "LegacyMigrationMap";

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

export const MODEL_SPECS: Record<BackupModel, ModelSpec> = {
  Company: { delegate: "company", owner: "createdBy", lookup: true, fks: {}, scope: byCreatedBy },
  JobTitle: { delegate: "jobTitle", owner: "createdBy", lookup: true, fks: {}, scope: byCreatedBy },
  Location: { delegate: "location", owner: "createdBy", lookup: true, fks: {}, scope: byCreatedBy },
  JobSource: { delegate: "jobSource", owner: "createdBy", lookup: true, fks: {}, scope: byCreatedBy },
  Tag: { delegate: "tag", owner: "createdBy", lookup: true, fks: {}, scope: byCreatedBy },
  ActivityType: { delegate: "activityType", owner: "createdBy", lookup: true, fks: {}, scope: byCreatedBy },

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
  ContactInfo: { delegate: "contactInfo", fks: { resumeId: "Resume" }, scope: (userId) => ({ resume: { profile: { userId } } }) },

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
  CoverLetter: { delegate: "coverLetter", fks: { profileId: "Profile" }, scope: byProfile },
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
  Note: { delegate: "note", owner: "userId", fks: { jobId: "Job" }, scope: byUser },
  Interview: { delegate: "interview", fks: { jobId: "Job" }, scope: (userId) => ({ job: { userId } }) },
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
  Activity: {
    delegate: "activity",
    owner: "userId",
    fks: { activityTypeId: "ActivityType", taskId: "Task" },
    scope: byUser,
  },
  Question: { delegate: "question", owner: "createdBy", fks: {}, scope: byCreatedBy },
  AutomationRun: {
    delegate: "automationRun",
    fks: { automationId: "Automation" },
    scope: (userId) => ({ automation: { userId } }),
  },
  UserSettings: { delegate: "userSettings", owner: "userId", fks: {}, scope: byUser },

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
    fks: { jobDescriptionVersionId: "JobDescriptionVersion" },
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
    fks: { materialItemId: "CareerMaterialItem" },
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
    fks: { applicationInterviewDetailId: "ApplicationInterviewDetail" },
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
  "Activity",
  "Question",
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
  "ApplicationAttempt",
  "ApplicationProcessStep",
  "ApplicationInterviewDetail",
  "ApplicationInterviewReflectionItem",
  "ApplicationAssessmentDetail",
  "ApplicationOfferDetail",
  "LegacyMigrationMap",
];

export const DELETE_ORDER: BackupModel[] = [...INSERT_ORDER].reverse();

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
  { model: "JobOpportunity", field: "currentJdVersionId", target: "JobDescriptionVersion" },
  { model: "JobDescriptionVersion", field: "currentParseId", target: "JobDescriptionParse" },
  { model: "ResumeVariant", field: "currentVersionId", target: "ResumeVariantVersion" },
  { model: "ResumeVariantVersion", field: "parentVersionId", target: "ResumeVariantVersion" },
  { model: "ResumeVariantVersion", field: "sourceMatchAnalysisId", target: "MatchAnalysis" },
  { model: "ApplicationAttempt", field: "transferredFromAttemptId", target: "ApplicationAttempt" },
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
  "Activity",
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
];

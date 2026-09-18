import { z } from "zod";

export const BACKUP_FORMAT_VERSION = 2;
export const SUPPORTED_BACKUP_FORMAT_VERSIONS = [1, 2] as const;
export type SupportedBackupFormatVersion =
  (typeof SUPPORTED_BACKUP_FORMAT_VERSIONS)[number];

export const ManifestSchema = z.object({
  formatVersion: z.union([z.literal(1), z.literal(2)]),
  appVersion: z.string(),
  appName: z.string().optional(),
  exportedAt: z.string(),
  sourceEmail: z.string(),
  counts: z.record(z.string(), z.number()),
});

export type BackupManifest = z.infer<typeof ManifestSchema>;

const id = z.string().min(1);
const optId = z.string().min(1).nullable();
const str = z.string();
const optStr = z.string().nullable();
const dt = z.coerce.date();
const optDt = z.coerce.date().nullable();
const int = z.number().int();
const optInt = z.number().int().nullable();

// The watchlist columns are optional, not just nullable: a backup taken before
// they existed has no such key, and undefined leaves Prisma on the default.
const Company = z.object({
  id,
  label: str,
  value: str,
  logoUrl: optStr,
  watched: z.boolean().optional(),
  watchedAt: optDt.optional(),
  atsProvider: optStr.optional(),
  atsToken: optStr.optional(),
  atsHost: optStr.optional(),
  websiteUrl: optStr.optional(),
  careersUrl: optStr.optional(),
  industry: optStr.optional(),
  notes: optStr.optional(),
  sizeLabel: optStr.optional(),
  headquarters: optStr.optional(),
});
const JobTitle = z.object({ id, label: str, value: str });
const Location = z.object({
  id,
  label: str,
  value: str,
  stateProv: optStr,
  country: optStr,
});
const JobSource = z.object({ id, label: str, value: str });
const Tag = z.object({ id, label: str, value: str });
const ActivityType = z.object({
  id,
  label: str,
  value: str,
  description: optStr,
  createdAt: dt,
  updatedAt: dt,
});

const Profile = z.object({ id });

// fileMissing marks a row whose bytes were absent on disk at export time.
const File = z.object({
  id,
  fileName: str,
  filePath: str,
  fileType: str,
  uploadedAt: dt,
  fileMissing: z.boolean().optional(),
});

const Resume = z.object({
  id,
  profileId: id,
  title: str,
  createdAt: dt,
  updatedAt: dt,
  FileId: optId,
  reviewData: optStr,
});

const ContactInfo = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  resumeId: id,
  firstName: str,
  lastName: str,
  headline: str,
  email: str,
  phone: str,
  address: optStr,
  url1: optStr,
  url1Label: optStr,
  url2: optStr,
  url2Label: optStr,
});

const Summary = z.object({ id, createdAt: dt, updatedAt: dt, content: str });

const ResumeSection = z.object({
  id,
  resumeId: id,
  sectionTitle: str,
  sectionType: str,
  summaryId: optId,
});

const WorkExperience = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  companyId: id,
  jobTitleId: id,
  startDate: dt,
  endDate: optDt,
  description: str,
  locationId: id,
  resumeSectionId: optId,
});

const Education = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  institution: str,
  degree: str,
  fieldOfStudy: str,
  startDate: dt,
  endDate: optDt,
  description: optStr,
  locationId: id,
  resumeSectionId: optId,
});

const LicenseOrCertification = z.object({
  id,
  title: str,
  organization: str,
  issueDate: optDt,
  expirationDate: optDt,
  credentialUrl: optStr,
  resumeSectionId: optId,
});

const OtherSection = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  title: str,
  content: str,
  resumeSectionId: optId,
});

const Skill = z.object({
  id,
  createdAt: dt,
  updatedAt: dt,
  category: optStr,
  order: int,
  tagId: id,
  resumeSectionId: id,
});

const CoverLetter = z.object({
  id,
  profileId: id,
  title: str,
  content: str,
  createdAt: dt,
  updatedAt: dt,
});

const Automation = z.object({
  id,
  name: str,
  jobBoard: str,
  keywords: str,
  location: str,
  sourceConfig: optStr,
  resumeId: id,
  matchThreshold: int,
  scheduleHour: int,
  nextRunAt: optDt,
  lastRunAt: optDt,
  status: str,
  createdAt: dt,
  updatedAt: dt,
});

const Job = z.object({
  id,
  jobUrl: optStr,
  description: str,
  jobType: str,
  workplaceType: optStr,
  createdAt: dt,
  applied: z.boolean(),
  appliedDate: optDt,
  dueDate: optDt,
  // The instance-local statusId is replaced by the stable natural key.
  statusValue: str,
  jobTitleId: id,
  companyId: id,
  jobSourceId: optId,
  salaryRange: optStr,
  locationId: optId,
  resumeId: optId,
  coverLetterId: optId,
  automationId: optId,
  matchScore: optInt,
  matchData: optStr,
  discoveryStatus: optStr,
  discoveredAt: optDt,
  createdVia: optStr,
  descriptionCompleteness: optStr,
});

const Note = z.object({
  id,
  jobId: id,
  content: str,
  createdAt: dt,
  updatedAt: dt,
});

const Interview = z.object({ id, createdAt: dt, jobId: id });

// Everything past `interviewId` is `.optional()` as well as nullable: a backup
// taken before the contacts feature has no such key, and undefined leaves
// Prisma on the column default.
const Contact = z.object({
  id,
  name: str,
  email: optStr,
  createdAt: dt,
  interviewId: optId,
  title: optStr.optional(),
  phone: optStr.optional(),
  linkedinUrl: optStr.optional(),
  companyId: optId.optional(),
  locationId: optId.optional(),
  relationship: optStr.optional(),
  workedAtCompanyId: optId.optional(),
  workedFrom: optDt.optional(),
  workedTo: optDt.optional(),
  roleId: optId.optional(),
  notes: optStr.optional(),
  lastContactedAt: optDt.optional(),
  updatedAt: dt.optional(),
});

const ContactRole = z.object({ id, label: str, value: str });

const JobContact = z.object({
  id,
  jobId: id,
  contactId: id,
  roleId: id,
  createdAt: dt,
});

const Task = z.object({
  id,
  title: str,
  description: optStr,
  status: str,
  priority: int,
  percentComplete: int,
  dueDate: optDt,
  activityTypeId: optId,
  createdAt: dt,
  updatedAt: dt,
});

const Activity = z.object({
  id,
  activityName: str,
  startTime: dt,
  endTime: optDt,
  duration: optInt,
  breakMinutes: int,
  breakStartedAt: optDt,
  breakPlannedMins: optInt,
  description: optStr,
  createdAt: dt,
  updatedAt: dt,
  activityTypeId: id,
  taskId: optId,
});

const Question = z.object({
  id,
  question: str,
  answer: optStr,
  createdAt: dt,
  updatedAt: dt,
  createdVia: optStr,
});

const AutomationRun = z.object({
  id,
  automationId: id,
  jobsSearched: int,
  jobsDeduplicated: int,
  jobsProcessed: int,
  jobsMatched: int,
  jobsSaved: int,
  status: str,
  errorMessage: optStr,
  blockedReason: optStr,
  funnelStats: optStr,
  startedAt: dt,
  completedAt: optDt,
});

const UserSettings = z.object({
  id,
  settings: str,
  createdAt: dt,
  updatedAt: dt,
});

const RecruitmentCampaign = z.object({
  id,
  companyId: id,
  name: str,
  recruitmentType: optStr,
  year: optInt,
  season: optStr,
  startDate: optDt,
  endDate: optDt,
  careersUrl: optStr,
  status: str,
  notes: optStr,
  archivedAt: optDt,
  createdAt: dt,
  updatedAt: dt,
});

const JobOpportunity = z.object({
  id,
  companyId: id,
  campaignId: optId,
  title: str,
  normalizedTitle: optStr,
  locationText: optStr,
  employmentType: optStr,
  recruitmentType: optStr,
  workplaceType: optStr,
  sourceSystem: optStr,
  sourceLabel: optStr,
  sourceUrl: optStr,
  externalSourceKey: optStr,
  deadline: optDt,
  recruitmentCohort: optStr.optional(),
  recruitmentBatch: optStr.optional(),
  salaryText: optStr,
  status: str,
  currentJdVersionId: optId,
  sourceAutomationId: optId,
  discoveredAt: optDt,
  closedAt: optDt,
  notes: optStr,
  archivedAt: optDt,
  createdVia: optStr,
  createdAt: dt,
  updatedAt: dt,
});

const JobOpportunityNote = z.object({
  id,
  jobOpportunityId: id,
  content: str,
  createdAt: dt,
  updatedAt: dt,
});

const JobDescriptionVersion = z.object({
  id,
  jobOpportunityId: id,
  versionNumber: int,
  rawContent: str,
  rawContentFormat: str,
  sourceUrl: optStr,
  capturedAt: dt,
  contentHash: str,
  currentParseId: optId,
  createdVia: optStr,
  createdAt: dt,
});

const JobDescriptionParse = z.object({
  id,
  jobDescriptionVersionId: id,
  schemaVersion: str,
  parserVersion: str,
  structuredData: str,
  parseStatus: str,
  provider: optStr,
  model: optStr,
  promptVersion: optStr,
  inputHash: str,
  errorCode: optStr,
  parsedAt: optDt,
  createdAt: dt,
});

const ApplicationAttempt = z.object({
  id,
  jobOpportunityId: id,
  channelCategory: optStr,
  channelLabel: str,
  sourceUrl: optStr,
  submittedAt: optDt,
  currentStageCategory: str,
  outcome: str,
  transferredFromAttemptId: optId.optional(),
  submittedResumeVersionId: optId,
  submittedResumeArtifactId: optId,
  submittedAgainstJdVersionId: optId,
  notes: optStr,
  createdVia: optStr,
  archivedAt: optDt,
  createdAt: dt,
  updatedAt: dt,
});

const ApplicationProcessStep = z.object({
  id,
  applicationAttemptId: id,
  category: str,
  label: str,
  status: str,
  sortOrder: int,
  scheduledAt: optDt,
  deadlineAt: optDt.optional(),
  completedAt: optDt,
  result: optStr,
  source: str,
  notes: optStr,
  createdAt: dt,
  updatedAt: dt,
});

const ApplicationInterviewDetail = z.object({
  id,
  applicationProcessStepId: id,
  interviewFormat: optStr,
  roundLabel: optStr,
  locationText: optStr,
  interviewerNames: optStr,
  durationMinutes: optInt,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const ApplicationAssessmentDetail = z.object({
  id,
  applicationProcessStepId: id,
  assessmentKind: optStr,
  platform: optStr,
  durationMinutes: optInt,
  scoreText: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const ApplicationOfferDetail = z.object({
  id,
  applicationProcessStepId: id,
  offerType: optStr,
  compensationText: optStr,
  responseDeadline: optDt,
  decision: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const JobSearchPreference = z.object({
  id,
  targetRoles: optStr,
  preferredCities: optStr,
  preferredIndustries: optStr,
  recruitmentTypes: optStr,
  availability: optStr,
  hardConstraints: optStr,
  softPreferences: optStr,
  createdAt: dt,
  updatedAt: dt,
});

const CareerMaterialItem = z.object({
  id,
  type: str,
  title: str,
  startDate: optDt,
  endDate: optDt,
  isCurrent: z.boolean(),
  notes: optStr,
  origin: str,
  verificationStatus: str,
  archivedAt: optDt,
  createdAt: dt,
  updatedAt: dt,
});

const CareerInternshipDetail = z.object({
  id,
  materialItemId: id,
  companyId: optId,
  organizationName: optStr,
  roleTitle: optStr,
  locationText: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerEmploymentDetail = z.object({
  id,
  materialItemId: id,
  companyId: optId,
  organizationName: optStr,
  roleTitle: optStr,
  employmentType: optStr,
  locationText: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerProjectDetail = z.object({
  id,
  materialItemId: id,
  roleTitle: optStr,
  projectUrl: optStr,
  organizationName: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerResearchDetail = z.object({
  id,
  materialItemId: id,
  institution: optStr,
  roleTitle: optStr,
  field: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerPublicationDetail = z.object({
  id,
  materialItemId: id,
  venue: optStr,
  authors: optStr,
  url: optStr,
  publishedAt: optDt,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerCompetitionDetail = z.object({
  id,
  materialItemId: id,
  organizer: optStr,
  awardLevel: optStr,
  result: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerCampusActivityDetail = z.object({
  id,
  materialItemId: id,
  organizationName: optStr,
  roleTitle: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerEducationDetail = z.object({
  id,
  materialItemId: id,
  institution: optStr,
  degree: optStr,
  fieldOfStudy: optStr,
  locationText: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerAwardDetail = z.object({
  id,
  materialItemId: id,
  issuer: optStr,
  awardedAt: optDt,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerSkillDetail = z.object({
  id,
  materialItemId: id,
  skillName: optStr,
  proficiency: optStr,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerCertificationDetail = z.object({
  id,
  materialItemId: id,
  organization: optStr,
  credentialUrl: optStr,
  issueDate: optDt,
  expirationDate: optDt,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerCustomDetail = z.object({
  id,
  materialItemId: id,
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerEvidence = z.object({
  id,
  materialItemId: id,
  kind: str,
  content: str,
  metricValue: z.number().nullable(),
  metricUnit: optStr,
  metricText: optStr,
  sortOrder: int,
  origin: str,
  verificationStatus: str,
  archivedAt: optDt,
  createdAt: dt,
  updatedAt: dt,
});

const ResumeContactProfile = z.object({
  id,
  fullName: optStr,
  headline: optStr,
  email: optStr,
  phone: optStr,
  address: optStr,
  linksData: optStr,
  extraData: optStr,
  createdAt: dt,
  updatedAt: dt,
});

const ResumeVariant = z.object({
  id,
  name: str,
  targetJobOpportunityId: optId,
  currentVersionId: optId,
  archivedAt: optDt,
  createdAt: dt,
  updatedAt: dt,
});

const ResumeVariantVersion = z.object({
  id,
  resumeVariantId: id,
  versionNumber: int,
  parentVersionId: optId,
  status: str,
  targetJdVersionId: optId,
  sourceMatchAnalysisId: optId,
  locale: optStr,
  headerSnapshot: optStr,
  layoutConfig: optStr,
  createdVia: str,
  createdAt: dt,
  frozenAt: optDt,
});

const ResumeVariantSection = z.object({
  id,
  resumeVariantVersionId: id,
  title: str,
  systemKind: optStr,
  sortOrder: int,
});

const ResumeVariantSectionItem = z.object({
  id,
  resumeVariantSectionId: id,
  careerMaterialItemId: optId,
  itemKind: str,
  sortOrder: int,
});

const ResumeExpression = z.object({
  id,
  resumeVariantSectionItemId: id,
  kind: str,
  content: str,
  sortOrder: int,
  evidenceStatus: str,
  createdAt: dt,
  updatedAt: dt,
});

const ResumeExpressionEvidence = z.object({
  id,
  resumeExpressionId: id,
  careerEvidenceId: id,
  evidenceContentSnapshot: str,
  evidenceHashSnapshot: str,
  evidenceUpdatedAtSnapshot: dt,
  createdAt: dt,
});

// bytesMissing marks that artifact bytes are not in the zip. storageKey is a
// logical key; restore rebuilds it and never persists a source-machine path.
const ResumeArtifact = z.object({
  id,
  resumeVariantVersionId: id,
  kind: str,
  format: str,
  storageKey: str,
  fileName: str,
  sha256: str,
  byteSize: optInt,
  createdAt: dt,
  bytesMissing: z.boolean().optional(),
});

const MatchAnalysis = z.object({
  id,
  jobOpportunityId: id,
  jobDescriptionParseId: id,
  analysisType: str,
  resumeVariantVersionId: optId,
  inputHash: str,
  analysisSchemaVersion: str,
  provider: optStr,
  model: optStr,
  promptVersion: optStr,
  status: str,
  errorCode: optStr,
  isStale: z.boolean(),
  staleReasonCodes: optStr,
  staleAt: optDt,
  createdAt: dt,
  completedAt: optDt,
});

const FastScreeningDetail = z.object({
  id,
  matchAnalysisId: id,
  verdict: str,
  inputSnapshot: str,
  hardRequirements: optStr,
  coreMatch: optStr,
  preferenceMatch: optStr,
  reasons: optStr,
  createdAt: dt,
});

const DeepMatchDetail = z.object({
  id,
  matchAnalysisId: id,
  overallSummary: str,
  overallScore: optInt,
  hardRequirements: optStr,
  responsibilityAlignment: optStr,
  experienceRelevance: optStr,
  skillCoverage: optStr,
  educationExperienceFit: optStr,
  strengths: optStr,
  gaps: optStr,
  resumeOptimizationOpportunities: optStr,
  nonFixableGaps: optStr,
  createdAt: dt,
});

const MatchEvidenceLink = z.object({
  id,
  matchAnalysisId: id,
  requirementKey: str,
  requirementTextSnapshot: str,
  careerEvidenceId: optId,
  resumeExpressionId: optId,
  judgement: str,
  evidenceContentSnapshot: optStr,
  evidenceHashSnapshot: optStr,
  createdAt: dt,
});

const LegacyMigrationMap = z.object({
  id,
  legacyEntityType: str,
  legacyEntityId: str,
  targetEntityType: str,
  targetEntityId: str,
  migrationVersion: str,
  mappingReason: optStr,
  createdAt: dt,
});

const AbMigrationState = z.object({
  id,
  scopeKey: str,
  migrationKey: str,
  status: str,
  completedAt: optDt,
  verifiedAt: optDt,
  errorCode: optStr,
  createdAt: dt,
  updatedAt: dt,
});

const group = <T extends z.ZodTypeAny>(schema: T) =>
  z.array(schema).default([]);

export const BackupDataSchema = z.object({
  Company: group(Company),
  JobTitle: group(JobTitle),
  Location: group(Location),
  JobSource: group(JobSource),
  Tag: group(Tag),
  ActivityType: group(ActivityType),
  ContactRole: group(ContactRole),
  Profile: group(Profile),
  File: group(File),
  Resume: group(Resume),
  ContactInfo: group(ContactInfo),
  Summary: group(Summary),
  ResumeSection: group(ResumeSection),
  WorkExperience: group(WorkExperience),
  Education: group(Education),
  LicenseOrCertification: group(LicenseOrCertification),
  OtherSection: group(OtherSection),
  Skill: group(Skill),
  CoverLetter: group(CoverLetter),
  Automation: group(Automation),
  Job: group(Job),
  Note: group(Note),
  Interview: group(Interview),
  Contact: group(Contact),
  JobContact: group(JobContact),
  Task: group(Task),
  Activity: group(Activity),
  Question: group(Question),
  AutomationRun: group(AutomationRun),
  UserSettings: group(UserSettings),
  AbMigrationState: group(AbMigrationState),
  JobSearchPreference: group(JobSearchPreference),
  RecruitmentCampaign: group(RecruitmentCampaign),
  JobOpportunity: group(JobOpportunity),
  JobDescriptionVersion: group(JobDescriptionVersion),
  JobDescriptionParse: group(JobDescriptionParse),
  JobOpportunityNote: group(JobOpportunityNote),
  CareerMaterialItem: group(CareerMaterialItem),
  CareerInternshipDetail: group(CareerInternshipDetail),
  CareerEmploymentDetail: group(CareerEmploymentDetail),
  CareerProjectDetail: group(CareerProjectDetail),
  CareerResearchDetail: group(CareerResearchDetail),
  CareerPublicationDetail: group(CareerPublicationDetail),
  CareerCompetitionDetail: group(CareerCompetitionDetail),
  CareerCampusActivityDetail: group(CareerCampusActivityDetail),
  CareerEducationDetail: group(CareerEducationDetail),
  CareerAwardDetail: group(CareerAwardDetail),
  CareerSkillDetail: group(CareerSkillDetail),
  CareerCertificationDetail: group(CareerCertificationDetail),
  CareerCustomDetail: group(CareerCustomDetail),
  CareerEvidence: group(CareerEvidence),
  ResumeContactProfile: group(ResumeContactProfile),
  ResumeVariant: group(ResumeVariant),
  ResumeVariantVersion: group(ResumeVariantVersion),
  ResumeVariantSection: group(ResumeVariantSection),
  ResumeVariantSectionItem: group(ResumeVariantSectionItem),
  ResumeExpression: group(ResumeExpression),
  ResumeExpressionEvidence: group(ResumeExpressionEvidence),
  ResumeArtifact: group(ResumeArtifact),
  MatchAnalysis: group(MatchAnalysis),
  FastScreeningDetail: group(FastScreeningDetail),
  DeepMatchDetail: group(DeepMatchDetail),
  MatchEvidenceLink: group(MatchEvidenceLink),
  ApplicationAttempt: group(ApplicationAttempt),
  ApplicationProcessStep: group(ApplicationProcessStep),
  ApplicationInterviewDetail: group(ApplicationInterviewDetail),
  ApplicationAssessmentDetail: group(ApplicationAssessmentDetail),
  ApplicationOfferDetail: group(ApplicationOfferDetail),
  LegacyMigrationMap: group(LegacyMigrationMap),

  // Implicit Prisma m2m relations are not models, so they travel as id pairs.
  _JobToTag: group(z.object({ jobId: id, tagId: id })),
  _QuestionToTag: group(z.object({ questionId: id, tagId: id })),

  // Natural keys for the only global table in the schema.
  jobStatuses: group(z.object({ label: str, value: str })),

  // The only User field that travels; applied after Resume rows exist.
  user: z
    .object({ defaultResumeId: optId })
    .default({ defaultResumeId: null }),
});

export type BackupData = z.infer<typeof BackupDataSchema>;
export type BackupRow = Record<string, unknown>;

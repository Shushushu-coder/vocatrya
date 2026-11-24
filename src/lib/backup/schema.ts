import { parseDateOnly } from "@/lib/datetime";
import { assertManagedConnectionMetadataSafe } from "@/lib/ai/connections";
import { managedAiProvenanceStringSchema as managedAiProvenance } from "@/lib/ai/managed-provenance";
import { z } from "zod";

// Carries a message safe to hand straight back to the user. Anything else
// thrown out of the backup module is an internal error and gets a generic 500.
export class BackupError extends Error {
  constructor(public userMessage: string) {
    super(userMessage);
    this.name = "BackupError";
  }
}

export const BACKUP_FORMAT_VERSION = 12;
export const SUPPORTED_BACKUP_FORMAT_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;
export type SupportedBackupFormatVersion =
  (typeof SUPPORTED_BACKUP_FORMAT_VERSIONS)[number];

export const ManifestSchema = z.object({
  // Literal union on purpose: a v5-era binary parses the same key with
  // literals 1-5, so a v6 file fails there instead of degrading silently.
  formatVersion: z.union([
    z.literal(1),
    z.literal(2),
    z.literal(3),
    z.literal(4),
    z.literal(5),
    z.literal(6),
    z.literal(7),
    z.literal(8),
    z.literal(9),
    z.literal(10),
    z.literal(11),
    z.literal(12),
  ]),
  appVersion: z.string(),
  appName: z.string().optional(),
  exportedAt: z.string(),
  sourceEmail: z.string(),
  counts: z.record(z.string(), z.number()),
  containsSensitiveData: z.boolean().optional(),
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
  // UI-RC-JOB-ORDER: optional so backups written before the ordering columns
  // still import; undefined restores as NULL (unpositioned, unpinned).
  sortOrder: optInt.optional(),
  pinnedAt: optDt.optional(),
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
  // DateTime V1 sidecar columns (format 4). Optional as well as nullable: a
  // pre-v4 backup has no such keys, and undefined leaves Prisma on the column
  // default (NULL = unknown precision). DateOnly stays a plain string — never
  // z.coerce.date(), which would silently turn YYYY-MM-DD into an instant.
  dueOn: optStr.optional(),
  duePrecision: optStr.optional(),
  activityTypeId: optId,
  createdAt: dt,
  updatedAt: dt,
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
  // Phase B lock fields: optional as well as nullable — a backup taken
  // before they existed carries no such key.
  managedAiProvenance: managedAiProvenance.optional(),
  resolvedConnectionId: optId.optional(),
  resolvedModel: optStr.optional(),
});

// Phase B account-login foundation. userId is the owner column: stripped on
// export, injected on restore — same as every other owned model. Credentials
// never travel; on import a CONNECTED ACCOUNT_LOGIN row is normalized to
// REAUTH_REQUIRED (see normalizeAIConnection).
const AIConnection = z
  .object({
    id,
    provider: str,
    authType: str,
    backendKind: str,
    displayName: str,
    accountIdentity: optStr,
    status: str,
    credentialRef: optStr,
    runtimeProfileRef: optStr,
    providerMetadata: optStr,
    lastVerifiedAt: optDt,
    archivedAt: optDt,
    createdAt: dt,
    updatedAt: dt,
  })
  .superRefine((row, ctx) => {
    try {
      assertManagedConnectionMetadataSafe(row);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Invalid or secret-bearing Managed connection metadata",
      });
    }
  });

const AIBusinessAssignment = z.object({
  id,
  purpose: str,
  connectionId: id,
  model: str,
  createdAt: dt,
  updatedAt: dt,
});

// The lock columns are optional as well as nullable: backups taken before
// the lock migration have no such keys, and undefined leaves Prisma on the
// column default (null — the historical-conversation semantics).
const ChatConversation = z.object({
  revision: z.number().int().nonnegative().optional(),
  activeRequestId: z.string().nullable().optional(),
  activeRequestExpiresAt: dt.nullable().optional(),
  id,
  messages: str,
  // Optional so backups taken before multi-conversation still parse.
  // Undefined leaves Prisma on the column default (null).
  title: optStr.optional(),
  context: optStr.optional(),
  managedAiProvenance: managedAiProvenance.optional(),
  resolvedConnectionId: optId.optional(),
  resolvedModel: optStr.optional(),
  // Optional: backups taken before multi-agent roles have no such key,
  // and undefined restores as NULL (the general assistant, slotted under
  // Pilot). insight/pilot/reflect round-trip unchanged.
  agentRole: optStr.optional(),
  // Optional: backups taken before conversation archive have no such key,
  // and undefined restores as NULL (unarchived).
  archivedAt: optDt.optional(),
  // Optional: backups taken before agent long tasks have no such key, and
  // undefined restores as NULL (ordinary chat). Patched after AgentTask exists.
  agentTaskId: optId.optional(),
  createdAt: dt,
  updatedAt: dt,
});

// Durable operation proposals — user state. Runtime links (harnessTaskId)
// are cleared on import; dispatch evidence and outcomes travel.
const AgentOperationProposal = z.object({
  id,
  conversationId: optId,
  messageId: optId.optional(),
  toolCallId: str,
  approvalId: str,
  turnKey: str,
  toolName: str,
  inputJson: str,
  inputHash: str,
  materialJson: optStr.optional(),
  status: str,
  revision: optInt.optional(),
  decidedAt: optDt.optional(),
  decisionReason: optStr.optional(),
  expiresAt: dt,
  harnessTaskId: optId.optional(),
  dispatchKey: optStr.optional(),
  dispatchedAt: optDt.optional(),
  outcomeStatus: optStr.optional(),
  outcomeJson: optStr.optional(),
  manualResolution: optStr.optional(),
  resolvedAt: optDt.optional(),
  supersedesId: optId.optional(),
  createdAt: dt,
  updatedAt: dt,
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
  // DateTime V1 sidecar columns (format 4): DateOnly carrier plus its
  // precision. Optional for pre-v4 backups — undefined restores as NULL.
  deadlineOn: optStr.optional(),
  deadlinePrecision: optStr.optional(),
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
  // UI-RC-JOB-ORDER: same optional-evolution contract as Job.sortOrder.
  sortOrder: optInt.optional(),
  pinnedAt: optDt.optional(),
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
  managedAiProvenance: managedAiProvenance.optional(),
  resolvedConnectionId: optId.optional(),
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
  // DateTime V1 sidecar columns (format 4). Optional for pre-v4 backups —
  // undefined restores as NULL. A contradictory row (both an instant carrier
  // and its *On populated) is preserved verbatim for audit, never repaired.
  scheduledAtPrecision: optStr.optional(),
  scheduledAtZone: optStr.optional(),
  deadlineOn: optStr.optional(),
  deadlinePrecision: optStr.optional(),
  deadlineZone: optStr.optional(),
  completedAtPrecision: optStr.optional(),
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
  reflectionText: optStr.optional(),
  // Optional on purpose: pre-v8 backups have no such key. Absent restores to
  // NULL — the "never marked" state — matching the in-place migration.
  reflectionCompletedAt: optDt.optional(),
  createdAt: dt,
  updatedAt: dt,
});

const ApplicationInterviewReflectionItem = z.object({
  id,
  applicationInterviewDetailId: id,
  questionText: str,
  answerNotes: optStr,
  // Optional+nullable for the same pre-v8 compat reason. A non-null value is
  // remapped through the Question id map at restore.
  sourceQuestionId: optId.optional(),
  sourceKind: optStr.optional(),
  sortOrder: int,
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
  department: optStr.optional(),
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
  projectType: optStr.optional(),
  techStack: optStr.optional(),
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
  venueLevel: optStr.optional(),
  authorRole: optStr.optional(),
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
  gpaValue: z.number().nullable().optional(),
  gpaScale: z.number().nullable().optional(),
  rankText: optStr.optional(),
  currentStudyLocation: optStr.optional(),
  department: optStr.optional(),
  majorCategory: optStr.optional(),
  studyMode: optStr.optional(),
  isExchange: z.boolean().optional(),
  graduationOn: optStr.optional(),
  graduationExpected: z.boolean().optional(),
  rankClassText: optStr.optional(),
  rankMajorText: optStr.optional(),
  hasNationalScholarship: z.boolean().optional(),
  advisorName: optStr.optional(),
  labName: optStr.optional(),
  researchDirection: optStr.optional(),
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerAwardDetail = z.object({
  id,
  materialItemId: id,
  issuer: optStr,
  awardedAt: optDt,
  awardType: optStr.optional(),
  awardLevel: optStr.optional(),
  awardScope: optStr.optional(),
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerSkillDetail = z.object({
  id,
  materialItemId: id,
  skillName: optStr,
  proficiency: optStr,
  // Format-6 skill↔Tag link. Optional as well as nullable: a v1-v5 backup
  // has no such key, and undefined restores as NULL (no name matching, ever).
  tagId: optId.optional(),
  structuredData: str,
  createdAt: dt,
  updatedAt: dt,
});

const CareerCertificationDetail = z.object({
  id,
  materialItemId: id,
  organization: optStr,
  credentialUrl: optStr,
  credentialId: optStr.optional(),
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

const CareerLanguageDetail = z.object({
  id,
  materialItemId: id,
  language: optStr,
  examOrLevel: optStr,
  score: optStr,
  obtainedOn: optStr,
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

const CandidateProfile = z.object({
  id,
  fullName: optStr,
  headline: optStr,
  email: optStr,
  phone: optStr,
  address: optStr,
  linksData: optStr,
  extraData: optStr,
  gender: optStr.optional(),
  birthDate: optStr.optional(),
  ethnicity: optStr.optional(),
  politicalStatus: optStr.optional(),
  nativePlace: optStr.optional(),
  householdRegistration: optStr.optional(),
  graduationCohort: optStr.optional(),
  countryOrRegion: optStr.optional(),
  wechatId: optStr.optional(),
  qqNumber: optStr.optional(),
  currentCity: optStr.optional(),
  homeCity: optStr.optional(),
  homeAddress: optStr.optional(),
  phoneCountryCode: optStr.optional(),
  createdAt: dt,
  updatedAt: dt,
});

const CandidateSensitiveInfo = z.object({
  id,
  idType: optStr.optional(),
  idNumber: optStr,
  emergencyContactName: optStr,
  emergencyContactRelation: optStr,
  emergencyContactPhone: optStr,
  createdAt: dt,
  updatedAt: dt,
});

const CandidateFamilyMember = z.object({
  id,
  sensitiveInfoId: id,
  name: optStr,
  relation: optStr,
  employer: optStr,
  position: optStr,
  phone: optStr,
  sortOrder: int,
  createdAt: dt,
  updatedAt: dt,
});

const CandidateReferee = z.object({
  id,
  sensitiveInfoId: id,
  name: optStr,
  organization: optStr,
  position: optStr,
  relationship: optStr,
  phone: optStr,
  email: optStr,
  note: optStr,
  sortOrder: int,
  archivedAt: optDt,
  createdAt: dt,
  updatedAt: dt,
});

// bytesMissing marks that attachment bytes are not in the zip. storageKey is a
// logical key; restore rebuilds it and never persists a source-machine path.
const CandidateAttachment = z.object({
  id,
  materialItemId: optId,
  category: str,
  fileName: str,
  mimeType: str,
  sizeBytes: optInt,
  storageKey: str,
  origin: str,
  archivedAt: optDt,
  createdAt: dt,
  updatedAt: dt,
  bytesMissing: z.boolean().optional(),
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
  managedAiProvenance: managedAiProvenance.optional(),
  resolvedConnectionId: optId.optional(),
  resolvedModel: optStr.optional(),
});

const ResumeVariantSection = z.object({
  hiddenAt: optDt.optional(),
  originRefId: optStr.optional(),
  id,
  resumeVariantVersionId: id,
  title: str,
  systemKind: optStr,
  sortOrder: int,
});

const ResumeVariantSectionItem = z.object({
  hiddenAt: optDt.optional(),
  originRefId: optStr.optional(),
  id,
  resumeVariantSectionId: id,
  careerMaterialItemId: optId,
  materialTitleSnapshot: optStr.optional().default(null),
  itemKind: str,
  sortOrder: int,
});

const ResumeExpression = z.object({
  hiddenAt: optDt.optional(),
  originRefId: optStr.optional(),
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
  managedAiProvenance: managedAiProvenance.optional(),
  resolvedConnectionId: optId.optional(),
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

// Interview models are included in product backup starting from this change.
// Owner columns (InterviewSession.userId) are omitted like every other owned
// model: export strips them, restore injects the session user. The backup
// preserves ids, FK ids, snapshots, and provider/model provenance verbatim and
// never calls an AI provider on restore. Legacy backups without these groups
// still parse via the .default([]) groups below.
const QuestionBank = z.object({
  id,
  bankKey: str,
  version: str,
  title: str,
  locale: str,
  kind: str,
  createdAt: dt,
});

const QuestionBankItem = z.object({
  id,
  bankId: id,
  questionId: id,
  displayOrder: int,
  createdAt: dt,
});

const InterviewSession = z.object({
  id,
  status: str,
  coachingMode: str,
  feedbackReleasePolicy: str,
  feedbackReleasedAt: optDt,
  startedAt: optDt,
  completedAt: optDt,
  archivedAt: optDt,
  statusBeforeArchive: optStr,
  knowledgeBaseVersion: str,
  currentQuestionInstanceId: optId,
  jobOpportunityId: optId,
  jobDescriptionVersionId: optId,
  // Nullable goal binding — optional() keeps pre-v9 backups loadable.
  interviewPrepGoalId: optId.optional(),
  createdVia: optStr,
  createdAt: dt,
  updatedAt: dt,
  managedAiProvenance: managedAiProvenance.optional(),
  resolvedConnectionId: optId.optional(),
  resolvedModel: optStr.optional(),
});

const QuestionInstance = z.object({
  id,
  sessionId: id,
  sourceQuestionId: optId,
  displayOrder: int,
  displayedText: str,
  sourceKind: str,
  category: optStr,
  sourceMetadata: optStr,
  referenceAnswerSnapshot: optStr,
  status: str,
  createdAt: dt,
});

const AnswerAttempt = z.object({
  id,
  questionInstanceId: id,
  sessionId: id,
  attemptNumber: int,
  inputType: str,
  status: str,
  startedAt: optDt,
  submittedAt: optDt,
  completedAt: optDt,
  durationMs: optInt,
  activeRevisionId: optId,
  deletedAt: optDt,
  createdAt: dt,
});

const AnswerInputArtifact = z.object({
  id,
  answerAttemptId: id,
  sessionId: id,
  inputType: str,
  role: str,
  filePath: optStr,
  fileFormat: optStr,
  durationSeconds: z.number().nullable(),
  fileSizeBytes: optInt,
  textContent: optStr,
  createdAt: dt,
});

const Transcript = z.object({
  id,
  sessionId: id,
  answerAttemptId: id,
  sourceArtifactId: optId,
  fullText: str,
  segments: str,
  asrModel: optStr,
  asrStatus: optStr,
  errorMessage: optStr,
  createdAt: dt,
});

const TranscriptRevision = z.object({
  id,
  transcriptId: id,
  answerAttemptId: id,
  revisionNumber: int,
  revisionKind: str,
  fullText: str,
  segments: optStr,
  alignmentStatus: str,
  contentHash: str,
  createdByUserId: optId,
  createdVia: optStr,
  createdAt: dt,
});

const FeedbackGeneration = z.object({
  id,
  answerAttemptId: id,
  questionInstanceId: id,
  sessionId: id,
  versionNumber: int,
  isCurrent: z.boolean(),
  status: str,
  inputRevisionId: id,
  inputContentHash: str,
  model: optStr,
  provider: optStr,
  promptVersion: optStr,
  knowledgeBaseVersion: optStr,
  failureCode: optStr,
  failureMessage: optStr,
  createdAt: dt,
  completedAt: optDt,
});

const FeedbackItem = z.object({
  id,
  sessionId: id,
  transcriptId: id,
  generationId: id,
  itemOrder: int,
  problemLabel: str,
  evidence: str,
  explanation: str,
  suggestion: str,
  createdAt: dt,
});

const SessionSummaryGeneration = z.object({
  id,
  sessionId: id,
  versionNumber: int,
  status: str,
  isCurrent: z.boolean(),
  bodyText: optStr,
  structuredPayload: optStr,
  inputHash: str,
  model: optStr,
  provider: optStr,
  promptVersion: optStr,
  knowledgeBaseVersion: optStr,
  failureCode: optStr,
  failureMessage: optStr,
  createdAt: dt,
  completedAt: optDt,
});

const SessionSummaryInput = z.object({
  id,
  summaryGenerationId: id,
  sessionId: id,
  questionInstanceId: id,
  feedbackGenerationId: id,
  inputOrder: int,
  createdAt: dt,
});

const CoachingConversation = z.object({
  id,
  sessionId: id,
  status: str,
  createdAt: dt,
  closedAt: optDt,
});

const DialogueTurn = z.object({
  id,
  sessionId: id,
  conversationId: id,
  turnNumber: int,
  userText: str,
  entryMode: str,
  assistantReply: str,
  replyModel: optStr,
  replyPromptVersion: optStr,
  contextSnapshot: optStr,
  targetType: str,
  questionInstanceId: optId,
  answerAttemptId: optId,
  commercialFeedbackItemId: optId,
  summaryGenerationId: optId,
  createdAt: dt,
});

// User-owned interview prep goal (long-lived business state, backed up).
// handoffJson is a deterministic snapshot — restored verbatim with its
// embedded entity ids remapped; readers always recompute it from the bound
// business records, so a stale snapshot can never resurrect old state.
const InterviewPrepGoal = z.object({
  id,
  jobOpportunityId: id,
  pinnedJobDescriptionVersionId: id,
  pinnedJdContentHash: str,
  status: str,
  revision: int,
  requestKey: str,
  liveSlot: optStr,
  handoffJson: optStr,
  handoffGoalRevision: optInt,
  handoffVerifiedAt: optDt,
  pausedAt: optDt,
  completedAt: optDt,
  endedAt: optDt,
  createdAt: dt,
  updatedAt: dt,
});

// Agent long-task ledger (user career-fact + audit trail). The live session
// claim (activeSessionId/activeSessionClaimedAt) is runtime state: it travels
// verbatim but is cleared on import. acceptanceItems embeds evidence entity
// ids and is remapped; handoff state stays verbatim so its stateHash holds
// (orphaned pointers surface as grounding discrepancies).
const AgentTask = z.object({
  id,
  title: str,
  templateKey: str,
  jobOpportunityId: optId,
  interviewPrepGoalId: optId,
  milestone: str,
  status: str,
  acceptanceItems: str,
  revision: int,
  liveSlot: optStr,
  activeSessionId: optStr,
  activeSessionClaimedAt: optDt,
  blockedReason: optStr,
  blockedInputKey: optStr,
  createdAt: dt,
  updatedAt: dt,
  archivedAt: optDt,
});

const AgentTaskHandoff = z.object({
  id,
  taskId: id,
  revision: int,
  state: str,
  stateHash: str,
  sessionId: optId,
  generationMs: optInt,
  createdAt: dt,
});

const AgentTaskEvent = z.object({
  id,
  taskId: id,
  kind: str,
  payload: str,
  createdAt: dt,
});

// REM-V1 derived schedule records. targetId is polymorphic (sourceType
// selects the referenced table), so it is carried verbatim and remapped
// per sourceType at restore time.
const Reminder = z.object({
  id,
  sourceType: str,
  targetId: str,
  anchorAt: dt,
  fireAt: dt,
  title: str,
  body: str,
  deepLink: str,
  status: str,
  firedAt: optDt,
  createdAt: dt,
  updatedAt: dt,
});

// TODAY-PLAN per-conversation checklist. userId travels stripped like every
// owned model — the importer injects it from the session. Both models are
// absent from pre-feature backups; the group default keeps those files valid.
const TodayPlanItem = z.object({
  id,
  conversationId: id,
  taskId: id,
  plannedOn: str.refine(value => parseDateOnly(value) !== null, "Invalid plan date"),
  position: int,
  createdAt: dt,
  updatedAt: dt,
});

const TodayPlanOperation = z.object({
  id,
  conversationId: id,
  operationKey: str,
  kind: str,
  undoJson: optStr,
  resultJson: optStr,
  undoneAt: optDt,
  createdAt: dt,
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
  Question: group(Question),
  AIConnection: group(AIConnection),
  AIBusinessAssignment: group(AIBusinessAssignment),
  ChatConversation: group(ChatConversation),
  TodayPlanItem: group(TodayPlanItem),
  TodayPlanOperation: group(TodayPlanOperation),
  AgentOperationProposal: group(AgentOperationProposal),
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
  CareerLanguageDetail: group(CareerLanguageDetail),
  CareerEvidence: group(CareerEvidence),
  CandidateProfile: group(CandidateProfile),
  CandidateSensitiveInfo: group(CandidateSensitiveInfo),
  CandidateFamilyMember: group(CandidateFamilyMember),
  CandidateReferee: group(CandidateReferee),
  CandidateAttachment: group(CandidateAttachment),
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
  ApplicationInterviewReflectionItem: group(ApplicationInterviewReflectionItem),
  ApplicationAssessmentDetail: group(ApplicationAssessmentDetail),
  ApplicationOfferDetail: group(ApplicationOfferDetail),
  LegacyMigrationMap: group(LegacyMigrationMap),
  QuestionBank: group(QuestionBank),
  QuestionBankItem: group(QuestionBankItem),
  InterviewPrepGoal: group(InterviewPrepGoal),
  AgentTask: group(AgentTask),
  AgentTaskHandoff: group(AgentTaskHandoff),
  AgentTaskEvent: group(AgentTaskEvent),
  InterviewSession: group(InterviewSession),
  QuestionInstance: group(QuestionInstance),
  AnswerAttempt: group(AnswerAttempt),
  AnswerInputArtifact: group(AnswerInputArtifact),
  Transcript: group(Transcript),
  TranscriptRevision: group(TranscriptRevision),
  FeedbackGeneration: group(FeedbackGeneration),
  FeedbackItem: group(FeedbackItem),
  SessionSummaryGeneration: group(SessionSummaryGeneration),
  SessionSummaryInput: group(SessionSummaryInput),
  CoachingConversation: group(CoachingConversation),
  DialogueTurn: group(DialogueTurn),
  Reminder: group(Reminder),

  // Implicit Prisma m2m relations are not models, so they travel as id pairs.
  _JobToTag: group(z.object({ jobId: id, tagId: id })),
  _QuestionToTag: group(z.object({ questionId: id, tagId: id })),

  // Natural keys for the only global table in the schema.
  jobStatuses: group(z.object({ label: str, value: str })),

  // The only User field that travels; applied after Resume rows exist.
  user: z.object({ defaultResumeId: optId }).default({ defaultResumeId: null }),
});

export type BackupData = z.infer<typeof BackupDataSchema>;
export type BackupRow = Record<string, unknown>;

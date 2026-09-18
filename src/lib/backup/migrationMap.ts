import {
  canonicalTargetEntityType,
  LEGACY,
  TARGET,
} from "@/lib/legacy-migration/identities";
import type { IdMap } from "./idmap";
import type { BackupModel } from "./ordering";

const LEGACY_ID_MODELS: Record<string, BackupModel> = {
  [LEGACY.JOB]: "Job",
  [LEGACY.NOTE]: "Note",
  [LEGACY.RESUME]: "Resume",
  [LEGACY.WORK_EXPERIENCE]: "WorkExperience",
  [LEGACY.EDUCATION]: "Education",
  [LEGACY.LICENSE_OR_CERTIFICATION]: "LicenseOrCertification",
  [LEGACY.SKILL]: "Skill",
  [LEGACY.OTHER_SECTION]: "OtherSection",
};

const TARGET_ID_MODELS: Record<string, BackupModel> = {
  [TARGET.JOB_OPPORTUNITY]: "JobOpportunity",
  [TARGET.JOB_DESCRIPTION_VERSION]: "JobDescriptionVersion",
  [TARGET.APPLICATION_ATTEMPT]: "ApplicationAttempt",
  [TARGET.APPLICATION_PROCESS_STEP]: "ApplicationProcessStep",
  [TARGET.JOB_OPPORTUNITY_NOTE]: "JobOpportunityNote",
  [TARGET.RESUME_VARIANT]: "ResumeVariant",
  [TARGET.RESUME_VARIANT_VERSION]: "ResumeVariantVersion",
  [TARGET.CAREER_MATERIAL_ITEM]: "CareerMaterialItem",
  [TARGET.CAREER_EVIDENCE]: "CareerEvidence",
  [TARGET.CANDIDATE_PROFILE]: "CandidateProfile",
  // Legacy alias: v1/v2 backups and old mappings. Canonical target is CandidateProfile.
  ResumeContactProfile: "CandidateProfile",
  // Phase 3 stores the skipped Job id as the sentinel target.
  [TARGET.UNMAPPED_UNKNOWN_STATUS]: "Job",
};

function remapSemanticId(
  entityType: string,
  entityId: string,
  idMap: IdMap,
  role: "legacy" | "target",
): string {
  const table = role === "legacy" ? LEGACY_ID_MODELS : TARGET_ID_MODELS;
  const model = table[entityType];
  if (!model) {
    throw new Error(
      `LegacyMigrationMap ${role} entity type ${entityType} is not in the backup remap table`,
    );
  }
  const mapped = idMap.get(entityId);
  if (!mapped) {
    throw new Error(
      `LegacyMigrationMap ${role} ${entityType}:${entityId} is not in the restored id map`,
    );
  }
  return mapped;
}

export function remapLegacyMigrationMapIds(
  row: {
    legacyEntityType: string;
    legacyEntityId: string;
    targetEntityType: string;
    targetEntityId: string;
  },
  idMap: IdMap,
  sessionUserId: string,
): {
  legacyEntityId: string;
  targetEntityId: string;
  targetEntityType: string;
} {
  const legacyEntityId =
    row.legacyEntityType === LEGACY.USER_CONTACT_INFO
      ? sessionUserId
      : remapSemanticId(row.legacyEntityType, row.legacyEntityId, idMap, "legacy");

  const targetEntityType = canonicalTargetEntityType(row.targetEntityType);
  const targetEntityId = remapSemanticId(
    targetEntityType,
    row.targetEntityId,
    idMap,
    "target",
  );

  return { legacyEntityId, targetEntityId, targetEntityType };
}

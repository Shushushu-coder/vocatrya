import {
  canonicalTargetEntityType,
  LEGACY_TARGET_ALIAS,
  TARGET,
} from "@/lib/legacy-migration/identities";
import { SENSITIVE_BACKUP_MODELS } from "./ordering";
import {
  BackupDataSchema,
  BackupError,
  type BackupData,
  type BackupManifest,
} from "./schema";

export const LEGACY_BACKUP_PROFILE_KEY = LEGACY_TARGET_ALIAS.RESUME_CONTACT_PROFILE;
export const CANONICAL_BACKUP_PROFILE_KEY = TARGET.CANDIDATE_PROFILE;

const SENSITIVE_KEY_SET = new Set<string>(SENSITIVE_BACKUP_MODELS);

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new BackupError(`${label} is not a JSON object.`);
  }
  return value as Record<string, unknown>;
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function remapCountKey(
  counts: Record<string, number>,
): Record<string, number> {
  const hasLegacy = hasOwn(counts, LEGACY_BACKUP_PROFILE_KEY);
  const hasCanonical = hasOwn(counts, CANONICAL_BACKUP_PROFILE_KEY);
  if (hasLegacy && hasCanonical) {
    throw new BackupError(
      "Backup mixes ResumeContactProfile and CandidateProfile groups.",
    );
  }
  if (!hasLegacy) return counts;
  const next = { ...counts };
  next[CANONICAL_BACKUP_PROFILE_KEY] = counts[LEGACY_BACKUP_PROFILE_KEY];
  delete next[LEGACY_BACKUP_PROFILE_KEY];
  return next;
}

export function normalizeManifest(manifest: BackupManifest): BackupManifest & {
  containsSensitiveData: boolean;
} {
  const counts = remapCountKey(manifest.counts);
  // ManifestSchema only admits literal versions 1-5 before this runs, so an
  // explicit >=3 check can never wave through an unknown future format.
  // v3, v4 and v5 manifests carry a required containsSensitiveData flag whose
  // original value must be preserved — a false normalization would make every
  // sensitive backup unrestorable and a true one would smuggle sensitive
  // groups past assertNoSensitiveKeysWhenStandard.
  if (manifest.formatVersion >= 3) {
    if (typeof manifest.containsSensitiveData !== "boolean") {
      throw new BackupError(
        `v${manifest.formatVersion} backup manifest is missing containsSensitiveData.`,
      );
    }
    if (hasOwn(manifest.counts, LEGACY_BACKUP_PROFILE_KEY)) {
      throw new BackupError(
        `v${manifest.formatVersion} backups must use CandidateProfile, not ResumeContactProfile.`,
      );
    }
    return {
      ...manifest,
      counts,
      containsSensitiveData: manifest.containsSensitiveData,
    };
  }
  return {
    ...manifest,
    counts,
    containsSensitiveData: false,
  };
}

function remapLegacyMigrationMapRows(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return row;
    const record = row as Record<string, unknown>;
    if (typeof record.targetEntityType !== "string") return row;
    return {
      ...record,
      targetEntityType: canonicalTargetEntityType(record.targetEntityType),
    };
  });
}

function assertNoSensitiveKeysWhenStandard(
  data: Record<string, unknown>,
  containsSensitiveData: boolean,
): void {
  if (containsSensitiveData) return;
  for (const key of SENSITIVE_KEY_SET) {
    if (hasOwn(data, key)) {
      throw new BackupError(
        "Backup declares no sensitive data but includes a sensitive group.",
      );
    }
  }
}

export function normalizeBackupData(
  raw: unknown,
  containsSensitiveData: boolean,
): unknown {
  const data = asRecord(raw, "data.json");
  const hasLegacy = hasOwn(data, LEGACY_BACKUP_PROFILE_KEY);
  const hasCanonical = hasOwn(data, CANONICAL_BACKUP_PROFILE_KEY);
  if (hasLegacy && hasCanonical) {
    throw new BackupError(
      "Backup mixes ResumeContactProfile and CandidateProfile groups.",
    );
  }

  const next: Record<string, unknown> = { ...data };
  if (hasLegacy) {
    next[CANONICAL_BACKUP_PROFILE_KEY] = data[LEGACY_BACKUP_PROFILE_KEY];
    delete next[LEGACY_BACKUP_PROFILE_KEY];
  }
  if (hasOwn(next, "LegacyMigrationMap")) {
    next.LegacyMigrationMap = remapLegacyMigrationMapRows(
      next.LegacyMigrationMap,
    );
  }

  assertNoSensitiveKeysWhenStandard(next, containsSensitiveData);
  return next;
}

export function stripSensitiveBackupGroups(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...data };
  for (const key of SENSITIVE_KEY_SET) {
    delete next[key];
  }
  return next;
}

export function emptyStandardBackupData(): BackupData {
  return stripSensitiveBackupGroups(
    BackupDataSchema.parse({}) as unknown as Record<string, unknown>,
  ) as unknown as BackupData;
}

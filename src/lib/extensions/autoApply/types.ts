import type { AutoApplySectionKey } from "./sections";
import type { UpstreamSectionKind } from "./upstreamContract";

/**
 * Whitelisted source DTOs. These shapes contain ONLY the fields the export
 * is allowed to read — `source.ts` builds them with explicit field picks so
 * a full Prisma row (extraData, relations, ids of linked records) can never
 * flow into the export by accident.
 */
export interface AutoApplySourceProfile {
  fullName: string | null;
  headline: string | null;
  email: string | null;
  phone: string | null;
  phoneCountryCode: string | null;
  address: string | null;
  linksData: string | null;
  gender: string | null;
  birthDate: string | null;
  ethnicity: string | null;
  politicalStatus: string | null;
  nativePlace: string | null;
  householdRegistration: string | null;
  graduationCohort: string | null;
  countryOrRegion: string | null;
  wechatId: string | null;
  qqNumber: string | null;
  currentCity: string | null;
  homeCity: string | null;
  homeAddress: string | null;
  updatedAt: Date | string | null;
  /** True when the raw row holds extraData; the value itself never flows. */
  hasExtraData: boolean;
}

export interface AutoApplySourcePreference {
  targetRoles: string | null;
  preferredCities: string | null;
  preferredIndustries: string | null;
  recruitmentTypes: string | null;
  availability: string | null;
  updatedAt: Date | string | null;
  /** hardConstraints / softPreferences presence flags; values never flow. */
  hasConstraints: boolean;
  hasSoftPreferences: boolean;
}

export interface AutoApplySourceEvidence {
  content: string | null;
  metricText: string | null;
}

export interface AutoApplySourceMaterial {
  id: string;
  type: string;
  title: string;
  startDate: Date | string | null;
  endDate: Date | string | null;
  isCurrent: boolean;
  notes: string | null;
  updatedAt: Date | string | null;
  /** Detail row reduced to the per-type whitelist of plain columns. */
  detail: Record<string, unknown>;
  /** Detail row carried non-empty structuredData that we do not map. */
  hasStructuredData: boolean;
  evidence: AutoApplySourceEvidence[];
}

export interface AutoApplySource {
  profile: AutoApplySourceProfile | null;
  preference: AutoApplySourcePreference | null;
  materials: AutoApplySourceMaterial[];
}

/** Upstream profileV2 shapes (see upstream options.js normalizeProfileV2). */
export interface UpstreamCustomRow {
  label: string;
  value: string;
}

export interface UpstreamRepeatItem {
  title: string;
  values: Record<string, string>;
  custom: UpstreamCustomRow[];
}

export interface UpstreamSimpleSection {
  key: string;
  title: string;
  kind: "simple";
  values: Record<string, string>;
  custom: UpstreamCustomRow[];
}

export interface UpstreamRepeatSection {
  key: string;
  title: string;
  kind: "repeat";
  items: UpstreamRepeatItem[];
}

export type UpstreamSection = UpstreamSimpleSection | UpstreamRepeatSection;

export interface UpstreamProfileV2 {
  schemaVersion: number;
  updatedAt: string;
  sections: Record<string, UpstreamSection>;
  customSections: UpstreamSimpleSection[];
}

export interface AutoApplyBackup {
  format: string;
  version: number;
  exportedAt: string;
  /** Vocatrya metadata. Ignored by the upstream importer — safe to carry. */
  source: {
    app: "Vocatrya";
    appVersion: string;
    channel: "manual-export";
    upstreamRepo: string;
    upstreamCommit: string;
    upstreamExtensionVersion: string;
  };
  profileV2: UpstreamProfileV2;
}

/** Per-section outcome shown on the detail page before export. */
export interface AutoApplySectionReport {
  key: AutoApplySectionKey;
  title: string;
  kind: UpstreamSectionKind;
  /** repeat → item count; simple → populated field count. */
  itemCount: number;
  /** Notable expected fields with no source data (e.g. "学校", "邮箱"). */
  missing: string[];
}

export interface AutoApplyExportReport {
  sections: AutoApplySectionReport[];
  /** Mapping ambiguities the user should check inside the plugin. */
  ambiguous: string[];
  /** Source data that exists but has no compatible export target. */
  unsupported: string[];
  /** Sensitive categories excluded by policy. */
  sensitiveExcluded: string[];
}

export interface AutoApplyExportResult {
  backup: AutoApplyBackup;
  report: AutoApplyExportReport;
}

// --- paired plugin connection (safe to import in client components) ------

/** Detail-page view of a paired plugin; secrets never leave the service. */
export interface AutoApplyConnectionSummary {
  id: string;
  clientName: string | null;
  allowedSections: AutoApplySectionKey[];
  pairedAt: string;
  lastSeenAt: string | null;
  lastSyncAt: string | null;
  lastProfileUpdatedAt: string | null;
  revoked: boolean;
  revokedAt: string | null;
}

/** Response body of the extension-facing profile pull. */
export interface AutoApplyPairedProfilePayload {
  connectionId: string;
  issuedAt: string;
  profileV2: UpstreamProfileV2;
  meta: {
    app: "Vocatrya";
    appVersion: string;
    channel: "paired-sync";
    sourceUpdatedAt: string;
    allowedSections: AutoApplySectionKey[];
    sections: AutoApplySectionKey[];
    report: {
      ambiguous: string[];
      unsupported: string[];
      sensitiveExcluded: string[];
    };
  };
}

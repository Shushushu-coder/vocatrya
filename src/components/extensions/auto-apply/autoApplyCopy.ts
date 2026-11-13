import type { Locale } from "@/i18n/config";
import type { AutoApplySectionKey } from "@/lib/extensions/autoApply/sections";
import en from "@/i18n/messages/en.json";
import zhCN from "@/i18n/messages/zh-CN.json";

export interface AutoApplyCopy {
  title: string;
  subtitle: string;
  backToTools: string;
  usageTitle: string;
  usageSteps: readonly string[];
  pluginInfo: string;
  selectTitle: string;
  selectHint: string;
  itemsCount: string;
  fieldsCount: string;
  noData: string;
  missingPrefix: string;
  exportButton: string;
  exporting: string;
  exportFailed: string;
  exportDone: string;
  sensitiveTitle: string;
  notesTitle: string;
  boundaryTitle: string;
  boundaryNotes: readonly string[];
  readUnavailableTitle: string;
  readUnavailable: string;
  sectionTitles: Record<AutoApplySectionKey, string>;
  connect: {
    title: string;
    subtitle: string;
    pairTitle: string;
    pairHint: string;
    pairButton: string;
    pairing: string;
    pairReady: string;
    copy: string;
    copied: string;
    pairFailed: string;
    waiting: string;
    pairExpired: string;
    connectionsTitle: string;
    empty: string;
    untitledClient: string;
    pairedAt: string;
    lastSync: string;
    neverSynced: string;
    lastProfileVersion: string;
    sectionsGranted: string;
    activeBadge: string;
    revokedBadge: string;
    revoke: string;
    revoking: string;
    revokeConfirm: string;
    revokeFailed: string;
    manualTitle: string;
    manualHint: string;
  };
}

export const AUTO_APPLY_COPY = { en: en.extensions.autoApply.detail, "zh-CN": zhCN.extensions.autoApply.detail };
export function getAutoApplyCopy(locale: string): AutoApplyCopy {
 return locale === "en" ? AUTO_APPLY_COPY.en : AUTO_APPLY_COPY["zh-CN"];
}
export function fill(template: string, params: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    params[name] !== undefined ? String(params[name]) : `{${name}}`,
  );
}

export type { Locale };

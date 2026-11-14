import type { PrismaClient } from "@prisma/client";
import { assertCareerDataReadable } from "@/lib/career/access";
import { loadAutoApplySource } from "./source";
import { buildAutoApplyExport } from "./convert";
import { AUTO_APPLY_EXPORTABLE_SECTIONS } from "./sections";
import {
  UPSTREAM_COMMIT,
  UPSTREAM_EXTENSION_VERSION,
  UPSTREAM_VENDORED_PATH,
  VENDORED_EXTENSION_VERSION,
} from "./upstreamContract";
import type { AutoApplyExportReport } from "./types";

/**
 * Real status surface for the shared extension-tools list (owned by task A).
 * `available: false` means the career read path is gated off — the card must
 * show that, never a fabricated "connected" state.
 */
export interface AutoApplyExtensionStatus {
  available: boolean;
  /** Present when available=false, e.g. "career_read_disabled". */
  reason?: string;
  /** Fields+items currently exportable across all sections. */
  exportableItemCount: number;
  /** Latest update timestamp across the source data (ISO), or null. */
  lastSourceUpdatedAt: string | null;
  /** Paired plugin connections (revoked ones are not counted). */
  connections: {
    active: number;
    /** Most recent successful profile pull across active connections. */
    lastSyncAt: string | null;
  };
  detailPath: "/dashboard/extensions/auto-apply";
  plugin: {
    name: "OpenJobAutofill";
    /** The vendored copy's own manifest version (extensions/auto-apply). */
    version: string;
    /** The pinned upstream baseline this vendored copy derives from. */
    upstreamVersion: string;
    upstreamCommit: string;
    vendoredPath: string;
  };
  /** Counts/notes for the page preview; not needed by the card itself. */
  preview?: AutoApplyExportReport;
}

export const AUTO_APPLY_DETAIL_PATH = "/dashboard/extensions/auto-apply" as const;

const NO_CONNECTIONS = { active: 0, lastSyncAt: null } as const;

/**
 * Best-effort connection summary. Runs on every tools-list render, so a
 * pre-migration or otherwise unreadable table degrades to "none" rather
 * than breaking the card.
 */
async function connectionSummary(
  db: PrismaClient,
  userId: string,
): Promise<{ active: number; lastSyncAt: string | null }> {
  try {
    const [active, latest] = await Promise.all([
      db.autoApplyExtensionConnection.count({
        where: { userId, revokedAt: null },
      }),
      db.autoApplyExtensionConnection.findFirst({
        where: { userId, revokedAt: null, lastSyncAt: { not: null } },
        orderBy: { lastSyncAt: "desc" },
        select: { lastSyncAt: true },
      }),
    ]);
    return {
      active,
      lastSyncAt: latest?.lastSyncAt ? latest.lastSyncAt.toISOString() : null,
    };
  } catch {
    return { ...NO_CONNECTIONS };
  }
}

export async function getAutoApplyExtensionStatus(
  db: PrismaClient,
  userId: string,
  options: { includePreview?: boolean } = {},
): Promise<AutoApplyExtensionStatus> {
  const base = {
    detailPath: AUTO_APPLY_DETAIL_PATH,
    plugin: {
      name: "OpenJobAutofill" as const,
      version: VENDORED_EXTENSION_VERSION,
      upstreamVersion: UPSTREAM_EXTENSION_VERSION,
      upstreamCommit: UPSTREAM_COMMIT,
      vendoredPath: UPSTREAM_VENDORED_PATH,
    },
  };
  try {
    await assertCareerDataReadable(db);
  } catch {
    return {
      ...base,
      available: false,
      reason: "career_read_disabled",
      exportableItemCount: 0,
      lastSourceUpdatedAt: null,
      connections: await connectionSummary(db, userId).catch(
        () => ({ ...NO_CONNECTIONS }),
      ),
    };
  }
  const [source, connections] = await Promise.all([
    loadAutoApplySource(db, userId),
    connectionSummary(db, userId),
  ]);
  const { backup, report } = buildAutoApplyExport(source, AUTO_APPLY_EXPORTABLE_SECTIONS);
  return {
    ...base,
    available: true,
    exportableItemCount: report.sections.reduce(
      (total, section) => total + section.itemCount,
      0,
    ),
    lastSourceUpdatedAt: backup.profileV2.updatedAt || null,
    connections,
    ...(options.includePreview ? { preview: report } : {}),
  };
}

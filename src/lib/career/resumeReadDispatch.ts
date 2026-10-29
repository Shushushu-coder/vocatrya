import type { PrismaClient } from "@prisma/client";
import { isResumeV1CapabilityEnabled } from "./capabilities";
import { CAREER_RUNTIME_MODE } from "./identities";
import { CAREER_DATA_ORIGIN, resolveCareerRuntimeMode } from "./runtimeMode";
import { projectResumeVariantText } from "./resumeVariantText";

export type ResumeReadFamily = "ab" | "legacy" | "blocked";

export type ResumeChoice = {
  id: string;
  title: string;
};

export type AbResumeProjection = {
  id: string;
  title: string;
  versionId: string | null;
  text: string;
};

const VARIANT_VERSION_SELECT = {
  id: true,
  headerSnapshot: true,
  sections: {
    orderBy: { sortOrder: "asc" as const },
    select: {
      title: true,
      hiddenAt: true,
      items: {
        orderBy: { sortOrder: "asc" as const },
        select: {
          materialTitleSnapshot: true,
          hiddenAt: true,
          expressions: {
            orderBy: { sortOrder: "asc" as const },
            select: { content: true, hiddenAt: true },
          },
        },
      },
    },
  },
};

/**
 * Resume family for the surface the user can currently open.
 * AB_ENABLED + resume_v1|full reads ResumeVariant.
 * A fresh origin never reads legacy Resume. Disabled and none are unavailable.
 * Migrated LEGACY_ONLY, AB_ENABLED + none, and AB_READY_DISABLED keep legacy Resume.
 * BLOCKED does not select either table.
 */
export async function resolveResumeReadFamily(
  db: PrismaClient | object,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ family: ResumeReadFamily; mode: string; reason: string }> {
  const runtime = await resolveCareerRuntimeMode(db, { env });
  if (runtime.mode === CAREER_RUNTIME_MODE.BLOCKED) {
    return { family: "blocked", mode: runtime.mode, reason: runtime.reason };
  }
  if (isResumeV1CapabilityEnabled(runtime.mode, runtime.rolloutScope)) {
    return { family: "ab", mode: runtime.mode, reason: runtime.reason };
  }
  if (runtime.origin === CAREER_DATA_ORIGIN.fresh) {
    return {
      family: "blocked",
      mode: runtime.mode,
      reason: "fresh-origin-resume-unavailable",
    };
  }
  return { family: "legacy", mode: runtime.mode, reason: runtime.reason };
}

export async function listAbResumeChoices(
  db: PrismaClient,
  userId: string,
): Promise<ResumeChoice[]> {
  const rows = await db.resumeVariant.findMany({
    where: { userId, archivedAt: null },
    orderBy: [{ updatedAt: "desc" }, { name: "asc" }, { id: "asc" }],
    select: { id: true, name: true },
  });
  return rows.map((row) => ({ id: row.id, title: row.name }));
}

async function loadVersion(
  db: PrismaClient,
  userId: string,
  variantId: string,
  versionId: string,
) {
  return db.resumeVariantVersion.findFirst({
    where: {
      id: versionId,
      resumeVariantId: variantId,
      resumeVariant: { userId },
    },
    select: VARIANT_VERSION_SELECT,
  });
}

/**
 * The version the workspace shows: currentVersionId, or the last
 * versionNumber when the variant has no current pointer.
 */
export async function readAbResumeVariant(
  db: PrismaClient,
  userId: string,
  variantId: string,
): Promise<AbResumeProjection | null> {
  const variant = await db.resumeVariant.findFirst({
    where: { id: variantId, userId, archivedAt: null },
    select: { id: true, name: true, currentVersionId: true },
  });
  if (!variant) return null;

  let version = variant.currentVersionId
    ? await loadVersion(db, userId, variant.id, variant.currentVersionId)
    : null;

  if (!variant.currentVersionId) {
    const versions = await db.resumeVariantVersion.findMany({
      where: { resumeVariantId: variant.id, resumeVariant: { userId } },
      orderBy: [{ versionNumber: "asc" }, { id: "asc" }],
      select: { id: true },
    });
    const fallback = versions[versions.length - 1];
    version = fallback
      ? await loadVersion(db, userId, variant.id, fallback.id)
      : null;
  }

  return {
    id: variant.id,
    title: variant.name,
    versionId: version?.id ?? null,
    text: version
      ? projectResumeVariantText({
          headerSnapshot: version.headerSnapshot,
          sections: version.sections,
        })
      : "",
  };
}

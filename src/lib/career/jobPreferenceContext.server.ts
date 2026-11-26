import "server-only";

import type { Prisma, PrismaClient } from "@prisma/client";
import {
  isUserMemoryCategory,
  type UserMemoryCategory,
} from "@/lib/agent/longTermMemory";
import { readAgentPreferences } from "@/lib/agent/preferences";
import { JobSearchPreferenceService } from "./jobSearchPreferenceService";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * M2.2 dual-track job-search preference context.
 *
 * Every preference-aware evaluation entry (match_job fast screening, the
 * deep-match task, today_plan suggestions) reads JobSearchPreference — the
 * authoritative business table — and, only when the long-term memory master
 * switch is on, attaches the user's career_goal / industry_preference
 * memory entries as a labeled supplement (对话沉淀偏好).
 *
 * Hard rules:
 * - The business table always wins on conflict; memory notes are advisory
 *   and rendered under an explicit source label.
 * - Read-only: this module NEVER writes back to JobSearchPreference or to
 *   the memory store.
 * - The memory read degrades to empty — an unavailable or malformed memory
 *   store can never break a match or a plan. The business read stays strict.
 * - All reads run through the caller's db so transaction and isolated-test
 *   clients keep their scope; the longTermMemory.server.ts helpers pin the
 *   global client and cannot serve injected-db callers.
 */
export const JOB_PREFERENCE_MEMORY_CATEGORIES = [
  "career_goal",
  "industry_preference",
] as const satisfies readonly UserMemoryCategory[];

export type JobPreferenceMemoryCategory =
  (typeof JOB_PREFERENCE_MEMORY_CATEGORIES)[number];

export type JobPreferenceMemoryNote = {
  category: JobPreferenceMemoryCategory;
  key: string;
  content: string;
};

/** The seven business-table fields, in the fast-screening snapshot order. */
const BUSINESS_FIELD_ORDER = [
  "targetRoles",
  "preferredCities",
  "preferredIndustries",
  "recruitmentTypes",
  "availability",
  "hardConstraints",
  "softPreferences",
] as const;

export type JobPreferenceFields = Record<
  (typeof BUSINESS_FIELD_ORDER)[number],
  string | null
>;

export type JobPreferenceContext = {
  /** All business-table fields, null when unset. */
  fields: JobPreferenceFields;
  /** At least one structured field carries text. */
  hasBusinessFields: boolean;
  /** The labeled 对话沉淀偏好 supplement — empty when disabled or degraded. */
  memoryNotes: JobPreferenceMemoryNote[];
  /** The memory master-switch state this load observed. */
  memoryEnabled: boolean;
  /** The memory read failed and was degraded to empty. */
  memoryDegraded: boolean;
  /**
   * Canonical snapshot of the full preference input: the business fields
   * plus `memoryNotes` when present. Identical to the legacy fast-screening
   * shape whenever no memory notes apply — {} when nothing exists at all.
   */
  snapshot: Record<string, unknown>;
  /**
   * Prompt-ready rendering: structured fields under an authoritative
   * header, memory notes under the 对话沉淀偏好 label. null when both
   * tracks are empty.
   */
  text: string | null;
};

const AUTH_HEADER =
  "Structured job-search preferences (authoritative business records — they always win on any conflict):";
const MEMORY_HEADER =
  "Supplementary preferences distilled from past conversations (对话沉淀偏好 — advisory reference only; they never override the structured preferences):";
const NO_BUSINESS_LINE =
  "Structured job-search preferences: (none saved — the notes below are the only preference context and stay advisory)";

function renderText(input: {
  fieldLines: string[];
  memoryNotes: JobPreferenceMemoryNote[];
}): string | null {
  const parts: string[] = [];
  if (input.fieldLines.length > 0) {
    parts.push([AUTH_HEADER, ...input.fieldLines].join("\n"));
  }
  if (input.memoryNotes.length > 0) {
    const notes = input.memoryNotes.map(
      (note) => `- [${note.category}] ${note.key}: ${note.content}`,
    );
    parts.push(
      input.fieldLines.length > 0
        ? [MEMORY_HEADER, ...notes].join("\n")
        : [NO_BUSINESS_LINE, MEMORY_HEADER, ...notes].join("\n"),
    );
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

async function readMemoryEnabled(db: Db, userId: string): Promise<boolean> {
  const row = await db.userSettings.findUnique({
    where: { userId },
    select: { settings: true },
  });
  let document: unknown = null;
  try {
    document = row ? JSON.parse(row.settings) : null;
  } catch {
    // Invalid historical settings read as defaults — same contract as
    // loadAgentPreferences in preferences.server.ts.
  }
  return readAgentPreferences(document).longTermMemoryEnabled;
}

/**
 * Load the dual-track preference context for one user. The business read is
 * authoritative and strict; the memory attach is controlled: only when the
 * master switch is on, only the two job-preference categories, always
 * labeled, never written back.
 */
export async function loadJobPreferenceContext(
  db: Db,
  userId: string,
  env?: NodeJS.ProcessEnv,
): Promise<JobPreferenceContext> {
  const preferences = new JobSearchPreferenceService(
    db as PrismaClient,
    userId,
    env,
  );
  const row = await preferences.getJobSearchPreference();
  const fields = Object.fromEntries(
    BUSINESS_FIELD_ORDER.map((key) => [key, row?.[key] ?? null]),
  ) as JobPreferenceFields;
  const fieldLines = BUSINESS_FIELD_ORDER.flatMap((key) => {
    const value = fields[key];
    return typeof value === "string" && value.trim() !== ""
      ? [`${key}: ${value}`]
      : [];
  });

  const memoryEnabled = await readMemoryEnabled(db, userId);
  let memoryNotes: JobPreferenceMemoryNote[] = [];
  let memoryDegraded = false;
  if (memoryEnabled) {
    try {
      const rows = await db.userMemoryEntry.findMany({
        where: {
          userId,
          category: { in: [...JOB_PREFERENCE_MEMORY_CATEGORIES] },
        },
        orderBy: [{ category: "asc" }, { key: "asc" }],
        select: { category: true, key: true, content: true },
      });
      memoryNotes = rows.flatMap((entry) =>
        isUserMemoryCategory(entry.category) &&
        (JOB_PREFERENCE_MEMORY_CATEGORIES as readonly string[]).includes(
          entry.category,
        )
          ? [
              {
                category: entry.category as JobPreferenceMemoryCategory,
                key: entry.key,
                content: entry.content,
              },
            ]
          : [],
      );
    } catch {
      // A supplementary context must never break the evaluation entry.
      memoryDegraded = true;
    }
  }

  const snapshot: Record<string, unknown> =
    fieldLines.length === 0 && memoryNotes.length === 0
      ? {}
      : {
          ...fields,
          ...(memoryNotes.length > 0 ? { memoryNotes } : {}),
        };

  return {
    fields,
    hasBusinessFields: fieldLines.length > 0,
    memoryNotes,
    memoryEnabled,
    memoryDegraded,
    snapshot,
    text: renderText({ fieldLines, memoryNotes }),
  };
}

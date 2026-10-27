import { JOB_SOURCES } from "@/lib/constants";
import { canonicalizeEntityValue } from "@/lib/jobs/canonicalize";

// Stable `value` keys for the seeded-per-user JobSource rows. Display is
// localized from these keys; the stored label is English seed text so a
// locale switch never rewrites the row.
export const SYSTEM_JOB_SOURCE_VALUES: readonly string[] = JOB_SOURCES.map(
  (source) => source.value,
);

const SYSTEM_JOB_SOURCE_BY_VALUE = new Map<string, { label: string; value: string }>(
  JOB_SOURCES.map((source) => [source.value, { label: source.label, value: source.value }]),
);

function aliasKey(label: string): string {
  return canonicalizeEntityValue(label);
}

// Canonical value of each alias → seeded JobSource.value. Chinese and English
// names for the same channel must resolve to one row.
const SYSTEM_JOB_SOURCE_ALIASES: Record<string, string> = {
  [aliasKey("Indeed")]: "indeed",
  [aliasKey("Linkedin")]: "linkedin",
  [aliasKey("LinkedIn")]: "linkedin",
  [aliasKey("Monster")]: "monster",
  [aliasKey("Glassdoor")]: "glassdoor",
  [aliasKey("Company Career page")]: "careerpage",
  [aliasKey("Official Website")]: "careerpage",
  [aliasKey("官网")]: "careerpage",
  [aliasKey("careerpage")]: "careerpage",
  [aliasKey("career page")]: "careerpage",
  [aliasKey("Google")]: "google",
  [aliasKey("ZipRecruiter")]: "ziprecruiter",
  [aliasKey("Job Street")]: "jobstreet",
  [aliasKey("Other")]: "other",
  [aliasKey("Shixiseng")]: "shixiseng",
  [aliasKey("实习僧")]: "shixiseng",
  [aliasKey("BOSS Zhipin")]: "boss zhipin",
  [aliasKey("BOSS直聘")]: "boss zhipin",
  [aliasKey("Boss直聘")]: "boss zhipin",
  [aliasKey("内推群")]: "referral group",
  [aliasKey("Referral Group")]: "referral group",
  [aliasKey("Xiaohongshu")]: "xiaohongshu",
  [aliasKey("小红书")]: "xiaohongshu",
  [aliasKey("RedNote")]: "xiaohongshu",
};

export function resolveSystemJobSourceValue(label: string): string | undefined {
  const canonical = canonicalizeEntityValue(label);
  if (!canonical) return undefined;
  return (
    SYSTEM_JOB_SOURCE_ALIASES[canonical] ??
    (SYSTEM_JOB_SOURCE_BY_VALUE.has(canonical) ? canonical : undefined)
  );
}

export function resolveJobSourceIdentity(
  rawLabel: string,
  maxLength: number,
): { label: string; value: string } | { error: "empty" | "too-long" } {
  const trimmed = rawLabel.trim();
  if (!trimmed) return { error: "empty" };
  if (trimmed.length > maxLength) return { error: "too-long" };

  const systemValue = resolveSystemJobSourceValue(trimmed);
  if (systemValue) {
    const seeded = SYSTEM_JOB_SOURCE_BY_VALUE.get(systemValue);
    if (seeded) {
      return { label: seeded.label, value: seeded.value };
    }
  }

  return { label: trimmed, value: canonicalizeEntityValue(trimmed) };
}

export function missingDefaultJobSources(
  existingValues: Iterable<string>,
): { label: string; value: string }[] {
  const have = new Set(existingValues);
  return JOB_SOURCES.filter((source) => !have.has(source.value)).map(
    (source) => ({ label: source.label, value: source.value }),
  );
}

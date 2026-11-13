/**
 * Unified configuration entry for the interview-practice web destination
 * (EXT-INTERVIEW-WEB). The target HTTPS service is not selected yet, so the
 * only source of truth is VOCATRYA_INTERVIEW_PRACTICE_URL — a full https://
 * address configured per deployment. Missing, malformed, non-HTTPS, or
 * credential-bearing values resolve to null so callers render the
 * unavailable state instead of guessing or producing an invalid jump.
 */
export const INTERVIEW_PRACTICE_URL_ENV = "VOCATRYA_INTERVIEW_PRACTICE_URL";

export function getInterviewPracticeUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[INTERVIEW_PRACTICE_URL_ENV]?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

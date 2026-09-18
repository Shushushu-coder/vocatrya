import { CAREER_RUNTIME_MODE } from "./identities";

export const AB_HIDDEN_JOB_FILTERS = ["accepted", "dismissed"] as const;

export type AbHiddenJobFilter = (typeof AB_HIDDEN_JOB_FILTERS)[number];

export function isAbJobReadMode(mode?: string | null): boolean {
  return (
    mode === CAREER_RUNTIME_MODE.AB_ENABLED ||
    mode === CAREER_RUNTIME_MODE.AB_READY_DISABLED
  );
}

export function isAbHiddenJobFilter(filter: string): boolean {
  return (AB_HIDDEN_JOB_FILTERS as readonly string[]).includes(filter);
}

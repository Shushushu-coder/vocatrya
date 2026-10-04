import { AB_ROLLOUT_SCOPE_ENV } from "./identities";

/**
 * Product capability scope parser. This is the only module allowed to read
 * VOCATRYA_AB_ROLLOUT_SCOPE. Missing, blank, or unknown values fail closed
 * to none.
 */
export const AB_ROLLOUT_SCOPE = {
  none: "none",
  resume_v1: "resume_v1",
  full: "full",
} as const;

export type AbRolloutScope =
  (typeof AB_ROLLOUT_SCOPE)[keyof typeof AB_ROLLOUT_SCOPE];

const LEGAL_SCOPES = new Set<string>(Object.values(AB_ROLLOUT_SCOPE));

/**
 * True only when the operator set the key. Undefined is unset. An empty
 * string is present and still parses to none.
 */
export function isAbRolloutScopeEnvPresent(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(env, AB_ROLLOUT_SCOPE_ENV) &&
    env[AB_ROLLOUT_SCOPE_ENV] !== undefined
  );
}

export function resolveAbRolloutScope(
  env: NodeJS.ProcessEnv = process.env,
): AbRolloutScope {
  const raw = (env[AB_ROLLOUT_SCOPE_ENV] ?? "").trim();
  if (LEGAL_SCOPES.has(raw)) return raw as AbRolloutScope;
  return AB_ROLLOUT_SCOPE.none;
}

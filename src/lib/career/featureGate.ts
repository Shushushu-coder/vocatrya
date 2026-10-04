import { AB_RUNTIME_FEATURE_ENV } from "./identities";

/**
 * Developer/internal enablement only. This flag never means migration
 * completed and cannot override the instance-level integrity gate.
 *
 * Raw parser only. Absent stays false. Blank and unknown tokens stay false.
 * Presence is a separate question so a state-aware resolver can tell an
 * explicit operator value from an unset variable.
 */
export function isAbRuntimeFeatureEnvPresent(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    Object.prototype.hasOwnProperty.call(env, AB_RUNTIME_FEATURE_ENV) &&
    env[AB_RUNTIME_FEATURE_ENV] !== undefined
  );
}

export function isAbRuntimeFeatureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env[AB_RUNTIME_FEATURE_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

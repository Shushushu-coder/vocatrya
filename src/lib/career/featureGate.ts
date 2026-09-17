import { AB_RUNTIME_FEATURE_ENV } from "./identities";

/**
 * Developer/internal enablement only. This flag never means migration
 * completed and cannot override the instance-level integrity gate.
 */
export function isAbRuntimeFeatureEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env[AB_RUNTIME_FEATURE_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

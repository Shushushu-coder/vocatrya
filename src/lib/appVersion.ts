import "server-only";

import packageJson from "../../package.json";

// Single resolution point for "the version this deployment is actually
// running". The packaged desktop backend receives the installer's Electron
// app.getVersion() via VOCATRYA_APP_VERSION so a stale bundled web build
// cannot report an older package.json version; every other deployment
// resolves to the package.json the server was built from. Prerelease/RC
// identifiers pass through verbatim — nothing here parses or truncates.
export function resolveAppVersion(): string {
  return (process.env.VOCATRYA_APP_VERSION ?? "").trim() || packageJson.version;
}

export interface BuildFacts {
  commit: string;
  builtAt: string;
}

// Build facts of the installer this backend was packaged into. The packaged
// desktop main injects them from resources/build-info.json; every other
// deployment (web, dev, unpackaged bundle) leaves the envs unset and gets
// null — no surface should ever fabricate commit/date facts.
export function resolveBuildFacts(): BuildFacts | null {
  const commit = (process.env.VOCATRYA_BUILD_COMMIT ?? "").trim();
  const builtAt = (process.env.VOCATRYA_BUILT_AT ?? "").trim();
  if (!commit || !builtAt) return null;
  return { commit, builtAt };
}

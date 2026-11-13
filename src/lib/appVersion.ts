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

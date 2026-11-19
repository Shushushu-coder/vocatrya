import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { isNewerVersion } from "@/lib/version";
import { AppVersionInfo } from "@/models/version.model";
import { resolveAppVersion } from "@/lib/appVersion";
import { fetchLatestRelease } from "@/lib/latestRelease";
import { log } from "@/lib/telemetry";

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  // resolveAppVersion lets the packaged desktop supply the installer's
  // Electron version so the reported version always matches the installer,
  // even when the bundled web build was produced from a stale .next output.
  const current = resolveAppVersion();
  let release: Awaited<ReturnType<typeof fetchLatestRelease>> = null;

  try {
    release = await fetchLatestRelease();
  } catch (error) {
    log.error("[Version] Update check failed", { error: String(error) });
  }

  const updateAvailable = release
    ? isNewerVersion(release.tag, current)
    : false;

  const info: AppVersionInfo = {
    current,
    latest: release?.tag ?? null,
    updateAvailable,
    releaseUrl: updateAvailable ? (release?.url ?? null) : null,
  };

  return NextResponse.json(info, { status: 200 });
}

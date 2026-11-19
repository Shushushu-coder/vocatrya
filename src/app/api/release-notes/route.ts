import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { getServerLocale } from "@/i18n/server";
import { resolveAppVersion } from "@/lib/appVersion";
import { fetchLatestRelease } from "@/lib/latestRelease";
import {
  extractReleaseNotesSection,
  loadReleaseNotesSource,
} from "@/lib/releaseNotes";
import { isNewerVersion } from "@/lib/version";
import type { ReleaseNotesInfo } from "@/models/version.model";
import { log } from "@/lib/telemetry";

// Bounds the GitHub release body handed to the renderer — curated notes are a
// page or two, and a pathological body must not bloat this response.
const MAX_RELEASE_BODY_CHARS = 32_000;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const locale = await getServerLocale();
  const current = resolveAppVersion();
  const source = await loadReleaseNotesSource(current);

  let release: Awaited<ReturnType<typeof fetchLatestRelease>> = null;
  try {
    release = await fetchLatestRelease();
  } catch (error) {
    // Same policy as /api/version: an offline or rate-limited check degrades
    // silently — the current-version notes still render.
    log.error("[ReleaseNotes] Update check failed", { error: String(error) });
  }

  const info: ReleaseNotesInfo = {
    current: {
      version: current,
      notes: source ? extractReleaseNotesSection(source, locale) : null,
    },
    latest:
      release && isNewerVersion(release.tag, current)
        ? {
            version: release.tag.replace(/^v/, ""),
            notes: release.body
              ? extractReleaseNotesSection(
                  release.body.slice(0, MAX_RELEASE_BODY_CHARS),
                  locale,
                )
              : null,
            url: release.url,
          }
        : null,
  };

  return NextResponse.json(info, { status: 200 });
}

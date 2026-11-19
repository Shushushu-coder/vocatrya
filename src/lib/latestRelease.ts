import "server-only";

import { APP_CONSTANTS } from "@/lib/constants";

const RELEASE_URL = `https://api.github.com/repos/${APP_CONSTANTS.GITHUB_REPO}/releases/latest`;

export interface LatestRelease {
  tag: string;
  url: string | null;
  body: string | null;
}

// A self-hosted instance can be offline or rate-limited; that is not an error
// worth surfacing, so every failure degrades to "no update available". Shared
// by /api/version and /api/release-notes — both calls hit the same Next fetch
// cache entry.
export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  const res = await fetch(RELEASE_URL, {
    headers: { Accept: "application/vnd.github+json" },
    next: { revalidate: APP_CONSTANTS.UPDATE_CHECK_REVALIDATE_SECONDS },
  });
  if (!res.ok) return null;

  const data = await res.json();
  return typeof data?.tag_name === "string"
    ? {
        tag: data.tag_name as string,
        url:
          typeof data?.html_url === "string"
            ? (data.html_url as string)
            : null,
        body: typeof data?.body === "string" ? (data.body as string) : null,
      }
    : null;
}

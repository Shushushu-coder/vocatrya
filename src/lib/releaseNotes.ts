import "server-only";

import fs from "node:fs/promises";
import path from "node:path";
import type { Locale } from "@/i18n/config";

// Marker kept at the top of every release-notes/<version>.md so the release
// gates can prove a file is curated notes and not a stray markdown file.
export const RELEASE_NOTES_MARKER = "vocatrya-release-notes";

// The packaged backend's cwd is the assembled resources/backend directory
// (assemble.mjs copies release-notes/ next to server.js); dev and the docker
// runner execute from the repo/app root where the same directory lives.
function releaseNotesDir(): string {
  return (
    process.env.VOCATRYA_RELEASE_NOTES_DIR?.trim() ||
    path.join(process.cwd(), "release-notes")
  );
}

// A version string becomes a filename — refuse anything that could walk the
// directory, even though the version env is nominally trusted.
function isSafeVersionFile(version: string): boolean {
  return (
    version.length > 0 &&
    !version.includes("/") &&
    !version.includes("\\") &&
    !version.includes("..") &&
    !version.includes("\0")
  );
}

export async function loadReleaseNotesSource(
  version: string,
): Promise<string | null> {
  const trimmed = version.trim().replace(/^v/, "");
  if (!isSafeVersionFile(trimmed)) return null;
  try {
    return await fs.readFile(
      path.join(releaseNotesDir(), `${trimmed}.md`),
      "utf8",
    );
  } catch {
    return null;
  }
}

// Notes files hold one `## zh-CN` and one `## en` section. Any other `## `
// heading (e.g. the "## Links" section the release workflow appends to the
// GitHub body) ends the current locale section without being rendered.
const KNOWN_SECTIONS = new Set<string>(["zh-CN", "en"]);

export function extractReleaseNotesSection(
  source: string,
  locale: Locale,
): string | null {
  if (typeof source !== "string") return null;
  const sections = new Map<string, string[]>();
  let collecting: string[] | null = null;
  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) {
      collecting = KNOWN_SECTIONS.has(heading[1]) ? [] : null;
      if (collecting) sections.set(heading[1], collecting);
      continue;
    }
    collecting?.push(line);
  }
  const picked =
    sections.get(locale) ?? sections.get("zh-CN") ?? sections.get("en");
  const text = picked?.join("\n").trim();
  return text ? text : null;
}

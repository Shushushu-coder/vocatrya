"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/i18n";
import { AgentMarkdown } from "@/components/agent/AgentMarkdown";
import type { ReleaseNotesInfo } from "@/models/version.model";

// Curated bilingual notes ship inside the install as release-notes/<version>.md
// and, for the latest release, inside the GitHub release body. The card only
// renders when one of those sources has something to say, so dev builds and
// installs that predate the notes gate stay uncluttered.
export default function ReleaseNotesCard() {
  const { t } = useI18n();
  const [info, setInfo] = useState<ReleaseNotesInfo | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/release-notes")
      .then((res) => (res.ok ? res.json() : null))
      .then((data: ReleaseNotesInfo | null) => {
        if (active) setInfo(data);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const current = info?.current ?? null;
  const latest = info?.latest ?? null;
  if (!current?.notes && !latest) return null;

  return (
    <div className="space-y-4" data-testid="release-notes-card">
      <div>
        <h3 className="text-lg font-medium">
          {t("settings.releaseNotes.title")}
        </h3>
        <p className="text-sm text-muted-foreground break-words">
          {t("settings.releaseNotes.description")}
        </p>
      </div>

      {current?.notes ? (
        <section data-testid="release-notes-current">
          <h4 className="text-sm font-medium leading-none">
            {t("settings.releaseNotes.currentVersion", {
              version: current.version,
            })}
          </h4>
          <div className="mt-2">
            <AgentMarkdown text={current.notes} />
          </div>
        </section>
      ) : null}

      {latest ? (
        <section data-testid="release-notes-latest">
          <h4 className="text-sm font-medium leading-none">
            {t("settings.releaseNotes.latestVersion", {
              version: latest.version,
            })}
          </h4>
          {latest.notes ? (
            <div className="mt-2">
              <AgentMarkdown text={latest.notes} />
            </div>
          ) : null}
          {latest.url ? (
            <a
              href={latest.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-block text-sm text-primary underline-offset-4 hover:underline"
            >
              {t("settings.releaseNotes.viewReleasePage")}
            </a>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

"use client";

import { ExternalLink, Globe, Loader2 } from "lucide-react";
import { useI18n } from "@/i18n";
import type { AgentNativeSearchPartData } from "@/models/agent.model";

function safeHttpHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username !== "" || parsed.password !== "") return null;
    return parsed.href;
  } catch {
    return null;
  }
}

function actionLabelKey(
  actionType: AgentNativeSearchPartData["actionType"],
  status: AgentNativeSearchPartData["status"],
): string {
  const started = status === "started";
  switch (actionType) {
    case "open_page":
      return started
        ? "nativeSession.search.openingPage"
        : "nativeSession.search.openedPage";
    case "find_in_page":
      return started
        ? "nativeSession.search.findingInPage"
        : "nativeSession.search.foundInPage";
    default:
      return started
        ? "nativeSession.search.searching"
        : "nativeSession.search.searched";
  }
}

export function AgentNativeSearchCard({
  data,
}: {
  data: AgentNativeSearchPartData;
}) {
  const { t } = useI18n();
  const queryList =
    data.queries.length > 0 ? data.queries : data.query ? [data.query] : [];
  const validSources = data.sources
    .map((source) => {
      const href = safeHttpHref(source.url);
      return href ? { ...source, href } : null;
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);

  return (
    <div
      data-testid="agent-native-search-card"
      data-status={data.status}
      className="rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground"
    >
      <div className="flex items-center gap-1.5 font-medium text-foreground">
        {data.status === "started" ? (
          <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        ) : (
          <Globe className="size-3.5 shrink-0" aria-hidden />
        )}
        <span>{t(actionLabelKey(data.actionType, data.status))}</span>
      </div>

      {queryList.length > 0 ? (
        <p className="mt-1 break-words text-xs text-muted-foreground">
          {queryList.join(" · ")}
        </p>
      ) : null}

      {data.pattern && data.pattern !== data.query ? (
        <p className="mt-0.5 break-words text-xs text-muted-foreground">
          {t("nativeSession.search.pattern", { pattern: data.pattern })}
        </p>
      ) : null}

      {validSources.length > 0 ? (
        <div className="mt-2 space-y-1">
          <p className="text-[11px] font-medium text-muted-foreground">
            {t("nativeSession.search.sources")}
          </p>
          <ul className="space-y-1">
            {validSources.map((source) => (
              <li key={source.href} className="min-w-0">
                <a
                  href={source.href}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="inline-flex max-w-full items-center gap-1 break-all text-xs text-primary underline hover:opacity-80"
                >
                  <ExternalLink className="size-3 shrink-0" aria-hidden />
                  <span className="truncate">
                    {source.title || source.host || source.href}
                  </span>
                  {source.title && source.host ? (
                    <span className="shrink-0 text-muted-foreground">
                      ({source.host})
                    </span>
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

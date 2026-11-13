"use client";

import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { useI18n } from "@/i18n";
import { notionCopy, type NotionCopyKey } from "@/lib/extensions/notion/copy";
import type {
  AgentNotionReadResult,
  AgentNotionSearchResult,
  AgentNotionWriteResult,
} from "@/models/agent.model";

function reasonText(
  t: Record<NotionCopyKey, string>,
  code: string | undefined,
): string {
  const key = `reason.${code ?? ""}` as NotionCopyKey;
  return t[key] ?? code ?? t["reason.NOTION_REMOTE_FAILED"];
}

export function NotionSearchResultCard({
  output,
}: {
  output: AgentNotionSearchResult;
}) {
  const { locale } = useI18n();
  const t = useMemo(() => notionCopy(locale), [locale]);
  if (!output.found) {
    return (
      <p className="text-sm text-muted-foreground">
        {output.rawPreview
          ? output.rawPreview
          : output.code
            ? reasonText(t, output.code)
            : t["result.notFound"]}
      </p>
    );
  }
  return (
    <div>
      <p className="mb-1 text-xs font-medium text-muted-foreground">
        {t["result.searchResults"]}
      </p>
      <ul className="space-y-1 text-sm">
        {output.results.map((item) => (
          <li key={item.id} className="break-words">
            <span className="font-medium">{item.title}</span>
            {item.objectType && (
              <span className="ml-1 text-xs text-muted-foreground">
                ({item.objectType})
              </span>
            )}
            {item.lastEditedAt && (
              <span className="ml-2 text-xs text-muted-foreground">
                {item.lastEditedAt.slice(0, 10)}
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function NotionReadResultCard({
  output,
}: {
  output: AgentNotionReadResult;
}) {
  const { locale } = useI18n();
  const t = useMemo(() => notionCopy(locale), [locale]);
  if (!output.found) {
    return (
      <p className="text-sm text-muted-foreground">
        {reasonText(t, output.code)}
      </p>
    );
  }
  return (
    <div>
      {output.title && (
        <p className="mb-1 text-sm font-semibold">{output.title}</p>
      )}
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs">
        {output.content}
      </pre>
      {output.truncated && (
        <p className="mt-1 text-xs text-muted-foreground">
          {t["result.truncated"]}
        </p>
      )}
      {output.url && (
        <a
          href={output.url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-2 inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          {t["result.viewInNotion"]}
          <ExternalLink className="h-3 w-3" />
        </a>
      )}
    </div>
  );
}

export function NotionWriteResultCard({
  output,
}: {
  output: AgentNotionWriteResult;
}) {
  const { locale } = useI18n();
  const t = useMemo(() => notionCopy(locale), [locale]);
  if (output.saved) {
    return (
      <div className="text-sm">
        <p className="font-medium">{t["result.saved"]}</p>
        {output.title && (
          <p className="mt-0.5 text-muted-foreground">{output.title}</p>
        )}
        {output.pageId && (
          <p className="mt-0.5 break-all text-xs text-muted-foreground">
            {output.pageId}
          </p>
        )}
        {output.url && (
          <a
            href={output.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
          >
            {t["result.viewInNotion"]}
            <ExternalLink className="h-3 w-3" />
          </a>
        )}
        {output.warnings && output.warnings.length > 0 && (
          <ul className="mt-1 list-disc pl-4 text-xs text-muted-foreground">
            {output.warnings.map((warning, i) => (
              <li key={i}>{warning}</li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  const headline =
    output.status === "reauth_required"
      ? t["result.reauth"]
      : output.status === "verification_required"
        ? t["result.verificationRequired"]
        : output.status === "unknown"
          ? t["result.unknown"]
          : t["result.failed"];
  return (
    <div className="text-sm">
      <p className="font-medium">{headline}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {reasonText(t, output.code)}
        {output.detail ? ` — ${output.detail}` : ""}
      </p>
    </div>
  );
}

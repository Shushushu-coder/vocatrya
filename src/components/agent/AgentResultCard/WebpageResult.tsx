"use client";

import { ExternalLink } from "lucide-react";
import { useI18n } from "@/i18n";
import type { AgentReadWebpageResult } from "@/models/agent.model";

function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

export function WebpageResult({ output }: { output: AgentReadWebpageResult }) {
  const { t, locale } = useI18n();
  if (!output.ok) {
    const key = `agent.webpage.error.${output.code}`;
    const text = t(key);
    return (
      <p className="break-words text-sm text-muted-foreground">
        {text === key ? output.code : text}
        {output.status ? ` (${output.status})` : ""}
        <span className="ml-1 font-mono text-xs">[{output.code}]</span>
      </p>
    );
  }
  const href = safeHref(output.finalUrl);
  const time = new Date(output.fetchedAt).toLocaleString(locale);
  return (
    <div className="space-y-1 text-sm">
      <p className="font-semibold break-words">
        {output.title || t("agent.webpage.untitled")}
      </p>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex max-w-full items-center gap-1 break-all text-xs text-primary underline"
        >
          <ExternalLink className="h-3 w-3 shrink-0" />
          {output.finalUrl}
        </a>
      ) : (
        <span className="break-all text-xs">{output.finalUrl}</span>
      )}
      <p className="text-xs text-muted-foreground">
        {t("agent.webpage.fetchedAt", { time })}
      </p>
      {output.truncated && (
        <p className="text-xs text-muted-foreground">
          {t("agent.webpage.truncated")}
        </p>
      )}
    </div>
  );
}

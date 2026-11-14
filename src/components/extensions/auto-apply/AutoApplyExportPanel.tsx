"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useI18n } from "@/i18n";
import { fill, getAutoApplyCopy } from "./autoApplyCopy";
import {
  AUTO_APPLY_EXPORTABLE_SECTIONS,
  type AutoApplySectionKey,
} from "@/lib/extensions/autoApply/sections";
import type { AutoApplyExportReport } from "@/lib/extensions/autoApply/types";

type AutoApplyExportPanelProps = {
  preview: AutoApplyExportReport;
  pluginVersion: string;
  upstreamVersion: string;
  upstreamCommit: string;
};

export function AutoApplyExportPanel({
  preview,
  pluginVersion,
  upstreamVersion,
  upstreamCommit,
}: AutoApplyExportPanelProps) {
  const { locale } = useI18n();
  const copy = getAutoApplyCopy(locale);
  const sectionTitle = (key: AutoApplySectionKey) =>
    copy.sectionTitles[key as keyof typeof copy.sectionTitles] ?? key;

  const reportByKey = useMemo(() => {
    const map = new Map(preview.sections.map((entry) => [entry.key, entry]));
    return map;
  }, [preview.sections]);

  const [selected, setSelected] = useState<Set<AutoApplySectionKey>>(
    () => new Set(AUTO_APPLY_EXPORTABLE_SECTIONS),
  );
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const toggle = (key: AutoApplySectionKey) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onExport = async () => {
    setError(null);
    setDone(null);
    setExporting(true);
    try {
      const query = AUTO_APPLY_EXPORTABLE_SECTIONS.filter((key) =>
        selected.has(key),
      ).join(",");
      const res = await fetch(
        `/api/extensions/auto-apply/export?sections=${encodeURIComponent(query)}`,
        { cache: "no-store" },
      );
      if (!res.ok) {
        let message: string = copy.exportFailed;
        try {
          const body = (await res.json()) as { error?: string };
          if (body?.error) message = `${copy.exportFailed}（${body.error}）`;
        } catch {
          // keep generic message
        }
        setError(message);
        return;
      }
      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") ?? "";
      const match = /filename="?([^";]+)"?/i.exec(disposition);
      const filename = match?.[1] ?? "vocatrya-autofill-profile.json";
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setDone(fill(copy.exportDone, { filename }));
    } catch {
      setError(copy.exportFailed);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy.usageTitle}</CardTitle>
          <CardDescription>
            {fill(copy.pluginInfo, {
              version: pluginVersion,
              upstreamVersion,
              commit: upstreamCommit.slice(0, 12),
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
            {copy.usageSteps.map((step, index) => (
              <li key={index}>{step}</li>
            ))}
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy.selectTitle}</CardTitle>
          <CardDescription>{copy.selectHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {AUTO_APPLY_EXPORTABLE_SECTIONS.map((key) => {
              const entry = reportByKey.get(key);
              const count = entry?.itemCount ?? 0;
              const missing = entry?.missing ?? [];
              return (
                <label
                  key={key}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border/60 p-2 text-sm hover:bg-muted/40"
                >
                  <input
                    type="checkbox"
                    className="mt-0.5 h-4 w-4 accent-primary"
                    checked={selected.has(key)}
                    onChange={() => toggle(key)}
                  />
                  <span className="flex-1">
                    <span className="flex items-center gap-2">
                      {sectionTitle(key)}
                      <Badge variant={count > 0 ? "secondary" : "outline"}>
                        {count > 0
                          ? fill(
                              entry?.kind === "repeat"
                                ? copy.itemsCount
                                : copy.fieldsCount,
                              { count },
                            )
                          : copy.noData}
                      </Badge>
                    </span>
                    {missing.length > 0 && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {copy.missingPrefix}
                        {missing.join("、")}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="flex items-center gap-3 pt-1">
            <Button
              onClick={onExport}
              disabled={exporting || selected.size === 0}
            >
              {exporting ? copy.exporting : copy.exportButton}
            </Button>
            {error && <span className="text-sm text-destructive">{error}</span>}
            {done && <span className="text-sm text-muted-foreground">{done}</span>}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy.sensitiveTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {preview.sensitiveExcluded.map((item) => (
              <Badge key={item} variant="outline">
                {item}
              </Badge>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy.notesTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {[...preview.ambiguous, ...preview.unsupported].map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{copy.boundaryTitle}</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {copy.boundaryNotes.map((note, index) => (
              <li key={index}>{note}</li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

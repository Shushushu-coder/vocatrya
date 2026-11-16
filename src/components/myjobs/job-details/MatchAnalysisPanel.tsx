"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import {
  getFastScreeningPreflight,
  listMatchAnalyses,
  runFastScreeningMatch,
} from "@/actions/matchAnalysis.actions";
import type {
  FastScreeningPreflight,
  FastScreeningSource,
  MatchAnalysisListItem,
} from "@/lib/career/fastScreeningContract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { toastError } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { DeepMatchSection } from "./DeepMatchSection";
import {
  errorMessageKey,
  verdictLabel,
  verdictVariant,
} from "./matchErrorKeys";

export { errorMessageKey, verdictLabel, verdictVariant };

/**
 * Canonical fresh-native match tab (RM-MATCH minimal chain): source pick →
 * MATCH_ANALYSIS assignment → structured FAST_SCREENING → persisted result
 * + reloadable history. Failed runs persist nothing; retrying re-runs the
 * whole chain with a fresh operation identity.
 */

const CAREER_PROFILE_KEY = "career-profile";
const RESUME_VERSION_PREFIX = "resume-version:";

type RunError = { code: string; detail?: string | null };

function sourceFromKey(key: string): FastScreeningSource {
  if (key.startsWith(RESUME_VERSION_PREFIX)) {
    return { kind: "resume-version", versionId: key.slice(RESUME_VERSION_PREFIX.length) };
  }
  return { kind: "career-profile" };
}

export function MatchAnalysisPanel({ jobId }: { jobId: string }) {
  const { t, formatDateTime } = useI18n();
  const [preflight, setPreflight] = useState<FastScreeningPreflight | null>(null);
  const [analyses, setAnalyses] = useState<MatchAnalysisListItem[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sourceKey, setSourceKey] = useState<string>(CAREER_PROFILE_KEY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<RunError | null>(null);

  const load = useCallback(async () => {
    const [preflightResult, listResult] = await Promise.all([
      getFastScreeningPreflight({ jobOpportunityId: jobId }),
      listMatchAnalyses({ jobOpportunityId: jobId }),
    ]);
    if (!preflightResult.success || !listResult.success) {
      setLoadFailed(true);
      const message = !preflightResult.success
        ? preflightResult.message
        : !listResult.success
          ? listResult.message
          : undefined;
      toastError(message ?? t("matchAnalysis.loadFailed"));
      return;
    }
    setLoadFailed(false);
    setPreflight(preflightResult.data ?? null);
    setAnalyses(listResult.data ?? []);
    setSelectedId((previous) =>
      previous &&
      (listResult.data ?? []).some((row) => row.id === previous)
        ? previous
        : null,
    );
  }, [jobId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedAnalysis = useMemo(() => {
    if (!analyses || analyses.length === 0) return null;
    return (
      analyses.find((row) => row.id === selectedId) ??
      analyses.find((row) => !row.isStale) ??
      analyses[0]
    );
  }, [analyses, selectedId]);

  const runDisabledReason = useMemo(() => {
    if (!preflight) return t("common.loading");
    if (!preflight.hasJobDescription) {
      return t("matchAnalysis.jdMissingHint");
    }
    if (
      sourceKey === CAREER_PROFILE_KEY &&
      preflight.materialsCount === 0 &&
      !preflight.hasPreference
    ) {
      return t("matchAnalysis.materialEmptyHint");
    }
    return null;
  }, [preflight, sourceKey, t]);

  const onRun = async () => {
    setRunning(true);
    setRunError(null);
    try {
      const result = await runFastScreeningMatch({
        jobOpportunityId: jobId,
        source: sourceFromKey(sourceKey),
      });
      if (!result.success) {
        setRunError({ code: "ACTION_FAILED", detail: result.message });
        return;
      }
      const data = result.data;
      if (!data || data.kind === "failed") {
        setRunError({
          code: data?.code ?? "UNKNOWN",
          detail: data?.detail,
        });
        return;
      }
      setSelectedId(data.analysis.id);
      // Refresh history so the persisted row and any newly-stale analyses
      // render exactly what the database holds.
      void load();
    } finally {
      setRunning(false);
    }
  };

  if (loadFailed && !preflight) {
    return (
      <Alert variant="destructive">
        <AlertTriangle />
        <AlertTitle>{t("matchAnalysis.loadFailed")}</AlertTitle>
        <AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("matchAnalysis.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!preflight || !analyses) {
    return <p className="text-sm text-muted-foreground">{t("common.loading")}</p>;
  }

  const detail = selectedAnalysis?.fastScreeningDetail ?? null;
  const verdict = verdictVariant(detail?.verdict);

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="match-source">{t("matchAnalysis.sourceLabel")}</Label>
          <Select
            value={sourceKey}
            onValueChange={setSourceKey}
            disabled={running}
          >
            <SelectTrigger id="match-source" className="max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CAREER_PROFILE_KEY}>
                {t("matchAnalysis.sourceCareerProfile")}
              </SelectItem>
              {preflight.resumeVersions.map((version) => (
                <SelectItem
                  key={version.versionId}
                  value={`${RESUME_VERSION_PREFIX}${version.versionId}`}
                >
                  {`${version.variantName} · v${version.versionNumber}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <p className="text-sm text-muted-foreground" data-testid="match-assignment-state">
          {preflight.assignment.status === "RESOLVED"
            ? t("matchAnalysis.assignmentResolved", {
                provider: preflight.assignment.provider,
                model: preflight.assignment.model,
              })
            : preflight.assignment.status === "INVALID_ASSIGNMENT"
              ? t("matchAnalysis.assignmentInvalid", {
                  code: preflight.assignment.code,
                })
              : t("matchAnalysis.assignmentNotConfigured")}
        </p>

        {runDisabledReason && (
          <p className="text-sm text-muted-foreground" data-testid="match-run-hint">
            {runDisabledReason}
          </p>
        )}

        <div className="flex items-center gap-3">
          <Button
            onClick={() => void onRun()}
            disabled={running || runDisabledReason !== null}
            data-testid="match-run-button"
          >
            {running ? (
              <>
                <Spinner className="mr-2" />
                {t("matchAnalysis.running")}
              </>
            ) : runError ? (
              t("matchAnalysis.retry")
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                {t("matchAnalysis.run")}
              </>
            )}
          </Button>
        </div>

        {runError && (
          <Alert variant="destructive" data-testid="match-run-error">
            <AlertTriangle />
            <AlertTitle>{t("matchAnalysis.runFailed")}</AlertTitle>
            <AlertDescription>
              <p>
                {t(errorMessageKey(runError.code), { code: runError.code })}
              </p>
              {runError.detail ? <p>{runError.detail}</p> : null}
            </AlertDescription>
          </Alert>
        )}
      </div>

      <DeepMatchSection
        jobId={jobId}
        resumeVersions={preflight.resumeVersions}
        hasJobDescription={preflight.hasJobDescription}
      />

      {selectedAnalysis && detail && (
        <section
          className="rounded-lg border p-4 space-y-3"
          data-testid="match-result"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={verdict.variant} data-testid="match-verdict">
              {verdictLabel(detail.verdict, t)}
            </Badge>
            {selectedAnalysis.isStale && (
              <Badge variant="outline" data-testid="match-stale-badge">
                {t("matchAnalysis.stale")}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground">
              {selectedAnalysis.provider || selectedAnalysis.model
                ? t("matchAnalysis.ranWith", {
                    provider: selectedAnalysis.provider ?? "—",
                    model: selectedAnalysis.model ?? "—",
                  })
                : null}
              {" · "}
              {formatDateTime(selectedAnalysis.completedAt ?? selectedAnalysis.createdAt)}
            </span>
          </div>

          {selectedAnalysis.isStale &&
            selectedAnalysis.staleReasonCodes.length > 0 && (
              <p className="text-sm text-muted-foreground" data-testid="match-stale-reasons">
                {t("matchAnalysis.staleBecause", {
                  reasons: selectedAnalysis.staleReasonCodes
                    .map((code) => t(`matchAnalysis.staleReasons.${code}`))
                    .join(", "),
                })}
              </p>
            )}

          {detail.reasons && (
            <div>
              <p className="text-sm font-medium">
                {t("matchAnalysis.sections.reasons")}
              </p>
              <p className="mt-1 text-sm whitespace-pre-wrap">{detail.reasons}</p>
            </div>
          )}
          {detail.hardRequirements && (
            <div>
              <p className="text-sm font-medium">
                {t("matchAnalysis.sections.hardRequirements")}
              </p>
              <p className="mt-1 text-sm whitespace-pre-wrap">
                {detail.hardRequirements}
              </p>
            </div>
          )}
          {detail.coreMatch && (
            <div>
              <p className="text-sm font-medium">
                {t("matchAnalysis.sections.coreMatch")}
              </p>
              <p className="mt-1 text-sm whitespace-pre-wrap">{detail.coreMatch}</p>
            </div>
          )}
          {detail.preferenceMatch && (
            <div>
              <p className="text-sm font-medium">
                {t("matchAnalysis.sections.preferenceMatch")}
              </p>
              <p className="mt-1 text-sm whitespace-pre-wrap">
                {detail.preferenceMatch}
              </p>
            </div>
          )}
        </section>
      )}

      <section className="space-y-2" data-testid="match-history">
        <p className="text-sm font-medium">{t("matchAnalysis.historyTitle")}</p>
        {analyses.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("matchAnalysis.historyEmpty")}
          </p>
        ) : (
          <ul className="divide-y rounded-lg border">
            {analyses.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  onClick={() => setSelectedId(row.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50",
                    row.id === selectedAnalysis?.id && "bg-muted/50",
                  )}
                  data-testid="match-history-item"
                >
                  <span className="min-w-0 flex items-center gap-2">
                    <Badge
                      variant={verdictVariant(row.fastScreeningDetail?.verdict).variant}
                      className="shrink-0"
                    >
                      {verdictLabel(row.fastScreeningDetail?.verdict, t)}
                    </Badge>
                    <span className="truncate text-muted-foreground">
                      {formatDateTime(row.completedAt ?? row.createdAt)}
                      {row.provider || row.model
                        ? ` · ${row.provider ?? "—"} · ${row.model ?? "—"}`
                        : ""}
                    </span>
                  </span>
                  {row.isStale && (
                    <Badge variant="outline" className="shrink-0">
                      {t("matchAnalysis.stale")}
                    </Badge>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

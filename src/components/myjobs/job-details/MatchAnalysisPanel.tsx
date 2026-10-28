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

/**
 * Canonical fresh-native match tab (RM-MATCH minimal chain): source pick →
 * MATCH_ANALYSIS assignment → structured FAST_SCREENING → persisted result
 * + reloadable history. Failed runs persist nothing; retrying re-runs the
 * whole chain with a fresh operation identity.
 */

const CAREER_PROFILE_KEY = "career-profile";
const RESUME_VERSION_PREFIX = "resume-version:";

type RunError = { code: string; detail?: string | null };

const CONNECTION_CODES = new Set([
  "ASSIGNED_CONNECTION_UNAVAILABLE",
  "CONNECTION_DISCONNECTED",
  "CONNECTION_ERROR",
  "REAUTH_REQUIRED",
  "CONNECTION_REAUTH_REQUIRED",
  "RUNTIME_NOT_AVAILABLE",
  "RUNTIME_NOT_INSTALLED",
  "RUNTIME_BROKEN",
  "RUNTIME_UPDATE_REQUIRED",
  "BACKEND_UNAVAILABLE",
  "AI_EXECUTION_TIMEOUT",
  "AI_EXECUTION_FAILED",
  "INFERENCE_FAILED",
  "BYOK_CREDENTIAL_UNAVAILABLE",
  "GATEWAY_AUTH",
  "GATEWAY_NETWORK",
  "GATEWAY_TIMEOUT",
  "GATEWAY_RESPONSE",
  "MANAGED_AI_DISABLED",
  "MANAGED_AUTH_REQUIRED",
  "MANAGED_RUNTIME_UNAVAILABLE",
  "MANAGED_BINDING_UNAVAILABLE",
  "MANAGED_PROVENANCE_INVALID",
  "MANAGED_EXECUTION_NOT_IMPLEMENTED",
  "INVOCATION_ID_REQUIRED",
  "INVOCATION_CONFLICT",
  "INVOCATION_STATUS_UNKNOWN",
  "INVOCATION_IN_PROGRESS",
]);

const ASSIGNMENT_CODES = new Set([
  "AI_NOT_CONFIGURED",
  "MODEL_UNAVAILABLE",
  "MODEL_DISABLED",
  "MODEL_NOT_ALLOWED",
  "UNSUPPORTED_PROVIDER_RUNTIME_COMBINATION",
  "PERMISSION_BOUNDARY_NOT_READY",
  "ACCOUNT_IDENTITY_CONFLICT",
  "CONNECTION_ARCHIVED",
  "CONNECTION_NOT_FOUND",
  "UNSUPPORTED_BACKEND",
  "PROVIDER_POLICY_RESTRICTED",
]);

const QUOTA_CODES = new Set([
  "QUOTA_EXCEEDED",
  "NOT_ENTITLED",
  "GATEWAY_RATE_LIMIT",
  "AI_REQUEST_TOO_LARGE",
]);

function errorMessageKey(code: string): string {
  switch (code) {
    case "MATCH_JD_MISSING":
    case "MATCH_INSUFFICIENT_MATERIAL":
    case "NOT_CONFIGURED":
      return `matchAnalysis.errors.${code}`;
    default:
      break;
  }
  if (QUOTA_CODES.has(code)) return "matchAnalysis.errors.quota";
  if (ASSIGNMENT_CODES.has(code)) return "matchAnalysis.errors.invalidAssignment";
  if (CONNECTION_CODES.has(code)) return "matchAnalysis.errors.connection";
  if (code.startsWith("STRUCTURED_OUTPUT_")) {
    return "matchAnalysis.errors.output";
  }
  return "matchAnalysis.errors.generic";
}

function verdictVariant(verdict: string | undefined): {
  variant: "default" | "secondary" | "destructive" | "outline";
  className?: string;
} {
  switch (verdict) {
    case "PASS":
      return { variant: "secondary" };
    case "FAIL":
      return { variant: "destructive" };
    case "BORDERLINE":
      return { variant: "outline" };
    default:
      return { variant: "secondary" };
  }
}

function verdictLabel(
  verdict: string | null | undefined,
  t: (key: string) => string,
): string {
  const key = `matchAnalysis.verdict.${verdict ?? "UNKNOWN"}`;
  const text = t(key);
  // Missing translations resolve to the key itself — fall back to the raw
  // verdict rather than showing an i18n path.
  return text === key ? (verdict ?? "—") : text;
}

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

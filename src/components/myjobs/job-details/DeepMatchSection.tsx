"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Sparkles } from "lucide-react";
import {
  cancelDeepMatchTask,
  getDeepMatchTask,
  getDeepMatchTaskForJob,
  listDeepMatchAnalysisItems,
  retryDeepMatchTask,
  startDeepMatchTask,
} from "@/actions/deepMatchTask.actions";
import type {
  DeepMatchAnalysisItem,
  DeepMatchTaskDTO,
} from "@/lib/career/deepMatchContract";
import type { FastScreeningResumeOption } from "@/lib/career/fastScreeningContract";
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
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n";
import { errorMessageKey } from "./matchErrorKeys";

/**
 * Durable DEEP_MATCH surface inside the job match tab.
 *
 * The server is the state authority: the card renders whatever the task
 * row says, polling only while the task is active, and a fresh mount
 * rediscovers the task from the server — nothing depends on page memory.
 * A click mints one requestKey; retransmits land on the same task and a
 * finished task requires an explicit new run. No fake progress: statuses
 * and the server-reported step are all the UI ever claims.
 */

const ACTIVE_STATUSES = new Set(["QUEUED", "RUNNING", "CANCELLING"]);
const POLL_MS = 2000;

/** Task codes that have their own deep-match copy; everything else falls
 *  through to the shared match error buckets. */
const TASK_ERROR_KEYS = new Set([
  "TASK_NOT_FOUND",
  "TASK_NOT_RETRYABLE",
  "TASK_INPUT_VERSION_UNSUPPORTED",
  "DEEP_MATCH_REQUEST_CONFLICT",
  "DEEP_MATCH_REQUEST_INVALID",
  "DEEP_MATCH_STATE_CONFLICT",
  "OPPORTUNITY_NOT_FOUND",
  "DEEP_JD_VERSION_MISSING",
  "DEEP_RESUME_VERSION_MISSING",
  "RESUME_VERSION_NOT_SUBMITTABLE",
  "POLL_FAILED",
]);

function deepMatchErrorKey(code: string | null): string {
  if (code && TASK_ERROR_KEYS.has(code)) {
    return `deepMatch.errors.${code}`;
  }
  return errorMessageKey(code ?? "DEEP_MATCH_EXECUTION_FAILED");
}

function taskStatusKey(task: DeepMatchTaskDTO): string {
  return `deepMatch.status.${task.status}`;
}

function sourceLine(
  t: (key: string, vars?: Record<string, string | number>) => string,
  source: {
    jdVersionNumber: number | null;
    resumeVariantName: string | null;
    resumeVersionNumber: number | null;
  } | null,
): string {
  if (!source) return t("deepMatch.sourceUnavailable");
  const jd =
    source.jdVersionNumber !== null
      ? t("deepMatch.sourceJd", { version: source.jdVersionNumber })
      : t("deepMatch.sourceJdMissing");
  const resume =
    source.resumeVariantName !== null && source.resumeVersionNumber !== null
      ? t("deepMatch.sourceResume", {
          name: source.resumeVariantName,
          version: source.resumeVersionNumber,
        })
      : t("deepMatch.sourceResumeMissing");
  return `${jd} · ${resume}`;
}

const DETAIL_SECTIONS: readonly {
  key: keyof NonNullable<DeepMatchAnalysisItem["deepMatchDetail"]>;
  labelKey: string;
}[] = [
  { key: "hardRequirements", labelKey: "deepMatch.sections.hardRequirements" },
  {
    key: "responsibilityAlignment",
    labelKey: "deepMatch.sections.responsibilityAlignment",
  },
  {
    key: "experienceRelevance",
    labelKey: "deepMatch.sections.experienceRelevance",
  },
  { key: "skillCoverage", labelKey: "deepMatch.sections.skillCoverage" },
  {
    key: "educationExperienceFit",
    labelKey: "deepMatch.sections.educationExperienceFit",
  },
  { key: "strengths", labelKey: "deepMatch.sections.strengths" },
  { key: "gaps", labelKey: "deepMatch.sections.gaps" },
  {
    key: "resumeOptimizationOpportunities",
    labelKey: "deepMatch.sections.resumeOptimizationOpportunities",
  },
  { key: "nonFixableGaps", labelKey: "deepMatch.sections.nonFixableGaps" },
];

export function DeepMatchSection({
  jobId,
  resumeVersions,
  hasJobDescription,
}: {
  jobId: string;
  resumeVersions: FastScreeningResumeOption[];
  hasJobDescription: boolean;
}) {
  const { t, formatDateTime } = useI18n();
  const [task, setTask] = useState<DeepMatchTaskDTO | null>(null);
  const [results, setResults] = useState<DeepMatchAnalysisItem[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [versionId, setVersionId] = useState<string>("");
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedResultId, setSelectedResultId] = useState<string | null>(null);
  // Task id the current poll loop watches — a task switch restarts it.
  const pollTaskRef = useRef<string | null>(null);

  const refreshResults = useCallback(async () => {
    const result = await listDeepMatchAnalysisItems({ jobOpportunityId: jobId });
    if (result.success) {
      setResults(result.data ?? []);
      return true;
    }
    return false;
  }, [jobId]);

  // Initial load: rediscover the latest task and the result history from
  // the server — never from anything the page remembered.
  const load = useCallback(async () => {
    const [taskResult, resultsOk] = await Promise.all([
      getDeepMatchTaskForJob({ jobOpportunityId: jobId }),
      refreshResults(),
    ]);
    if (taskResult.success && resultsOk) {
      setTask(taskResult.data?.task ?? null);
      setLoadFailed(false);
    } else {
      setLoadFailed(true);
    }
    setLoaded(true);
  }, [jobId, refreshResults]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll while the task is active. The interval stops on terminal status,
  // on error and on unmount — and a mid-poll task switch is dropped.
  useEffect(() => {
    if (!task || !ACTIVE_STATUSES.has(task.status)) {
      pollTaskRef.current = null;
      return;
    }
    pollTaskRef.current = task.id;
    const watched = task.id;
    const timer = setInterval(() => {
      void (async () => {
        const result = await getDeepMatchTask({ taskId: watched });
        if (pollTaskRef.current !== watched) return;
        if (!result.success || !result.data?.task) {
          // A read failure stops polling rather than faking a state.
          pollTaskRef.current = null;
          clearInterval(timer);
          setActionError(result.success ? "TASK_NOT_FOUND" : "POLL_FAILED");
          return;
        }
        const next = result.data.task;
        setTask(next);
        if (!ACTIVE_STATUSES.has(next.status)) {
          clearInterval(timer);
          if (next.status === "SUCCEEDED") {
            await refreshResults();
            if (next.resultAnalysisId) {
              setSelectedResultId(next.resultAnalysisId);
            }
          }
        }
      })();
    }, POLL_MS);
    return () => {
      if (pollTaskRef.current === watched) pollTaskRef.current = null;
      clearInterval(timer);
    };
  }, [task, refreshResults]);

  const active = task !== null && ACTIVE_STATUSES.has(task.status);
  const startDisabled =
    starting || active || versionId === "" || !hasJobDescription;

  const onStart = async () => {
    if (versionId === "") return;
    setStarting(true);
    setActionError(null);
    try {
      const result = await startDeepMatchTask({
        jobOpportunityId: jobId,
        resumeVariantVersionId: versionId,
        // One key per click intent: a retransmit of THIS request lands on
        // the same task; the next explicit click is a new analysis.
        requestKey: `deepmatch:${crypto.randomUUID()}`,
      });
      if (!result.success || !result.data?.task) {
        setActionError(
          !result.success ? (result.code ?? "ACTION_FAILED") : "ACTION_FAILED",
        );
        return;
      }
      setTask(result.data.task);
    } finally {
      setStarting(false);
    }
  };

  const onCancel = async () => {
    if (!task) return;
    setCancelling(true);
    setActionError(null);
    try {
      const result = await cancelDeepMatchTask({ taskId: task.id });
      if (!result.success) {
        setActionError(result.code ?? "ACTION_FAILED");
        return;
      }
      // The server returned intent state, not a finished cancel — re-read
      // the row so the card shows CANCELLING until the runner settles.
      const fresh = await getDeepMatchTask({ taskId: task.id });
      if (fresh.success && fresh.data?.task) setTask(fresh.data.task);
    } finally {
      setCancelling(false);
    }
  };

  const onRetry = async () => {
    if (!task) return;
    setActionError(null);
    const result = await retryDeepMatchTask({ taskId: task.id });
    if (!result.success || !result.data?.task) {
      setActionError(
        !result.success ? (result.code ?? "ACTION_FAILED") : "ACTION_FAILED",
      );
      return;
    }
    setTask(result.data.task);
  };

  const selectedResult = useMemo(() => {
    if (!results || results.length === 0) return null;
    return (
      results.find((row) => row.id === selectedResultId) ??
      results.find((row) => !row.isStale) ??
      results[0]
    );
  }, [results, selectedResultId]);

  // A failed load must not render as "no task" — show the retry surface
  // whenever the server could not be reached, whatever loaded says.
  if (loadFailed) {
    return (
      <Alert variant="destructive" data-testid="deepmatch-load-error">
        <AlertTriangle />
        <AlertTitle>{t("deepMatch.loadFailed")}</AlertTitle>
        <AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("matchAnalysis.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!loaded) return null;

  return (
    <section className="space-y-3 rounded-lg border p-4" data-testid="deepmatch-section">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("deepMatch.title")}</p>
        <p className="text-xs text-muted-foreground">
          {t("deepMatch.description")}
        </p>
      </div>

      {resumeVersions.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="deepmatch-no-resume">
          {t("deepMatch.resumeEmpty")}
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="deepmatch-resume">
              {t("deepMatch.resumeLabel")}
            </Label>
            <Select
              value={versionId}
              onValueChange={setVersionId}
              disabled={active || starting}
            >
              <SelectTrigger id="deepmatch-resume" className="w-64 max-w-full">
                <SelectValue placeholder={t("deepMatch.resumePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {resumeVersions.map((version) => (
                  <SelectItem key={version.versionId} value={version.versionId}>
                    {`${version.variantName} · v${version.versionNumber}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            onClick={() => void onStart()}
            disabled={startDisabled}
            data-testid="deepmatch-start"
          >
            {starting ? (
              <>
                <Spinner className="mr-2" />
                {t("deepMatch.starting")}
              </>
            ) : (
              <>
                <Sparkles className="mr-2 h-4 w-4" />
                {t("deepMatch.start")}
              </>
            )}
          </Button>
        </div>
      )}
      {resumeVersions.length > 0 && !hasJobDescription && (
        <p className="text-sm text-muted-foreground">
          {t("matchAnalysis.jdMissingHint")}
        </p>
      )}

      {task && (
        <div
          className="space-y-2 rounded-md border px-3 py-2"
          data-testid="deepmatch-task"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                task.status === "SUCCEEDED"
                  ? "secondary"
                  : task.status === "FAILED"
                    ? "destructive"
                    : "outline"
              }
              data-testid="deepmatch-task-status"
            >
              {t(taskStatusKey(task))}
            </Badge>
            {task.status === "RUNNING" && task.recovered && (
              <Badge variant="outline" data-testid="deepmatch-recovered">
                {t("deepMatch.recovering")}
              </Badge>
            )}
            {task.status === "RUNNING" && task.currentStep && (
              <span
                className="text-xs text-muted-foreground"
                data-testid="deepmatch-task-step"
              >
                {t(`deepMatch.step.${task.currentStep}`)}
              </span>
            )}
            <span className="text-xs text-muted-foreground">
              {sourceLine(t, task.source)}
            </span>
          </div>

          {task.status === "CANCELLING" && (
            <p className="text-xs text-muted-foreground">
              {t("deepMatch.cancelPending")}
            </p>
          )}

          {task.status === "FAILED" && (
            <Alert variant="destructive" data-testid="deepmatch-task-error">
              <AlertTriangle />
              <AlertTitle>
                {t(deepMatchErrorKey(task.failureCode), {
                  code: task.failureCode ?? "UNKNOWN",
                })}
              </AlertTitle>
              <AlertDescription>
                {task.inputLost
                  ? t("deepMatch.inputLostHint")
                  : t("deepMatch.retryableHint")}
              </AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {(task.status === "QUEUED" || task.status === "RUNNING") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onCancel()}
                disabled={cancelling}
                data-testid="deepmatch-cancel"
              >
                {cancelling ? <Spinner className="mr-2" /> : null}
                {t("deepMatch.cancel")}
              </Button>
            )}
            {task.status === "SUCCEEDED" && task.resultAnalysisId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setSelectedResultId(task.resultAnalysisId)}
                data-testid="deepmatch-view-result"
              >
                {t("deepMatch.viewResult")}
              </Button>
            )}
            {(task.status === "CANCELLED" ||
              (task.status === "FAILED" && !task.inputLost)) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onRetry()}
                data-testid="deepmatch-retry"
              >
                {t("deepMatch.retry")}
              </Button>
            )}
          </div>
          {(task.status === "CANCELLED" ||
            (task.status === "FAILED" && !task.inputLost)) && (
            <p className="text-xs text-muted-foreground">
              {t("deepMatch.retryBillingNote")}
            </p>
          )}
        </div>
      )}

      {actionError && (
        <Alert variant="destructive" data-testid="deepmatch-action-error">
          <AlertTriangle />
          <AlertTitle>
            {t(deepMatchErrorKey(actionError), { code: actionError })}
          </AlertTitle>
        </Alert>
      )}

      <div className="space-y-2" data-testid="deepmatch-results">
        <p className="text-sm font-medium">{t("deepMatch.historyTitle")}</p>
        {!results || results.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("deepMatch.historyEmpty")}
          </p>
        ) : (
          <>
            <ul className="divide-y rounded-lg border">
              {results.map((row) => (
                <li key={row.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedResultId(row.id)}
                    className={cn(
                      "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted/50",
                      row.id === selectedResult?.id && "bg-muted/50",
                    )}
                    data-testid="deepmatch-history-item"
                  >
                    <span className="min-w-0 flex items-center gap-2">
                      <Badge variant="secondary" className="shrink-0">
                        {row.deepMatchDetail?.overallScore !== null &&
                        row.deepMatchDetail?.overallScore !== undefined
                          ? t("deepMatch.scoreLabel", {
                              score: row.deepMatchDetail.overallScore,
                            })
                          : t("deepMatch.scoreUnknown")}
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

            {selectedResult?.deepMatchDetail && (
              <div
                className="space-y-3 rounded-md border p-3"
                data-testid="deepmatch-result"
              >
                <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {selectedResult.isStale && (
                    <Badge variant="outline" data-testid="deepmatch-stale-badge">
                      {t("matchAnalysis.stale")}
                    </Badge>
                  )}
                  <span data-testid="deepmatch-result-source">
                    {sourceLine(t, selectedResult.source)}
                  </span>
                </div>
                {selectedResult.isStale &&
                  selectedResult.staleReasonCodes.length > 0 && (
                    <p className="text-sm text-muted-foreground">
                      {t("matchAnalysis.staleBecause", {
                        reasons: selectedResult.staleReasonCodes
                          .map((code) => t(`matchAnalysis.staleReasons.${code}`))
                          .join(", "),
                      })}
                    </p>
                  )}
                <div>
                  <p className="text-sm font-medium">
                    {t("deepMatch.sections.overallSummary")}
                  </p>
                  <p className="mt-1 whitespace-pre-wrap text-sm">
                    {selectedResult.deepMatchDetail.overallSummary}
                  </p>
                </div>
                {DETAIL_SECTIONS.map(({ key, labelKey }) => {
                  const text = selectedResult.deepMatchDetail?.[key];
                  if (!text) return null;
                  return (
                    <div key={key}>
                      <p className="text-sm font-medium">{t(labelKey)}</p>
                      <p className="mt-1 whitespace-pre-wrap text-sm">{text}</p>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  Link2,
  Pause,
  Play,
  RotateCcw,
  Square,
} from "lucide-react";
import {
  continueInterviewPrepGoal,
  createInterviewPrepGoal,
  endInterviewPrepGoal,
  getInterviewPrepGoalForJob,
  linkInterviewPrepSession,
  listLinkableInterviewPrepSessions,
  pauseInterviewPrepGoal,
  resumeInterviewPrepGoal,
  startNewInterviewPrepRound,
} from "@/actions/interviewPrep.actions";
import type {
  PrepGoalDTO,
  PrepLinkableSessionDTO,
  PrepNextAction,
} from "@/lib/interviewPrep/contract";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { toastError } from "@/lib/toast";
import { useI18n } from "@/i18n";

/**
 * Job-detail "Interview preparation" surface. Server-authoritative: every
 * load re-verifies progress from the real interview rows; the card itself
 * never calls a model, never creates a session on mount, and routes "继续
 * 准备" strictly by the server-verified nextAction.
 */
export function InterviewPrepSection({ jobId }: { jobId: string }) {
  const { t, formatDateTime } = useI18n();
  const router = useRouter();
  const [goal, setGoal] = useState<PrepGoalDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkables, setLinkables] = useState<PrepLinkableSessionDTO[] | null>(
    null,
  );
  const createKey = useRef<string>(crypto.randomUUID());
  const roundKey = useRef<string>(crypto.randomUUID());

  const load = useCallback(async () => {
    const result = await getInterviewPrepGoalForJob({ jobOpportunityId: jobId });
    if (!result.success) {
      // Restricted surface (capability gate) is a stable state, not a
      // transient failure — show the server's own denial, never a retry
      // loop that can never succeed in this runtime mode.
      if (result.code === "PREP_GOAL_UNAVAILABLE") {
        setUnavailable(result.message ?? null);
        return;
      }
      setLoadFailed(true);
      return;
    }
    setLoadFailed(false);
    setUnavailable(null);
    setLoaded(true);
    setGoal(result.data?.goal ?? null);
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  const errorText = (code: string | undefined, fallback: string | undefined) =>
    code && t(`interviewPrep.errors.${code}`) !== `interviewPrep.errors.${code}`
      ? t(`interviewPrep.errors.${code}`)
      : (fallback ?? t("interviewPrep.loadFailed"));

  const runMutation = async (
    kind: string,
    mutate: () => Promise<
      | { success: true; data?: { goal?: PrepGoalDTO | null } }
      | { success: false; message?: string; code?: string }
    >,
  ): Promise<PrepGoalDTO | null> => {
    setBusy(kind);
    setActionError(null);
    try {
      const result = await mutate();
      if (!result.success) {
        setActionError(errorText(result.code, result.message));
        return null;
      }
      const next = result.data?.goal ?? null;
      setGoal(next);
      return next;
    } finally {
      setBusy(null);
    }
  };

  const onCreate = async () => {
    const next = await runMutation("create", () =>
      createInterviewPrepGoal({
        jobOpportunityId: jobId,
        requestKey: createKey.current,
      }),
    );
    // Consume the key only after the intent succeeded: a retransmit of the
    // same intent must reuse it, the next explicit create mints a new one.
    if (next) createKey.current = crypto.randomUUID();
  };

  /** Route strictly by the server's freshly verified DTO — never the
   *  rendered goal, which may be an older round's stale closure. */
  const followAction = (target: PrepGoalDTO) => {
    const action = target.nextAction;
    if (action.kind === "START_PRACTICE") {
      router.push(
        `/dashboard/interview-prep/new?job=${target.jobOpportunityId}` +
          `&jd=${target.pinnedJd.versionId}&prepGoal=${target.id}`,
      );
      return true;
    }
    if (
      (action.kind === "OPEN_SESSION" || action.kind === "VIEW_SUMMARY") &&
      action.sessionId
    ) {
      router.push(`/dashboard/interview-prep/${action.sessionId}`);
      return true;
    }
    return false;
  };

  const runNewRound = async (from: PrepGoalDTO) => {
    const next = await runMutation("newRound", () =>
      startNewInterviewPrepRound({
        goalId: from.id,
        expectedRevision: from.revision,
        requestKey: roundKey.current,
      }),
    );
    if (next) {
      roundKey.current = crypto.randomUUID();
      followAction(next);
    }
  };

  const onContinue = async () => {
    if (!goal) return;
    // Re-verify at click time — a stale page can never run an old action.
    const fresh = await runMutation("continue", () =>
      continueInterviewPrepGoal({ goalId: goal.id }),
    );
    if (!fresh) return;
    if (followAction(fresh)) return;
    if (fresh.nextAction.kind === "RESUME_GOAL") {
      const resumed = await runMutation("resume", () =>
        resumeInterviewPrepGoal({
          goalId: fresh.id,
          expectedRevision: fresh.revision,
        }),
      );
      if (resumed) followAction(resumed);
      return;
    }
    if (fresh.nextAction.kind === "NEW_ROUND") {
      await runNewRound(fresh);
    }
  };

  const onPause = () =>
    goal &&
    runMutation("pause", () =>
      pauseInterviewPrepGoal({
        goalId: goal.id,
        expectedRevision: goal.revision,
      }),
    );
  const onResume = () =>
    goal &&
    runMutation("resume", () =>
      resumeInterviewPrepGoal({
        goalId: goal.id,
        expectedRevision: goal.revision,
      }),
    );
  const onEnd = () =>
    goal &&
    runMutation("end", () =>
      endInterviewPrepGoal({
        goalId: goal.id,
        expectedRevision: goal.revision,
      }),
    );

  const onOpenLinkPicker = async () => {
    if (!goal) return;
    setLinkOpen(true);
    setLinkables(null);
    const result = await listLinkableInterviewPrepSessions({ goalId: goal.id });
    setLinkables(result.success ? (result.data?.sessions ?? []) : []);
    if (!result.success) toastError(result.message);
  };

  const onLink = (sessionId: string) => {
    if (!goal) return;
    void runMutation("link", () =>
      linkInterviewPrepSession({
        goalId: goal.id,
        expectedRevision: goal.revision,
        sessionId,
      }),
    ).then((next) => {
      if (next) setLinkOpen(false);
    });
  };

  if (unavailable) {
    return (
      <Alert data-testid="prep-unavailable">
        <AlertTriangle />
        <AlertDescription>{unavailable}</AlertDescription>
      </Alert>
    );
  }

  if (loadFailed) {
    return (
      <Alert variant="destructive" data-testid="prep-load-failed">
        <AlertTriangle />
        <AlertTitle>{t("interviewPrep.loadFailed")}</AlertTitle>
        <AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("interviewPrep.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (!loaded) {
    return (
      <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
    );
  }

  const primaryLabel = (kind: PrepNextAction): string => {
    switch (kind) {
      case "VIEW_SUMMARY":
        return t("interviewPrep.viewSummary");
      case "RESUME_GOAL":
        return t("interviewPrep.resume");
      case "NEW_ROUND":
        return t("interviewPrep.newRound");
      default:
        return t("interviewPrep.continue");
    }
  };

  const actionable =
    goal != null &&
    ["START_PRACTICE", "OPEN_SESSION", "VIEW_SUMMARY", "RESUME_GOAL", "NEW_ROUND"].includes(
      goal.nextAction.kind,
    );

  return (
    <section className="space-y-4" data-testid="interview-prep-section">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-medium">{t("interviewPrep.title")}</h3>
        {goal && (
          <Badge
            variant={goal.status === "COMPLETED" ? "default" : "secondary"}
            data-testid="prep-status"
          >
            {t(`interviewPrep.status.${goal.status}`)}
          </Badge>
        )}
        {goal?.jobArchived && (
          <Badge variant="outline">{t("interviewPrep.blockers.JOB_ARCHIVED")}</Badge>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {t("interviewPrep.description")}
      </p>

      {!goal ? (
        <Button
          onClick={() => void onCreate()}
          disabled={busy !== null}
          data-testid="prep-create"
        >
          {busy === "create" ? (
            <>
              <Spinner className="mr-2" />
              {t("interviewPrep.creating")}
            </>
          ) : (
            t("interviewPrep.create")
          )}
        </Button>
      ) : (
        <>
          <div className="space-y-1 text-sm" data-testid="prep-source">
            {goal.jobTitle && <p>{t("interviewPrep.source.job", { title: goal.jobTitle })}</p>}
            <p className="text-muted-foreground">
              {goal.pinnedJd.versionNumber != null
                ? t("interviewPrep.source.pinnedJd", {
                    version: goal.pinnedJd.versionNumber,
                  })
                : t("interviewPrep.source.pinnedJdUnknown")}
            </p>
            {goal.jdDrift && (
              <p className="text-amber-600" data-testid="prep-jd-drift">
                {t("interviewPrep.source.jdDrift", {
                  pinned: goal.pinnedJd.versionNumber ?? "?",
                  current: goal.currentJd?.versionNumber ?? "?",
                })}
              </p>
            )}
          </div>

          {(goal.status === "PAUSED" || goal.status === "COMPLETED" || goal.status === "ENDED") && (
            <p className="text-sm text-muted-foreground" data-testid="prep-lifecycle-note">
              {goal.status === "PAUSED"
                ? t("interviewPrep.paused")
                : goal.status === "COMPLETED"
                  ? t("interviewPrep.completed")
                  : t("interviewPrep.ended")}
            </p>
          )}

          <div className="space-y-2" data-testid="prep-progress">
            <p className="text-sm font-medium">{t("interviewPrep.progress.title")}</p>
            <ul className="space-y-1">
              {goal.progress.completed.map((code) => (
                <li key={code} className="flex items-center gap-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                  <span>
                    {t(`interviewPrep.progress.${code}`, {
                      answered: goal.session?.answeredCount ?? 0,
                      total: goal.session?.questionsTotal ?? 0,
                    })}
                  </span>
                </li>
              ))}
              {goal.session && !goal.progress.completed.includes("PRACTICE_EVIDENCE_READY") && (
                <li className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Circle className="h-4 w-4" />
                  <span>
                    {t("interviewPrep.progress.answeredPartial", {
                      answered: goal.session.answeredCount,
                      total: goal.session.questionsTotal,
                    })}
                  </span>
                </li>
              )}
            </ul>
            {goal.progress.pending.length > 0 && (
              <>
                <p className="text-sm font-medium">{t("interviewPrep.pending.title")}</p>
                <ul className="space-y-1">
                  {goal.progress.pending.map((code) => (
                    <li key={code} className="flex items-center gap-2 text-sm">
                      <Circle className="h-4 w-4 text-muted-foreground" />
                      <span>{t(`interviewPrep.pending.${code}`)}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          {goal.blockers.length > 0 && (
            <Alert variant="destructive" data-testid="prep-blockers">
              <AlertTriangle />
              <AlertDescription>
                <ul className="space-y-1">
                  {goal.blockers.map((code) => (
                    <li key={code}>{t(`interviewPrep.blockers.${code}`)}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}
          {actionError && (
            <Alert variant="destructive" data-testid="prep-action-error">
              <AlertTriangle />
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          <p className="text-sm text-muted-foreground" data-testid="prep-next-action">
            {t(`interviewPrep.nextAction.${goal.nextAction.kind}`)}
          </p>

          {goal.session?.summaryReady && goal.session.summaryCompletedAt && (
            <p className="text-xs text-muted-foreground" data-testid="prep-summary-provenance">
              {t("interviewPrep.source.summaryProvenance", {
                date: formatDateTime(goal.session.summaryCompletedAt),
                model: "",
              })}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {actionable && (
              <Button
                onClick={() => void onContinue()}
                disabled={busy !== null}
                data-testid="prep-continue"
              >
                {busy !== null ? (
                  <>
                    <Spinner className="mr-2" />
                    {primaryLabel(goal.nextAction.kind)}
                  </>
                ) : goal.nextAction.kind === "OPEN_SESSION" ? (
                  <>
                    <Play className="mr-2 h-4 w-4" />
                    {primaryLabel(goal.nextAction.kind)}
                  </>
                ) : (
                  primaryLabel(goal.nextAction.kind)
                )}
              </Button>
            )}
            {goal.status === "ACTIVE" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onPause()}
                disabled={busy !== null}
                data-testid="prep-pause"
              >
                <Pause className="mr-1 h-4 w-4" />
                {t("interviewPrep.pause")}
              </Button>
            )}
            {goal.status === "PAUSED" && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void onResume()}
                disabled={busy !== null}
                data-testid="prep-resume"
              >
                <Play className="mr-1 h-4 w-4" />
                {t("interviewPrep.resume")}
              </Button>
            )}
            {!goal.session &&
              goal.status === "ACTIVE" &&
              !linkOpen && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void onOpenLinkPicker()}
                  disabled={busy !== null}
                  data-testid="prep-link-open"
                >
                  <Link2 className="mr-1 h-4 w-4" />
                  {t("interviewPrep.linkExisting")}
                </Button>
              )}
            {(goal.status === "ACTIVE" || goal.status === "PAUSED") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onEnd()}
                disabled={busy !== null}
                data-testid="prep-end"
              >
                <Square className="mr-1 h-4 w-4" />
                {t("interviewPrep.end")}
              </Button>
            )}
            {(goal.status === "COMPLETED" || goal.status === "ENDED") && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void runNewRound(goal)}
                disabled={busy !== null}
                data-testid="prep-new-round"
              >
                <RotateCcw className="mr-1 h-4 w-4" />
                {t("interviewPrep.newRound")}
              </Button>
            )}
          </div>

          {linkOpen && (
            <div className="rounded-lg border p-3 space-y-2" data-testid="prep-link-picker">
              {linkables === null ? (
                <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
              ) : linkables.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t("interviewPrep.linkPickerEmpty")}
                </p>
              ) : (
                <ul className="divide-y">
                  {linkables.map((session) => (
                    <li
                      key={session.id}
                      className="flex items-center justify-between gap-3 py-2 text-sm"
                    >
                      <span className="text-muted-foreground">
                        {formatDateTime(session.createdAt)}
                        {" · "}
                        {session.coachingMode}
                        {" · "}
                        {t("interviewPrep.progress.answeredPartial", {
                          answered: session.answeredCount,
                          total: session.questionsTotal,
                        })}
                      </span>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onLink(session.id)}
                        disabled={busy !== null}
                        data-testid={`prep-link-${session.id}`}
                      >
                        {t("interviewPrep.linkConfirm")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

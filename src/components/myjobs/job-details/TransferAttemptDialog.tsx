"use client";
import { useEffect, useState, useTransition } from "react";
import { Loader } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { listTransferTargetOpportunities } from "@/actions/application.actions";
import type {
  ApplicationAttemptTimelineDTO,
  TransferTargetOpportunityDTO,
} from "@/lib/career/applicationTimeline";
import { useI18n } from "@/i18n";
import type { Locale } from "@/i18n";

// INT-01 owns the shared message bundles; until the declared keys land,
// t() echoes the key and the paired fallback keeps the page readable.
function useCopy() {
  const { t, locale } = useI18n();
  return (key: string, fallback: Record<Locale, string>) => {
    const translated = t(key);
    return translated === key ? fallback[locale] : translated;
  };
}

type TransferAttemptDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sourceAttempt: ApplicationAttemptTimelineDTO | null;
  excludeJobOpportunityId: string;
  onSubmit: (targetJobOpportunityId: string) => Promise<boolean>;
};

export function TransferAttemptDialog({
  open,
  onOpenChange,
  sourceAttempt,
  excludeJobOpportunityId,
  onSubmit,
}: TransferAttemptDialogProps) {
  const { t } = useI18n();
  const copy = useCopy();
  const [isPending, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [targets, setTargets] = useState<TransferTargetOpportunityDTO[]>([]);
  const [targetId, setTargetId] = useState("");
  const [offset, setOffset] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) setOffset(0);
  }, [open]);

  useEffect(() => {
    if (!open || !sourceAttempt) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setFormError(null);
    setTargets([]);
    setTargetId("");

    void listTransferTargetOpportunities(excludeJobOpportunityId, offset)
      .then((result) => {
        if (cancelled) return;
        if (!result.success) {
          setLoadError(result.message);
          setLoading(false);
          return;
        }
        setTargets(result.data?.items ?? []);
        setNextOffset(result.data?.nextOffset ?? null);
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setLoadError(
          copy("jobs.transferTargetsLoadFailed", {
            "zh-CN": "目标职位列表加载失败，请关闭后重试。",
            en: "Failed to load positions. Please close and try again.",
          }),
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // The target list only needs reloading when the dialog is (re)opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sourceAttempt, excludeJobOpportunityId, offset]);

  // A target list refresh can invalidate a selection made before the
  // refresh: clear it so the transfer never silently lands elsewhere.
  useEffect(() => {
    if (!open || targets.length === 0) return;
    if (targetId && !targets.some((target) => target.id === targetId)) {
      setTargetId("");
    }
  }, [open, targets, targetId]);

  const onConfirm = () => {
    if (isPending) return;
    if (!targetId) {
      setFormError(
        copy("jobs.transferTargetRequired", {
          "zh-CN": "请选择要转投到的职位。",
          en: "Select the position to transfer to.",
        }),
      );
      return;
    }
    setFormError(null);
    startTransition(async () => {
      const ok = await onSubmit(targetId);
      if (ok) onOpenChange(false);
    });
  };

  const targetLabel = (target: TransferTargetOpportunityDTO) =>
    target.company ? `${target.title} · ${target.company}` : target.title;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isPending) onOpenChange(next); }}>
      <DialogContent
        className="sm:max-w-[480px]"
        data-testid="transfer-attempt-dialog"
      >
        <DialogHeader>
          <DialogTitle>
            {copy("jobs.transferTitle", {
              "zh-CN": "转投申请",
              en: "Transfer application",
            })}
          </DialogTitle>
          <DialogDescription>
            {copy("jobs.transferDescription", {
              "zh-CN":
                "把本轮投递转投到另一个职位。当前轮次会标记为已转投，历史记录保留在本职位。",
              en: "Move this application to another position. This round is marked as transferred and its history stays here.",
            })}
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="transfer-targets-loading"
          >
            {t("common.loading")}
          </p>
        ) : loadError ? (
          <p
            className="text-sm text-destructive"
            data-testid="transfer-targets-error"
          >
            {loadError}
          </p>
        ) : targets.length === 0 ? (
          <p
            className="text-sm text-muted-foreground"
            data-testid="transfer-targets-empty"
          >
            {copy("jobs.transferNoTargets", {
              "zh-CN": "没有其他可转投的职位。",
              en: "No other positions to transfer to.",
            })}
          </p>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="transfer-target">
              {copy("jobs.transferTarget", {
                "zh-CN": "目标职位",
                en: "Target position",
              })}
            </Label>
            <select
              id="transfer-target"
              value={targetId}
              onChange={(event) => {
                setTargetId(event.target.value);
                setFormError(null);
              }}
              className="h-9 w-full max-w-full rounded-md border bg-background px-2 text-sm"
              data-testid="transfer-target-select"
            >
              <option value="">
                {copy("jobs.transferTargetPlaceholder", {
                  "zh-CN": "选择目标职位",
                  en: "Select a position",
                })}
              </option>
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {targetLabel(target)}
                </option>
              ))}
            </select>
            {formError ? (
              <p
                className="text-sm text-destructive"
                data-testid="transfer-target-error"
              >
                {formError}
              </p>
            ) : null}
          </div>
        )}
        <div className="flex gap-2">
          {offset > 0 && (
            <Button type="button" variant="outline" disabled={loading || isPending}
              onClick={() => setOffset(Math.max(0, offset - 200))}>
              {copy("jobs.transferPreviousPage", { "zh-CN": "上一页", en: "Previous page" })}
            </Button>
          )}
          {nextOffset !== null && (
            <Button type="button" variant="outline" disabled={loading || isPending}
              onClick={() => setOffset(nextOffset)}>
              {copy("jobs.transferNextPage", { "zh-CN": "下一页", en: "Next page" })}
            </Button>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
          >
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={isPending || loading || targets.length === 0}
            data-testid="transfer-attempt-confirm"
          >
            {copy("jobs.transferConfirm", {
              "zh-CN": "确认转投",
              en: "Transfer",
            })}
            {isPending && (
              <Loader className="ml-2 h-4 w-4 shrink-0 spinner" />
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

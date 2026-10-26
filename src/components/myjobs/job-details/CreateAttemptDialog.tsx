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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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

export type CreateAttemptFormValues = {
  channelLabel: string;
  channelCategory: string | null;
  sourceUrl: string | null;
  notes: string | null;
};

type CreateAttemptDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (values: CreateAttemptFormValues) => Promise<boolean>;
};

export function CreateAttemptDialog({
  open,
  onOpenChange,
  onSubmit,
}: CreateAttemptDialogProps) {
  const { t } = useI18n();
  const copy = useCopy();
  const [isPending, startTransition] = useTransition();
  const [channelLabel, setChannelLabel] = useState("");
  const [channelCategory, setChannelCategory] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [notes, setNotes] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setChannelLabel("");
    setChannelCategory("");
    setSourceUrl("");
    setNotes("");
    setFormError(null);
  }, [open]);

  const onSave = () => {
    if (isPending) return;
    if (!channelLabel.trim()) {
      setFormError(
        copy("jobs.attemptChannelRequired", {
          "zh-CN": "请填写投递渠道。",
          en: "Channel is required.",
        }),
      );
      return;
    }
    setFormError(null);
    const optional = (value: string) => {
      const trimmed = value.trim();
      return trimmed === "" ? null : trimmed;
    };
    startTransition(async () => {
      const ok = await onSubmit({
        channelLabel: channelLabel.trim(),
        channelCategory: optional(channelCategory),
        sourceUrl: optional(sourceUrl),
        notes: optional(notes),
      });
      if (ok) onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isPending) onOpenChange(next); }}>
      <DialogContent className="sm:max-w-[420px]">
        <DialogHeader>
          <DialogTitle>
            {copy("jobs.addAttemptTitle", {
              "zh-CN": "新建投递轮次",
              en: "New application",
            })}
          </DialogTitle>
          <DialogDescription>
            {copy("jobs.addAttemptDescription", {
              "zh-CN": "为该职位再建一轮投递；之后添加的事件可以归属到这一轮。",
              en: "Create another application round for this position. Events you add later can be assigned to it.",
            })}
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
          className="space-y-4"
        >
          <div className="space-y-2">
            <Label htmlFor="attempt-channel">{t("jobs.attemptChannel")}</Label>
            <Input
              id="attempt-channel"
              value={channelLabel}
              onChange={(event) => setChannelLabel(event.target.value)}
              placeholder={copy("jobs.attemptChannelPlaceholder", {
                "zh-CN": "例如：官网、内推、BOSS直聘",
                en: "e.g. Careers page, referral",
              })}
              data-testid="attempt-channel-input"
            />
            {formError ? (
              <p
                className="text-sm text-destructive"
                data-testid="attempt-channel-error"
              >
                {formError}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="attempt-channel-category">
              {copy("jobs.attemptChannelCategory", {
                "zh-CN": "渠道类型（可选）",
                en: "Channel type (optional)",
              })}
            </Label>
            <Input
              id="attempt-channel-category"
              value={channelCategory}
              onChange={(event) => setChannelCategory(event.target.value)}
              placeholder={copy("jobs.attemptChannelCategoryPlaceholder", {
                "zh-CN": "例如：招聘网站、猎头",
                en: "e.g. Job board, recruiter",
              })}
              data-testid="attempt-channel-category-input"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="attempt-source-url">
              {copy("jobs.attemptSourceUrl", {
                "zh-CN": "职位链接（可选）",
                en: "Listing URL (optional)",
              })}
            </Label>
            <Input
              id="attempt-source-url"
              value={sourceUrl}
              onChange={(event) => setSourceUrl(event.target.value)}
              placeholder="https://"
              data-testid="attempt-source-url-input"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="attempt-notes">
              {copy("jobs.attemptNotes", {
                "zh-CN": "备注（可选）",
                en: "Notes (optional)",
              })}
            </Label>
            <Textarea
              id="attempt-notes"
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              data-testid="attempt-notes-input"
            />
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
              type="submit"
              disabled={isPending}
              data-testid="create-attempt-save"
            >
              {t("common.save")}
              {isPending && (
                <Loader className="ml-2 h-4 w-4 shrink-0 spinner" />
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

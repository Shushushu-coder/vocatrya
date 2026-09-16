"use client";

import { FileText, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TipTapContentViewer } from "@/components/TipTapContentViewer";
import type { CoverLetter } from "@/models/profile.model";
import { JobTabEmptyState } from "./JobTabEmptyState";
import { useI18n } from "@/i18n";

type CoverLetterTabProps = {
  letter?: CoverLetter;
  blockedReason?: string;
  onGenerate: () => void;
};

export function CoverLetterTab({
  letter,
  blockedReason,
  onGenerate,
}: CoverLetterTabProps) {
  const { t, formatDate } = useI18n();

  if (!letter) {
    return (
      <JobTabEmptyState
        icon={FileText}
        title={t("jobs.noCoverLetterYet")}
        description={t("jobs.noCoverLetterDescription")}
        actionLabel={t("jobs.generateCoverLetter")}
        onAction={onGenerate}
        actionDisabled={!!blockedReason}
        actionTitle={blockedReason}
      />
    );
  }

  const generatedAt = letter.updatedAt ?? letter.createdAt;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-xs text-muted-foreground">
          {letter.title}
          {generatedAt &&
            ` · ${t("jobs.generatedAt", { date: formatDate(generatedAt) })}`}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="ml-auto cursor-pointer"
          onClick={onGenerate}
          disabled={!!blockedReason}
          title={blockedReason}
        >
          <Sparkles className="h-4 w-4 mr-2" />
          {t("jobs.regenerate")}
        </Button>
      </div>
      <TipTapContentViewer content={letter.content} />
    </div>
  );
}

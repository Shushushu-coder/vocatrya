"use client";

import { useMemo, useState } from "react";
import MarkdownIt from "markdown-it";
import { ChevronDown, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { TipTapContentViewer } from "@/components/TipTapContentViewer";
import { AgentReviewScoreCard } from "@/components/agent/AgentReviewScoreCard";
import type { ResumeReviewData } from "@/models/ai.schemas";
import { useI18n } from "@/i18n";

// html:false escapes any raw HTML in the model output; TipTapContentViewer
// further strips unrecognized tags, so the rendered review is safe.
const md = new MarkdownIt({ html: false, linkify: false, breaks: true });

interface ReviewDetailsProps {
  reviewData: ResumeReviewData | null;
}

export function ReviewDetails({ reviewData }: ReviewDetailsProps) {
  const { t, formatDateTime } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const html = useMemo(
    () => (reviewData?.body ? md.render(reviewData.body) : ""),
    [reviewData?.body],
  );

  if (!reviewData) return null;

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded}>
      <div className="space-y-3">
        <AgentReviewScoreCard scores={reviewData} size={130} />
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {reviewData.reviewedAt ? (
            <span>
              {t("profile.reviewedOn", {
                date: formatDateTime(new Date(reviewData.reviewedAt)),
              })}
            </span>
          ) : null}
          {reviewData.provider === "mcp"
            ? reviewData.model && (
                <Badge className="gap-1 bg-violet-500 dark:bg-violet-400">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("profile.viaModel", { model: reviewData.model })}
                </Badge>
              )
            : reviewData.provider
              ? reviewData.model
                ? t("profile.usingProviderModel", {
                    provider: reviewData.provider,
                    model: reviewData.model,
                  })
                : t("profile.usingProvider", {
                    provider: reviewData.provider,
                  })
              : null}
        </div>
      </div>

      <CollapsibleTrigger asChild>
        <Button variant="ghost" size="sm" className="mt-2 h-7 px-2 text-xs">
          {expanded
            ? t("profile.hideFullReview")
            : t("profile.showFullReview")}
          <ChevronDown
            className={`ml-1 h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
        </Button>
      </CollapsibleTrigger>

      <CollapsibleContent>
        {html && (
          <div className="mt-3 text-sm leading-relaxed [&_p]:mt-2 [&_ul]:mt-2 [&_ol]:mt-2 [&_h2]:mt-4 [&_h2]:font-semibold">
            <TipTapContentViewer content={html} />
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

"use client";

import { useState } from "react";
import Link from "next/link";
import { XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/context";
import {
  MAX_VISIBLE_ERROR_NOTICES,
  dismissErrorNotice,
  useErrorNotices,
  type ErrorNotice,
} from "@/lib/errorNotices";

function NoticeCard({ notice }: { notice: ErrorNotice }) {
  const { t } = useI18n();
  const [showDetails, setShowDetails] = useState(false);
  const recovered = notice.status === "recovered";
  return (
    <Alert
      variant={recovered ? "default" : "destructive"}
      className="pointer-events-auto flex items-start gap-2 bg-background shadow-md"
      data-testid="error-notice"
      data-kind={notice.kind}
      data-status={notice.status}
    >
      <AlertDescription className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {notice.title}
          {recovered ? ` · ${t("common.errorNoticeRecovered")}` : null}
          {!recovered && notice.count > 1 ? (
            <span className="ml-1 text-xs font-normal">
              {t("common.errorNoticeRepeated", { count: notice.count })}
            </span>
          ) : null}
        </p>
        {notice.message ? <p>{notice.message}</p> : null}
        {showDetails && notice.details ? (
          <p className="break-words text-xs">{notice.details}</p>
        ) : null}
        {!recovered && (notice.details || notice.onRetry || notice.action) ? (
          <span className="flex flex-wrap items-center gap-2 pt-1">
            {notice.details ? (
              <Button
                className="h-7 px-2 text-xs"
                onClick={() => setShowDetails((v) => !v)}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("common.details")}
              </Button>
            ) : null}
            {notice.action ? (
              <Button
                asChild
                className="h-7 px-2 text-xs"
                size="sm"
                variant="outline"
              >
                <Link href={notice.action.href}>{notice.action.label}</Link>
              </Button>
            ) : null}
            {notice.onRetry ? (
              <Button
                className="h-7 px-2 text-xs"
                onClick={notice.onRetry}
                size="sm"
                type="button"
                variant="outline"
              >
                {t("common.retry")}
              </Button>
            ) : null}
          </span>
        ) : null}
      </AlertDescription>
      <Button
        aria-label={t("common.dismissError")}
        className="size-6 shrink-0"
        onClick={() => dismissErrorNotice(notice.kind)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    </Alert>
  );
}

// Top-left of the main content area. Zero-height sticky anchor so it floats
// over page content without covering navigation or shifting layout. Static on
// purpose (no enter/exit animation), so reduced-motion needs no special case.
export function ErrorNoticeHost() {
  const { t } = useI18n();
  const notices = useErrorNotices();
  const [expanded, setExpanded] = useState(false);
  if (notices.length === 0) return null;
  const visible = expanded
    ? notices
    : notices.slice(0, MAX_VISIBLE_ERROR_NOTICES);
  const hidden = notices.length - MAX_VISIBLE_ERROR_NOTICES;
  return (
    <div
      className="pointer-events-none sticky top-2 z-30 h-0"
      role="region"
      aria-label={t("common.errorNoticeRegion")}
    >
      <div className="absolute left-0 top-0 flex w-full max-w-sm flex-col gap-2">
        {visible.map((n) => (
          <NoticeCard key={n.kind} notice={n} />
        ))}
        {hidden > 0 ? (
          <Button
            className="pointer-events-auto h-7 self-start bg-background px-2 text-xs"
            onClick={() => setExpanded((v) => !v)}
            size="sm"
            type="button"
            variant="outline"
          >
            {expanded
              ? t("common.errorNoticeCollapse")
              : t("common.errorNoticeMore", { count: hidden })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

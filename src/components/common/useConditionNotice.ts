"use client";

import { useEffect } from "react";
import {
  reportErrorNotice,
  resolveErrorNotice,
  type ErrorNoticeInput,
} from "@/lib/errorNotices";

// Mirrors a persistent, recoverable condition that the app already learned
// from an existing status read into the top-left error notice host. No
// polling here: it only reacts to `active` changing. `null` means "not yet
// checked" and does nothing (so an unread status never reads as recovered).
export function useConditionNotice(
  active: boolean | null,
  notice: ErrorNoticeInput,
) {
  const { kind, title, message } = notice;
  const href = notice.action?.href;
  const label = notice.action?.label;
  useEffect(() => {
    if (active === null) return;
    if (active) {
      reportErrorNotice({
        kind,
        title,
        message,
        action: href && label ? { href, label } : undefined,
      });
    } else {
      resolveErrorNotice(kind);
    }
  }, [active, kind, title, message, href, label]);
}

"use client";

import { useConditionNotice } from "@/components/common/useConditionNotice";
import { useI18n } from "@/i18n";

export const NOTION_REAUTH_NOTICE_KIND = "extension-notion:REAUTH_REQUIRED";

// Renders nothing. `status` is the Notion connection status the caller has
// just read (server page state or client refresh/verify); null = unknown.
export function NotionStatusNotice({ status }: { status: string | null }) {
  const { t } = useI18n();
  useConditionNotice(status === null ? null : status === "REAUTH_REQUIRED", {
    kind: NOTION_REAUTH_NOTICE_KIND,
    title: t("common.errorNoticeNotionReauthTitle"),
    message: t("common.errorNoticeNotionReauthMessage"),
    action: {
      label: t("common.errorNoticeReconnect"),
      href: "/dashboard/extensions/notion",
    },
  });
  return null;
}

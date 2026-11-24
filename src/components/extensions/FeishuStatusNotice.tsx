"use client";

import { useConditionNotice } from "@/components/common/useConditionNotice";
import { useI18n } from "@/i18n";

export const FEISHU_REAUTH_NOTICE_KIND = "extension-feishu:REAUTH_REQUIRED";

// Renders nothing. `status` is the Feishu connection status the caller has
// just read (server page state or client refresh/verify); null = unknown.
export function FeishuStatusNotice({ status }: { status: string | null }) {
  const { t } = useI18n();
  useConditionNotice(status === null ? null : status === "REAUTH_REQUIRED", {
    kind: FEISHU_REAUTH_NOTICE_KIND,
    title: t("common.errorNoticeFeishuReauthTitle"),
    message: t("common.errorNoticeFeishuReauthMessage"),
    action: {
      label: t("common.errorNoticeReconnect"),
      href: "/dashboard/extensions/feishu",
    },
  });
  return null;
}

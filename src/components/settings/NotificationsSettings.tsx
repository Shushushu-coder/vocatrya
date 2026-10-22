"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/i18n";
import type { Locale } from "@/i18n";
import { Badge } from "../ui/badge";

// INT-01 owns the shared message bundles; until the declared keys land,
// t() echoes the key and the paired fallback keeps the page readable.
function useCopy() {
  const { t, locale } = useI18n();
  return (key: string, fallback: Record<Locale, string>) => {
    const translated = t(key);
    return translated === key ? fallback[locale] : translated;
  };
}

function SettingRow({
  name,
  description,
  aside,
}: {
  name: string;
  description: string;
  aside: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3">
      <div className="min-w-0 flex-1 basis-56">
        <div className="text-sm font-medium leading-none break-words">
          {name}
        </div>
        <p className="mt-1 text-sm text-muted-foreground break-words">
          {description}
        </p>
      </div>
      <div className="shrink-0">{aside}</div>
    </div>
  );
}

// Audited at baseline 59499771: no `new Notification`, no Electron
// Notification module, no toast→OS bridge anywhere in the repo. The only
// feedback surface is the in-app sonner toaster mounted in the root layout.
// This page therefore lists exactly what exists and states what does not —
// no toggles are offered for capabilities that have no backend.
function NotificationsSettings() {
  const copy = useCopy();

  return (
    <div className="space-y-4" data-testid="notifications-settings">
      <div>
        <h3 className="text-lg font-medium">
          {copy("settings.notifications", {
            "zh-CN": "通知",
            en: "Notifications",
          })}
        </h3>
        <p className="text-sm text-muted-foreground break-words">
          {copy("settings.notificationsDescription", {
            "zh-CN":
              "当前版本没有系统通知事件，也没有可配置的通知偏好。此处如实列出与通知相关的真实能力。",
            en: "This version has no system notification events and no configurable notification preferences. The real capabilities related to notifications are listed below.",
          })}
        </p>
      </div>

      <div className="divide-y">
        <SettingRow
          name={copy("settings.notificationsInAppTitle", {
            "zh-CN": "应用内消息反馈",
            en: "In-app feedback messages",
          })}
          description={copy("settings.notificationsInAppDescription", {
            "zh-CN":
              "操作结果与错误提示以应用内浮动消息（toast）即时显示。这是内置反馈机制，不属于可配置项。",
            en: "Action results and error messages appear as in-app toast messages. This is a built-in feedback mechanism, not a configurable option.",
          })}
          aside={
            <Badge variant="secondary">
              {copy("settings.capabilityBuiltIn", {
                "zh-CN": "内置",
                en: "Built-in",
              })}
            </Badge>
          }
        />
        <SettingRow
          name={copy("settings.notificationsSystemTitle", {
            "zh-CN": "系统通知",
            en: "System notifications",
          })}
          description={copy("settings.notificationsSystemDescription", {
            "zh-CN":
              "未提供——应用未注册任何系统通知事件（无 Windows 通知集成），因此没有可开启或关闭的通知选项。",
            en: "Not provided — the app registers no system notification events (no Windows notification integration), so there is nothing to turn on or off.",
          })}
          aside={
            <Badge variant="outline">
              {copy("settings.capabilityNotProvided", {
                "zh-CN": "未提供",
                en: "Not provided",
              })}
            </Badge>
          }
        />
        <SettingRow
          name={copy("settings.notificationsPreferencesTitle", {
            "zh-CN": "通知偏好",
            en: "Notification preferences",
          })}
          description={copy("settings.notificationsPreferencesDescription", {
            "zh-CN":
              "未提供——没有真实的通知事件，因此不存在可保存的通知偏好。",
            en: "Not provided — with no real notification events there is no preference to store.",
          })}
          aside={
            <Badge variant="outline">
              {copy("settings.capabilityNotProvided", {
                "zh-CN": "未提供",
                en: "Not provided",
              })}
            </Badge>
          }
        />
      </div>

      <p className="text-sm text-muted-foreground break-words">
        {copy("settings.notificationsFootnote", {
          "zh-CN":
            "接入真实通知事件后，本页才会提供对应的可配置项；操作结果与关键错误反馈始终显示在当前任务界面。",
          en: "Configurable options will appear here only after real notification events are integrated. Action results and critical error feedback always stay visible in the current task view.",
        })}
      </p>
    </div>
  );
}

export default NotificationsSettings;

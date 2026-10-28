"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { useI18n } from "@/i18n";
import type { Locale } from "@/i18n";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { toastError } from "@/lib/toast";
import {
  getUserSettings,
  updateNotificationSettings,
} from "@/actions/userSettings.actions";
import {
  DEFAULT_NOTIFICATION_LEAD_MINUTES,
  isNotificationLeadMinutes,
  NOTIFICATION_LEAD_MINUTES_OPTIONS,
} from "@/lib/reminders/shared";
import {
  SaveStatusProvider,
  useSaveStatus,
} from "@/context/SaveStatusContext";
import { SaveStatusIndicator } from "@/components/SaveStatusIndicator";

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

function NotificationsSettings() {
  return (
    <SaveStatusProvider>
      <NotificationsSettingsPanel />
    </SaveStatusProvider>
  );
}

// One intent carries the whole preference snapshot: the switch and the lead
// select patch the same settings.notifications subtree, so a single queued
// write keeps them ordered on the CAS token — same serial-pump pattern as
// GeneralSettings.
type SaveIntent = { enabled: boolean; leadMinutes: number };

const LEAD_OPTION_KEYS: Record<number, Record<Locale, string>> = {
  0: { "zh-CN": "准时", en: "On time" },
  15: { "zh-CN": "提前 15 分钟", en: "15 minutes before" },
  30: { "zh-CN": "提前 30 分钟", en: "30 minutes before" },
  60: { "zh-CN": "提前 1 小时", en: "1 hour before" },
  120: { "zh-CN": "提前 2 小时", en: "2 hours before" },
  1440: { "zh-CN": "提前 1 天", en: "1 day before" },
};

function NotificationsSettingsPanel() {
  const copy = useCopy();
  const { t, locale } = useI18n();
  const { begin, finish } = useSaveStatus();
  const [isLoading, setIsLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [leadMinutes, setLeadMinutes] = useState<number>(
    DEFAULT_NOTIFICATION_LEAD_MINUTES,
  );

  // `confirmed` is the last snapshot the server actually persisted;
  // `selection` mirrors what the user is looking at. They diverge while a
  // save is in flight and again after a failed save rolls back.
  const confirmedRef = useRef<SaveIntent>({
    enabled: true,
    leadMinutes: DEFAULT_NOTIFICATION_LEAD_MINUTES,
  });
  const selectionRef = useRef<SaveIntent>(confirmedRef.current);
  const pendingIntentRef = useRef<SaveIntent[]>([]);
  const pumpingRef = useRef(false);
  const copyRef = useRef(copy);
  copyRef.current = copy;

  const applySelection = useCallback((value: SaveIntent) => {
    selectionRef.current = value;
    setEnabled(value.enabled);
    setLeadMinutes(value.leadMinutes);
  }, []);

  const queueSave = useCallback(() => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    void (async () => {
      try {
        while (pendingIntentRef.current.length > 0) {
          const intent = pendingIntentRef.current.shift()!;
          const seq = begin();
          let persisted = false;
          try {
            const result = await updateNotificationSettings(intent);
            // "Saved" requires the persisted document to echo the intent
            // back — a bare success flag alone is not proof.
            const written =
              result?.data?.settings?.settings?.notifications;
            persisted =
              result?.success === true &&
              written?.enabled === intent.enabled &&
              written?.leadMinutes === intent.leadMinutes;
          } catch (error) {
            console.error("Error saving notification settings:", error);
          }
          finish(seq, persisted);
          if (persisted) {
            confirmedRef.current = intent;
          } else {
            toastError(
              copyRef.current("common.saveFailed", {
                "zh-CN": "保存失败，请重试。",
                en: "Save failed. Please try again.",
              }),
            );
            // Roll back only when no newer intent is queued — a fresh
            // selection must not be reverted by this stale failure.
            if (
              pendingIntentRef.current.length === 0 &&
              selectionRef.current === intent
            ) {
              applySelection(confirmedRef.current);
            }
          }
        }
      } finally {
        pumpingRef.current = false;
      }
    })();
  }, [applySelection, begin, finish]);

  const handleToggle = useCallback(
    (nextEnabled: boolean) => {
      const intent = { ...selectionRef.current, enabled: nextEnabled };
      applySelection(intent);
      pendingIntentRef.current.push(intent);
      queueSave();
    },
    [applySelection, queueSave],
  );

  const handleLeadChange = useCallback(
    (value: string) => {
      const next = Number(value);
      if (!isNotificationLeadMinutes(next)) return;
      const intent = { ...selectionRef.current, leadMinutes: next };
      applySelection(intent);
      pendingIntentRef.current.push(intent);
      queueSave();
    },
    [applySelection, queueSave],
  );

  useEffect(() => {
    let cancelled = false;
    const baseline = selectionRef.current;
    const fetchSettings = async () => {
      setIsLoading(true);
      try {
        const result = await getUserSettings();
        const written = result?.data?.settings?.settings?.notifications;
        if (cancelled) return;
        if (result?.success === true) {
          const persisted: SaveIntent = {
            enabled:
              typeof written?.enabled === "boolean" ? written.enabled : true,
            leadMinutes: isNotificationLeadMinutes(written?.leadMinutes)
              ? written.leadMinutes
              : DEFAULT_NOTIFICATION_LEAD_MINUTES,
          };
          confirmedRef.current = persisted;
          // Reconcile only when the user has not moved on since the read
          // started — a late read must never override a fresher choice.
          if (
            pendingIntentRef.current.length === 0 &&
            selectionRef.current === baseline &&
            (persisted.enabled !== baseline.enabled ||
              persisted.leadMinutes !== baseline.leadMinutes)
          ) {
            applySelection(persisted);
          }
        } else {
          confirmedRef.current = baseline;
        }
      } catch (error) {
        console.error("Error fetching notification settings:", error);
        if (!cancelled) confirmedRef.current = selectionRef.current;
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };
    fetchSettings();
    return () => {
      cancelled = true;
    };
  }, [applySelection]);

  const handleTestNotification = useCallback(async () => {
    const copy = copyRef.current;
    if (typeof Notification === "undefined") {
      toastError(
        copy("settings.notificationsTestUnsupported", {
          "zh-CN": "当前环境不支持系统通知。",
          en: "This environment does not support system notifications.",
        }),
      );
      return;
    }
    if (Notification.permission === "default") {
      await Notification.requestPermission().catch(() => undefined);
    }
    if (Notification.permission !== "granted") {
      toastError(
        copy("settings.notificationsTestDenied", {
          "zh-CN":
            "系统通知权限未授予。请在系统或应用权限设置中允许通知后重试。",
          en: "Notification permission was not granted. Allow notifications in the system or app permission settings, then retry.",
        }),
      );
      return;
    }
    try {
      new Notification(
        copy("settings.notificationsTestTitle", {
          "zh-CN": "测试通知",
          en: "Test notification",
        }),
        {
          body: copy("settings.notificationsTestBody", {
            "zh-CN": "提醒将以这种形式送达。",
            en: "Reminders will be delivered like this.",
          }),
        },
      );
    } catch {
      toastError(
        copy("settings.notificationsTestFailed", {
          "zh-CN": "测试通知发送失败，请重试。",
          en: "Failed to send the test notification. Please try again.",
        }),
      );
    }
  }, []);

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="notifications-settings">
        <div>
          <h3 className="text-lg font-medium">
            {copy("settings.notifications", {
              "zh-CN": "通知",
              en: "Notifications",
            })}
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("settings.loadingSettings")}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="notifications-settings">
      <div className="flex items-center gap-2">
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
                "日程提醒以 Windows 系统通知送达；应用内消息反馈为内置机制。",
              en: "Schedule reminders arrive as Windows system notifications; in-app feedback messages are built in.",
            })}
          </p>
        </div>
        <SaveStatusIndicator />
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
              "流程步骤排期与岗位截止在到期时通过 Windows 系统通知提醒。应用运行（含最小化或托盘隐藏）时送达；完全退出后不再送达。",
            en: "Process-step schedules and job deadlines raise a Windows system notification when due. Delivered while the app is running (including minimized or hidden to tray); not delivered after a full quit.",
          })}
          aside={
            <Switch
              checked={enabled}
              onCheckedChange={handleToggle}
              aria-label={copy("settings.notificationsSystemTitle", {
                "zh-CN": "系统通知",
                en: "System notifications",
              })}
              data-testid="notifications-enabled-switch"
            />
          }
        />
        <SettingRow
          name={copy("settings.notificationsPreferencesTitle", {
            "zh-CN": "通知偏好",
            en: "Notification preferences",
          })}
          description={copy("settings.notificationsPreferencesDescription", {
            "zh-CN": "选择提醒相对日程时间的提前量。",
            en: "Choose how far ahead of the scheduled time reminders fire.",
          })}
          aside={
            <Select
              value={String(leadMinutes)}
              onValueChange={handleLeadChange}
            >
              <SelectTrigger
                className="w-full max-w-44"
                aria-label={copy("settings.notificationsPreferencesTitle", {
                  "zh-CN": "通知偏好",
                  en: "Notification preferences",
                })}
                data-testid="notifications-lead-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NOTIFICATION_LEAD_MINUTES_OPTIONS.map((minutes) => (
                  <SelectItem key={minutes} value={String(minutes)}>
                    {LEAD_OPTION_KEYS[minutes]?.[locale] ??
                      LEAD_OPTION_KEYS[minutes]?.["zh-CN"] ??
                      String(minutes)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          name={copy("settings.notificationsTestRowTitle", {
            "zh-CN": "测试通知",
            en: "Test notification",
          })}
          description={copy("settings.notificationsTestDescription", {
            "zh-CN": "立即发送一条系统通知，确认权限与送达正常。",
            en: "Send a system notification now to confirm permission and delivery work.",
          })}
          aside={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void handleTestNotification()}
              data-testid="notifications-test-button"
            >
              {copy("settings.notificationsTestButton", {
                "zh-CN": "发送测试通知",
                en: "Send test notification",
              })}
            </Button>
          }
        />
      </div>

      <p className="text-sm text-muted-foreground break-words">
        {copy("settings.notificationsFootnote", {
          "zh-CN":
            "提醒在应用运行（含最小化或托盘隐藏）时送达；完全退出应用后不承诺送达，重新打开时 24 小时内的逾期提醒会立即补送。操作结果与关键错误反馈始终显示在当前任务界面。",
          en: "Reminders are delivered while the app is running (including minimized or hidden to tray). Delivery is not guaranteed after a full quit; on reopen, reminders overdue by less than 24 hours fire immediately. Action results and critical error feedback always stay visible in the current task view.",
        })}
      </p>
    </div>
  );
}

export default NotificationsSettings;

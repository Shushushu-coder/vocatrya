"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastError } from "@/lib/toast";
import { useI18n, type Locale } from "@/i18n";
import { useSaveStatus } from "@/context/SaveStatusContext";

// INT-01 owns the shared message bundles; until the declared keys land,
// t() echoes the key and the paired fallback keeps the page readable.
function useCopy() {
  const { t, locale } = useI18n();
  return (key: string, fallback: Record<Locale, string>) => {
    const translated = t(key);
    return translated === key ? fallback[locale] : translated;
  };
}

type DesktopState = VocatryaDesktopLifecycleState;
type PrefKey = "closeToTray" | "startMinimized" | "openAtLogin";
const PREF_KEYS: readonly PrefKey[] = [
  "openAtLogin",
  "startMinimized",
  "closeToTray",
];

const SETTERS: Record<
  PrefKey,
  (bridge: VocatryaDesktopBridge, enabled: boolean) => Promise<DesktopState>
> = {
  openAtLogin: (bridge, enabled) => bridge.setOpenAtLogin(enabled),
  startMinimized: (bridge, enabled) => bridge.setStartMinimized(enabled),
  closeToTray: (bridge, enabled) => bridge.setCloseToTray(enabled),
};

// The IPC contract resolves every read/write to the full lifecycle snapshot;
// a malformed payload is a failed read, never a usable one.
function isDesktopState(value: unknown): value is DesktopState {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.closeToTray === "boolean" &&
    typeof v.closeToTrayActive === "boolean" &&
    typeof v.startMinimized === "boolean" &&
    typeof v.openAtLogin === "boolean" &&
    typeof v.openAtLoginSupported === "boolean" &&
    (typeof v.openAtLoginError === "string" || v.openAtLoginError === null) &&
    typeof v.trayAvailable === "boolean"
  );
}

function PreferenceRow({
  name,
  description,
  note,
  aside,
}: {
  name: string;
  description: string;
  note?: ReactNode;
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
        {note}
      </div>
      <div className="shrink-0">{aside}</div>
    </div>
  );
}

// Desktop lifecycle preferences (SET-DESKTOP). The switches write through
// the vocatryaDesktop bridge — device-scope settings owned by the main
// process, not the account UserSettings document — and every write is
// confirmed against the authoritative snapshot the IPC returns (or a fresh
// getState when the write path cannot prove the result). There is no
// optimistic-only success: a rejected write or an echo that disagrees with
// the intent surfaces an error and rolls the switch back to real state.
function DesktopPreferencesPanel({ bridge }: { bridge: VocatryaDesktopBridge }) {
  const copy = useCopy();
  const { t } = useI18n();
  const { begin, finish } = useSaveStatus();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [view, setView] = useState<DesktopState | null>(null);
  const [retrySeq, setRetrySeq] = useState(0);

  // `confirmed` is the last snapshot the main process actually reported;
  // `view` is what the switches show. They diverge while a write is in
  // flight and again after a failed write rolls back to confirmed state.
  const confirmedRef = useRef<DesktopState | null>(null);
  const pendingRef = useRef<Partial<Record<PrefKey, boolean>>>({});
  const pumpingRef = useRef(false);
  const copyRef = useRef(copy);
  copyRef.current = copy;

  // Merge an authoritative snapshot into the view — except keys whose queued
  // intent is newer than this snapshot: their own write result reconverges
  // them, so a stale read must not flick the switch back mid-edit.
  const applyAuthoritative = useCallback((actual: DesktopState) => {
    confirmedRef.current = actual;
    setView((prev) => {
      const merged = { ...actual };
      if (prev) {
        for (const key of PREF_KEYS) {
          if (pendingRef.current[key] !== undefined) merged[key] = prev[key];
        }
      }
      return merged;
    });
  }, []);

  // Writes run strictly serial and coalesce to the latest intent per key: a
  // parallel fire-and-forget could let an older request be the last write
  // the device store applies, leaving persisted state behind the toggle.
  const queueSave = useCallback(() => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    void (async () => {
      try {
        for (;;) {
          const key = PREF_KEYS.find(
            (k) => pendingRef.current[k] !== undefined,
          );
          if (!key) break;
          const intent = pendingRef.current[key] as boolean;
          delete pendingRef.current[key];
          const seq = begin();
          let persisted = false;
          try {
            const next = await SETTERS[key](bridge, intent);
            persisted = isDesktopState(next) && next[key] === intent;
            if (isDesktopState(next)) applyAuthoritative(next);
          } catch (error) {
            console.error("Error saving desktop preference:", error);
          }
          if (!persisted) {
            // The write could not prove the intent landed — re-read the real
            // state so the switch settles on truth, not on the optimistic
            // value. If even the re-read fails, fall back to the last
            // confirmed snapshot for this key.
            let reverted = false;
            try {
              const actual = await bridge.getState();
              if (isDesktopState(actual)) {
                applyAuthoritative(actual);
                reverted = true;
              }
            } catch (error) {
              console.error("Error re-reading desktop state:", error);
            }
            if (!reverted) {
              const confirmed = confirmedRef.current;
              if (confirmed && pendingRef.current[key] === undefined) {
                setView((prev) =>
                  prev ? { ...prev, [key]: confirmed[key] } : prev,
                );
              }
            }
            toastError(
              copyRef.current("settings.desktopSaveFailed", {
                "zh-CN": "桌面偏好保存失败。",
                en: "Failed to save the desktop preference.",
              }),
            );
          }
          finish(seq, persisted);
        }
      } finally {
        pumpingRef.current = false;
      }
    })();
  }, [applyAuthoritative, begin, bridge, finish]);

  const handleToggle = useCallback(
    (key: PrefKey, enabled: boolean) => {
      if (!view) return;
      // Re-toggling to the already displayed value needs no write: it is
      // either confirmed or its save is already queued/in flight.
      if (view[key] === enabled && pendingRef.current[key] === undefined) {
        return;
      }
      setView((prev) => (prev ? { ...prev, [key]: enabled } : prev));
      pendingRef.current[key] = enabled;
      queueSave();
    },
    [queueSave, view],
  );

  useEffect(() => {
    let cancelled = false;
    setPhase("loading");
    void (async () => {
      try {
        const state = await bridge.getState();
        if (cancelled) return;
        if (isDesktopState(state)) {
          confirmedRef.current = state;
          setView(state);
          setPhase("ready");
        } else {
          setPhase("error");
        }
      } catch (error) {
        console.error("Error loading desktop preferences:", error);
        if (!cancelled) setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bridge, retrySeq]);

  if (phase === "loading") {
    return (
      <div
        className="flex items-center gap-2"
        data-testid="desktop-preferences-loading"
      >
        <Loader2 className="h-4 w-4 animate-spin" />
        <span>{t("settings.loadingSettings")}</span>
      </div>
    );
  }

  if (phase === "error" || !view) {
    return (
      <div
        className="flex items-center gap-2"
        data-testid="desktop-preferences-error"
      >
        <p className="text-sm text-muted-foreground break-words">
          {copy("settings.desktopLoadFailed", {
            "zh-CN": "无法读取桌面应用的实际状态。",
            en: "Could not read the desktop app's actual state.",
          })}
        </p>
        <Button
          variant="outline"
          size="sm"
          data-testid="desktop-preferences-retry"
          onClick={() => setRetrySeq((n) => n + 1)}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  const openAtLoginUnsupported = !view.openAtLoginSupported;
  const openAtLoginNote = openAtLoginUnsupported ? (
    <p className="mt-1 text-sm text-muted-foreground break-words">
      {copy("settings.desktopOpenAtLoginUnsupported", {
        "zh-CN": "当前平台不支持管理系统自启项。",
        en: "Login items are not supported on this platform.",
      })}
    </p>
  ) : view.openAtLoginError ? (
    <p className="mt-1 text-sm text-muted-foreground break-words">
      {copy("settings.desktopOpenAtLoginError", {
        "zh-CN": "无法读取系统自启状态，显示值可能不准确。",
        en: "The OS login-item state could not be read; the shown value may be inaccurate.",
      })}
    </p>
  ) : undefined;

  return (
    <div className="divide-y">
      <PreferenceRow
        name={copy("settings.desktopOpenAtLogin", {
          "zh-CN": "登录时自动启动",
          en: "Open at login",
        })}
        description={copy("settings.desktopOpenAtLoginDescription", {
          "zh-CN": "登录系统后自动启动 Vocatrya，状态由操作系统管理并实时校验。",
          en: "Start Vocatrya automatically when you sign in. The state is managed by the OS and verified live.",
        })}
        note={openAtLoginNote}
        aside={
          <Switch
            checked={view.openAtLogin}
            disabled={openAtLoginUnsupported}
            onCheckedChange={(enabled) =>
              handleToggle("openAtLogin", enabled)
            }
            aria-label={copy("settings.desktopOpenAtLogin", {
              "zh-CN": "登录时自动启动",
              en: "Open at login",
            })}
            data-testid="desktop-pref-open-at-login"
          />
        }
      />
      <PreferenceRow
        name={copy("settings.desktopStartMinimized", {
          "zh-CN": "启动时最小化",
          en: "Start minimized",
        })}
        description={copy("settings.desktopStartMinimizedDescription", {
          "zh-CN": "应用启动后主窗口保持最小化，不自动弹出。",
          en: "The main window stays minimized when the app launches instead of appearing.",
        })}
        aside={
          <Switch
            checked={view.startMinimized}
            onCheckedChange={(enabled) =>
              handleToggle("startMinimized", enabled)
            }
            aria-label={copy("settings.desktopStartMinimized", {
              "zh-CN": "启动时最小化",
              en: "Start minimized",
            })}
            data-testid="desktop-pref-start-minimized"
          />
        }
      />
      <PreferenceRow
        name={copy("settings.desktopCloseToTray", {
          "zh-CN": "关闭到系统托盘",
          en: "Close to system tray",
        })}
        description={copy("settings.desktopCloseToTrayDescription", {
          "zh-CN": "关闭窗口时隐藏到托盘继续运行；从托盘菜单可显式退出。",
          en: "Closing the window hides it to the tray and keeps the app running; quit explicitly from the tray menu.",
        })}
        note={
          view.closeToTray && !view.trayAvailable ? (
            <p className="mt-1 text-sm text-muted-foreground break-words">
              {copy("settings.desktopCloseToTrayNoTray", {
                "zh-CN": "系统托盘当前不可用，关闭窗口将直接退出应用。",
                en: "The system tray is unavailable right now, so closing the window quits the app.",
              })}
            </p>
          ) : undefined
        }
        aside={
          <Switch
            checked={view.closeToTray}
            onCheckedChange={(enabled) =>
              handleToggle("closeToTray", enabled)
            }
            aria-label={copy("settings.desktopCloseToTray", {
              "zh-CN": "关闭到系统托盘",
              en: "Close to system tray",
            })}
            data-testid="desktop-pref-close-to-tray"
          />
        }
      />
    </div>
  );
}

// The bridge only exists inside the Electron shell and only after mount —
// `undefined` keeps SSR and the first client render identical (render
// nothing), then the probe decides between the live panel and an honest
// availability statement. A browser session never gets fake switches: the
// section states plainly that the preferences exist but are desktop-only.
function DesktopPreferencesSettings() {
  const copy = useCopy();
  const [bridge, setBridge] = useState<
    VocatryaDesktopBridge | null | undefined
  >(undefined);

  useEffect(() => {
    const candidate = window.vocatryaDesktop;
    setBridge(
      candidate &&
        typeof candidate.getState === "function" &&
        typeof candidate.setOpenAtLogin === "function" &&
        typeof candidate.setStartMinimized === "function" &&
        typeof candidate.setCloseToTray === "function"
        ? candidate
        : null,
    );
  }, []);

  if (bridge === undefined) return null;

  return (
    <section
      className="space-y-2 border-t pt-4"
      data-testid="desktop-preferences"
      aria-label={copy("settings.desktopTitle", {
        "zh-CN": "桌面应用",
        en: "Desktop app",
      })}
    >
      <div>
        <div className="text-sm font-medium leading-none break-words">
          {copy("settings.desktopTitle", {
            "zh-CN": "桌面应用",
            en: "Desktop app",
          })}
        </div>
        <p className="mt-1 text-sm text-muted-foreground break-words">
          {copy("settings.desktopDescription", {
            "zh-CN": "仅作用于本设备上的 Vocatrya 桌面应用，不属于账号设置。",
            en: "Applies only to the Vocatrya desktop app on this device — these are device settings, not account settings.",
          })}
        </p>
      </div>
      {bridge === null ? (
        <div
          className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1 py-3"
          data-testid="desktop-preferences-unavailable"
        >
          <p className="min-w-0 flex-1 basis-56 text-sm text-muted-foreground break-words">
            {copy("settings.desktopUnavailable", {
              "zh-CN":
                "自启、最小化启动与关闭到托盘偏好保存在本机，只能在 Vocatrya 桌面应用内读取和修改；浏览器会话无法访问。",
              en: "Open-at-login, start-minimized, and close-to-tray preferences live on this device and can only be read or changed inside the Vocatrya desktop app; a browser session cannot reach them.",
            })}
          </p>
          <div className="shrink-0">
            <Badge variant="outline">
              {copy("settings.capabilityDesktopOnly", {
                "zh-CN": "仅桌面应用",
                en: "Desktop app only",
              })}
            </Badge>
          </div>
        </div>
      ) : (
        <DesktopPreferencesPanel bridge={bridge} />
      )}
    </section>
  );
}

export default DesktopPreferencesSettings;

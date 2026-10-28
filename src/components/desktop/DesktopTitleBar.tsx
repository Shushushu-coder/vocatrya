"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Keyboard } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { isDesktopShell } from "@/components/desktop/desktopShell";
import { useI18n } from "@/i18n";
import { comboToDisplayKeys } from "@/lib/shortcuts/combos";
import { useShortcutSnapshot } from "@/lib/shortcuts/bindings";
import { useWindowShortcut } from "@/lib/shortcuts/useWindowShortcut";
import { cn } from "@/lib/utils";

// Minimal local view of the Chromium Navigation API. The desktop shell is
// Electron-only (window.vocatryaWindow is exposed by preload.js), where this
// API is always present; the guards keep jsdom tests and any future
// non-Electron host safe.
interface AppNavigation {
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  back(): void;
  forward(): void;
  addEventListener(type: "currententrychange", listener: () => void): void;
  removeEventListener(type: "currententrychange", listener: () => void): void;
}

function appNavigation(): AppNavigation | null {
  if (typeof window === "undefined") return null;
  const nav = (window as unknown as { navigation?: Partial<AppNavigation> })
    .navigation;
  if (
    !nav ||
    typeof nav.back !== "function" ||
    typeof nav.addEventListener !== "function"
  ) {
    return null;
  }
  return nav as AppNavigation;
}

// Back/forward state comes from window.navigation so it stays correct across
// reloads, direct URL entry, and auth redirects — the real session-history
// stack, not a renderer-side mirror that drifts.
function useNavHistory() {
  const [state, setState] = useState({ canBack: false, canForward: false });

  useEffect(() => {
    if (!isDesktopShell()) return;
    const nav = appNavigation();
    if (!nav) return;
    const update = () =>
      setState({ canBack: !!nav.canGoBack, canForward: !!nav.canGoForward });
    update();
    nav.addEventListener("currententrychange", update);
    return () => nav.removeEventListener("currententrychange", update);
  }, []);

  const back = useCallback(() => {
    appNavigation()?.back();
  }, []);
  const forward = useCallback(() => {
    appNavigation()?.forward();
  }, []);

  return { ...state, back, forward };
}

const NAV_BUTTON_CLASS =
  "flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40";

// window.navigation performs the history jump itself, so the same handler can
// serve the registry-bound combos and the on-bar buttons without touching
// router state. The actions' isComposing guard keeps IME sessions untouched;
// the desktopOnly scope keeps the binding inert in a plain browser.
function useHistoryShortcuts() {
  useWindowShortcut("historyBack", (e) => {
    const nav = appNavigation();
    if (nav?.canGoBack) {
      e.preventDefault();
      nav.back();
    }
  });
  useWindowShortcut("historyForward", (e) => {
    const nav = appNavigation();
    if (nav?.canGoForward) {
      e.preventDefault();
      nav.forward();
    }
  });
}

const HELP_ACTIONS = [
  { action: "toggleSidebar", labelKey: "shortcuts.toggleSidebar" },
  { action: "historyBack", labelKey: "shortcuts.goBack" },
  { action: "historyForward", labelKey: "shortcuts.goForward" },
] as const;

function ShortcutHelp() {
  const { t } = useI18n();
  const bindings = useShortcutSnapshot().window;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={t("nav.keyboardShortcuts")}
          title={t("nav.keyboardShortcuts")}
          className={NAV_BUTTON_CLASS}
        >
          <Keyboard className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={6} className="w-72">
        <h3 className="mb-3 text-sm font-semibold">{t("shortcuts.title")}</h3>
        <ul className="space-y-2">
          {HELP_ACTIONS.map((shortcut) => {
            const keys = comboToDisplayKeys(bindings[shortcut.action]);
            return (
              <li
                key={shortcut.labelKey}
                className="flex items-center justify-between gap-3 text-sm"
              >
                <span className="text-muted-foreground">
                  {t(shortcut.labelKey)}
                </span>
                <span className="flex shrink-0 items-center gap-1">
                  {keys.length === 0 ? (
                    <span className="text-xs text-muted-foreground">—</span>
                  ) : (
                    keys.map((key) => (
                      <kbd
                        key={key}
                        className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[11px] font-medium"
                      >
                        {key}
                      </kbd>
                    ))
                  )}
                </span>
              </li>
            );
          })}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          {t("shortcuts.closeHint")}
        </p>
      </PopoverContent>
    </Popover>
  );
}

// The desktop window chrome: page-history controls and the shortcut
// reference. Native caption buttons are drawn by Windows over the padded
// right edge (titleBarOverlay), so this bar only reserves space for them.
// Everything except the interactive controls is an app-region: drag zone.
export function DesktopTitleBar() {
  const { t } = useI18n();
  const { canBack, canForward, back, forward } = useNavHistory();
  useHistoryShortcuts();

  return (
    <header
      data-testid="desktop-titlebar"
      className={cn(
        "desktop-titlebar app-region-drag sticky top-0 z-50 h-9 select-none items-center gap-1 border-b bg-background pl-2",
        // Keep interactive content clear of the native caption buttons the OS
        // draws at the top-right (~46px each on Windows).
        "pr-[140px]",
      )}
    >
      <div className="app-region-no-drag ml-1 flex items-center">
        <button
          type="button"
          aria-label={t("nav.goBack")}
          title={t("nav.goBack")}
          disabled={!canBack}
          onClick={back}
          className={NAV_BUTTON_CLASS}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          aria-label={t("nav.goForward")}
          title={t("nav.goForward")}
          disabled={!canForward}
          onClick={forward}
          className={NAV_BUTTON_CLASS}
        >
          <ArrowRight className="h-4 w-4" />
        </button>
      </div>
      <div className="app-region-no-drag ml-1 flex items-center">
        <ShortcutHelp />
      </div>
      {/* Dashboard-scoped actions (create menu, upload) are portaled in by
          TitleBarActions; their providers only exist under /dashboard, so the
          slot stays empty on auth and other non-dashboard routes. */}
      <div
        id="desktop-titlebar-actions-left"
        className="app-region-no-drag ml-1 flex items-center"
      />
      <div className="min-w-0 flex-1" aria-hidden="true" />
      <div
        id="desktop-titlebar-actions-right"
        className="app-region-no-drag mr-1 flex items-center"
      />
    </header>
  );
}

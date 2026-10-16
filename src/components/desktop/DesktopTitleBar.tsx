"use client";

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Keyboard } from "lucide-react";

import { VocatryaMark } from "@/components/brand/VocatryaMark";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useI18n } from "@/i18n";
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

// True only inside the Electron main window: the preload bridge exists there
// and nowhere else (web build, hidden print window, jsdom).
function isDesktopShell(): boolean {
  return typeof window !== "undefined" && Boolean(window.vocatryaWindow);
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
// serve Alt+Arrow shortcuts and the on-bar buttons without touching router
// state. The guard on isComposing keeps IME sessions untouched; arrow keys
// with Alt are never an editing shortcut on Windows, so text fields and the
// resume editor are unaffected.
function useHistoryShortcuts() {
  useEffect(() => {
    if (!isDesktopShell()) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.isComposing)
        return;
      const nav = appNavigation();
      if (!nav) return;
      if (e.key === "ArrowLeft" && nav.canGoBack) {
        e.preventDefault();
        nav.back();
      } else if (e.key === "ArrowRight" && nav.canGoForward) {
        e.preventDefault();
        nav.forward();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

const SHORTCUTS: { keys: string[]; labelKey: string }[] = [
  { keys: ["Ctrl", "B"], labelKey: "shortcuts.toggleSidebar" },
  { keys: ["Alt", "←"], labelKey: "shortcuts.goBack" },
  { keys: ["Alt", "→"], labelKey: "shortcuts.goForward" },
];

function ShortcutHelp() {
  const { t } = useI18n();
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
      <PopoverContent align="end" sideOffset={6} className="w-72">
        <h3 className="mb-3 text-sm font-semibold">{t("shortcuts.title")}</h3>
        <ul className="space-y-2">
          {SHORTCUTS.map((shortcut) => (
            <li
              key={shortcut.labelKey}
              className="flex items-center justify-between gap-3 text-sm"
            >
              <span className="text-muted-foreground">
                {t(shortcut.labelKey)}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                {shortcut.keys.map((key) => (
                  <kbd
                    key={key}
                    className="rounded border bg-muted px-1.5 py-0.5 font-sans text-[11px] font-medium"
                  >
                    {key}
                  </kbd>
                ))}
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-xs text-muted-foreground">
          {t("shortcuts.closeHint")}
        </p>
      </PopoverContent>
    </Popover>
  );
}

// The desktop window chrome: brand, page-history controls, and the shortcut
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
      <div className="flex items-center gap-1.5 px-1">
        <VocatryaMark size={16} />
        <span className="text-xs font-semibold tracking-wide">Vocatrya</span>
      </div>
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
      <div className="min-w-0 flex-1" aria-hidden="true" />
      <div className="app-region-no-drag flex items-center">
        <ShortcutHelp />
      </div>
    </header>
  );
}

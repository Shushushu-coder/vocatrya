"use client";

import { useCallback, useEffect, useState } from "react";
import { Minus, Plus } from "lucide-react";
import { isDesktopShell } from "@/components/desktop/desktopShell";
import { useI18n } from "@/i18n";
import { useWindowShortcut } from "@/lib/shortcuts/useWindowShortcut";

const AUTO_HIDE_MS = 2000;

async function adjustZoom(direction: "in" | "out" | "reset") {
  const bridge = window.vocatryaDesktop;
  if (!bridge || typeof bridge.adjustZoom !== "function") return;
  await bridge.adjustZoom(direction);
}

// Desktop page zoom. The shortcuts are desktop-only, so a browser keeps
// its own Ctrl+/- handling. The indicator follows both the shortcuts and
// Ctrl+wheel, which Chromium reports through the main process.
export function DesktopZoom() {
  const { t } = useI18n();
  const [factor, setFactor] = useState(1);
  const [visible, setVisible] = useState(false);
  const [shell, setShell] = useState(false);

  useEffect(() => {
    if (!isDesktopShell()) return;
    setShell(true);
    const bridge = window.vocatryaDesktop;
    let cancelled = false;
    void bridge?.getZoomFactor?.().then((next) => {
      if (!cancelled && typeof next === "number") setFactor(next);
    });
    const unsubscribe = bridge?.onZoomFactor?.((next) => {
      setFactor(next);
      setVisible(true);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => setVisible(false), AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [visible, factor]);

  const zoom = useCallback((direction: "in" | "out" | "reset") => {
    void adjustZoom(direction);
  }, []);

  useWindowShortcut("zoomIn", (event) => {
    event.preventDefault();
    zoom("in");
  });
  useWindowShortcut("zoomOut", (event) => {
    event.preventDefault();
    zoom("out");
  });
  useWindowShortcut("zoomReset", (event) => {
    event.preventDefault();
    zoom("reset");
  });

  if (!shell) return null;
  const percent = Math.round(factor * 100);
  return (
    <div
      aria-hidden={!visible}
      data-testid="zoom-indicator"
      className={`fixed right-3 top-12 z-[80] flex items-center gap-0.5 rounded-full border bg-popover py-1 pl-3 pr-1 text-xs font-medium text-popover-foreground shadow-lg transition-opacity duration-200 ${
        visible ? "opacity-100" : "pointer-events-none opacity-0"
      }`}
    >
      <span className="tabular-nums">{percent}%</span>
      <button
        type="button"
        aria-label={t("shortcuts.zoomOut")}
        className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => zoom("out")}
      >
        <Minus className="size-3.5" />
      </button>
      <button
        type="button"
        aria-label={t("shortcuts.zoomIn")}
        className="flex size-6 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
        onClick={() => zoom("in")}
      >
        <Plus className="size-3.5" />
      </button>
      {percent !== 100 ? (
        <button
          type="button"
          aria-label={t("shortcuts.zoomReset")}
          className="h-6 rounded-full px-2 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => zoom("reset")}
        >
          {t("shortcuts.zoomReset")}
        </button>
      ) : null}
    </div>
  );
}

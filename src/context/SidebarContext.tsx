"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { APP_CONSTANTS, clampSidebarWidth } from "@/lib/constants";
import { useWindowShortcut } from "@/lib/shortcuts/useWindowShortcut";

const {
  SIDEBAR_WIDTH_PX: {
    default: DEFAULT_WIDTH,
    min: MIN_WIDTH,
    collapsed: COLLAPSED_WIDTH,
    collapseBelow: COLLAPSE_BELOW,
    keyboardStep: KEYBOARD_STEP,
  },
} = APP_CONSTANTS;

type SidebarContextValue = {
  expanded: boolean;
  width: number;
  isResizing: boolean;
  toggle: () => void;
  collapse: () => void;
  expand: () => void;
  startResize: (e: React.MouseEvent) => void;
  resizeByKey: (e: React.KeyboardEvent) => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

// One year, so the preference persists like a typical "remember my setting" cookie.
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function SidebarProvider({
  children,
  initialExpanded,
  initialWidth,
}: {
  children: React.ReactNode;
  initialExpanded: boolean;
  initialWidth?: number;
}) {
  const [expanded, setExpanded] = useState(initialExpanded);
  const [width, setWidth] = useState(() =>
    initialWidth ? clampSidebarWidth(initialWidth) : DEFAULT_WIDTH
  );
  const [isResizing, setIsResizing] = useState(false);
  const draggingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);
  const widthRef = useRef(width);
  const expandedRef = useRef(expanded);
  widthRef.current = width;
  expandedRef.current = expanded;

  const toggle = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  const collapse = useCallback(() => {
    setExpanded(false);
  }, []);

  const expand = useCallback(() => {
    setExpanded(true);
  }, []);

  useEffect(() => {
    document.cookie = `${APP_CONSTANTS.SIDEBAR_STORAGE_KEY}=${expanded}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
  }, [expanded]);

  // Width writes go through the same cookie path but are skipped mid-drag —
  // the drop below also re-fires this effect once dragging ends.
  useEffect(() => {
    if (isResizing) return;
    document.cookie = `${APP_CONSTANTS.SIDEBAR_WIDTH_STORAGE_KEY}=${width}; path=/; max-age=${COOKIE_MAX_AGE_SECONDS}; samesite=lax`;
  }, [width, isResizing]);

  const startResize = useCallback((e: React.MouseEvent) => {
    draggingRef.current = true;
    setIsResizing(true);
    startXRef.current = e.clientX;
    startWidthRef.current = expandedRef.current
      ? widthRef.current
      : COLLAPSED_WIDTH;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    e.preventDefault();
  }, []);

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const next = startWidthRef.current + (e.clientX - startXRef.current);
      if (!expandedRef.current) {
        // Collapsed rail: crossing the threshold to the right re-expands at
        // the drag width, floored at the minimum expanded width.
        if (next >= COLLAPSE_BELOW) {
          setExpanded(true);
          setWidth(clampSidebarWidth(next));
        }
        return;
      }
      if (next < COLLAPSE_BELOW) {
        setExpanded(false);
        return;
      }
      setWidth(clampSidebarWidth(next));
    };

    const onMouseUp = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      setIsResizing(false);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  const resizeByKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (!expandedRef.current) return;
        // At the floor, one more ArrowLeft collapses to the rail.
        if (widthRef.current <= MIN_WIDTH) setExpanded(false);
        else setWidth(clampSidebarWidth(widthRef.current - KEYBOARD_STEP));
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (expandedRef.current) {
          setWidth(clampSidebarWidth(widthRef.current + KEYBOARD_STEP));
        } else {
          setExpanded(true);
          setWidth(DEFAULT_WIDTH);
        }
      } else if (e.key === "Enter") {
        e.preventDefault();
        toggle();
      }
    },
    [toggle]
  );

  // Registry-driven binding (default Ctrl/Cmd+B, rebindable in settings).
  // The toggleSidebar action keeps the editable-element guard: inputs and
  // Tiptap/ProseMirror keep the combo for their own shortcuts (e.g. bold).
  useWindowShortcut("toggleSidebar", useCallback((e: KeyboardEvent) => {
    e.preventDefault();
    toggle();
  }, [toggle]));

  return (
    <SidebarContext.Provider
      value={{
        expanded,
        width,
        isResizing,
        toggle,
        collapse,
        expand,
        startResize,
        resizeByKey,
      }}
    >
      {children}
    </SidebarContext.Provider>
  );
}

export function useSidebar() {
  const ctx = useContext(SidebarContext);
  if (!ctx) {
    throw new Error("useSidebar must be used within a SidebarProvider");
  }
  return ctx;
}

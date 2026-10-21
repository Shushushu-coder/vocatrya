"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { CreateMenu } from "@/components/GlobalActions";
import { AgentChatTrigger } from "@/components/AgentChatTrigger";
import { isDesktopShell } from "@/components/desktop/desktopShell";

// The desktop titlebar is mounted by the root layout, above the dashboard
// layout that owns CareerSurfacesProvider/AgentChatProvider. Portaling keeps
// the real controls inside those providers while their DOM lands in the
// titlebar's no-drag slots — one set of actions, rendered by the dashboard
// shell exactly once, not re-created per page.
export function TitleBarActions() {
  const [leftSlot, setLeftSlot] = useState<HTMLElement | null>(null);
  const [rightSlot, setRightSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    // The titlebar's slot divs exist in the DOM on every build (the bar is
    // display:none'd by CSS outside Electron). Portaling unconditionally
    // would render a second copy of every global action — duplicate testids
    // against the in-header fallback row — so only the real Electron shell
    // takes this path; the web build keeps the header actions alone.
    if (!isDesktopShell()) return;
    setLeftSlot(document.getElementById("desktop-titlebar-actions-left"));
    setRightSlot(document.getElementById("desktop-titlebar-actions-right"));
  }, []);

  return (
    <>
      {leftSlot && createPortal(<CreateMenu compact />, leftSlot)}
      {rightSlot &&
        createPortal(
          <AgentChatTrigger
            variant="ghost"
            className="h-7 gap-1.5 px-2 text-xs"
          />,
          rightSlot
        )}
    </>
  );
}

"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { CreateMenu } from "@/components/GlobalActions";
import { AgentChatTrigger } from "@/components/AgentChatTrigger";

// The desktop titlebar is mounted by the root layout, above the dashboard
// layout that owns CareerSurfacesProvider/AgentChatProvider. Portaling keeps
// the real controls inside those providers while their DOM lands in the
// titlebar's no-drag slots — one set of actions, rendered by the dashboard
// shell exactly once, not re-created per page.
export function TitleBarActions() {
  const [leftSlot, setLeftSlot] = useState<HTMLElement | null>(null);
  const [rightSlot, setRightSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
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

"use client";

import { useEffect, useRef, useState } from "react";
import type { VocatryaMotionState } from "./VocatryaMark";

// Consumes successful finish events once. Animation timing never infers AI status.
export function useAgentBrandState({
  status, brandCompletion, isOpen, conversationId, blocked,
}: {
  status: string;
  brandCompletion: number;
  isOpen: boolean;
  conversationId: string | null;
  blocked: boolean;
}): VocatryaMotionState {
  const consumed = useRef(brandCompletion);
  const [completionVisible, setCompletionVisible] = useState(false);
  const processing = status === "submitted" || status === "streaming";

  useEffect(() => {
    if (isOpen && processing) {
      setCompletionVisible(false);
      return;
    }
    const freshCompletion = brandCompletion > consumed.current;
    consumed.current = brandCompletion;
    if (!isOpen || blocked || !freshCompletion) {
      setCompletionVisible(false);
      return;
    }
    setCompletionVisible(true);
    // The approved COMPLETE lasts 650ms. Allow one frame for the engine to settle.
    const timer = setTimeout(() => setCompletionVisible(false), 700);
    return () => clearTimeout(timer);
  }, [status, processing, brandCompletion, isOpen, conversationId, blocked]);

  if (!isOpen) return "idle";
  if (processing) return "thinking";
  return completionVisible && !blocked ? "complete" : "idle";
}

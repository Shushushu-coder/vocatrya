"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toastError } from "@/lib/toast";

// Shared clipboard behavior for the agent surface's copy actions: a two
// second check mark on success, and on failure a real toast with the button
// left armed — no check mark for a write that did not happen, and a denied
// clipboard stays retryable.
export function useClipboardCopy(failureMessage: string) {
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current) clearTimeout(resetRef.current);
    },
    [],
  );

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        if (resetRef.current) clearTimeout(resetRef.current);
        resetRef.current = setTimeout(() => setCopied(false), 2000);
      } catch {
        setCopied(false);
        toastError(failureMessage);
      }
    },
    [failureMessage],
  );

  return { copied, copy };
}

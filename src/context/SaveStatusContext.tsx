"use client";

import { createContext, useCallback, useContext, useRef, useState } from "react";

export type SaveStatus = "idle" | "saving" | "saved" | "error";

type SaveStatusContextValue = {
  status: SaveStatus;
  // begin returns a sequence token; finish applies it. A stale completion
  // (an older request resolving after a newer one started) never downgrades
  // the status while a newer save is still in flight.
  begin: () => number;
  finish: (seq: number, ok: boolean) => void;
};

const SaveStatusContext = createContext<SaveStatusContextValue | null>(null);

const SAVED_VISIBLE_MS = 2500;

export function SaveStatusProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const seqRef = useRef(0);
  const pendingRef = useRef(new Set<number>());
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const begin = useCallback(() => {
    const seq = ++seqRef.current;
    pendingRef.current.add(seq);
    if (idleTimerRef.current) {
      clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
    setStatus("saving");
    return seq;
  }, []);

  const finish = useCallback((seq: number, ok: boolean) => {
    pendingRef.current.delete(seq);
    if (pendingRef.current.size > 0) return;
    if (!ok) {
      setStatus("error");
      return;
    }
    setStatus("saved");
    idleTimerRef.current = setTimeout(() => {
      setStatus("idle");
      idleTimerRef.current = null;
    }, SAVED_VISIBLE_MS);
  }, []);

  return (
    <SaveStatusContext.Provider value={{ status, begin, finish }}>
      {children}
    </SaveStatusContext.Provider>
  );
}

// Outside the dashboard shell (tests, one-off renders) the indicator is
// chrome-only, so the hook degrades to a no-op instead of failing the render.
const NOOP_SAVE_STATUS: SaveStatusContextValue = {
  status: "idle",
  begin: () => 0,
  finish: () => {},
};

export function useSaveStatus() {
  return useContext(SaveStatusContext) ?? NOOP_SAVE_STATUS;
}

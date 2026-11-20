// Persistent error notices (top-left of the main content area).
//
// Merge rule (2026-11-19): same-kind errors collapse into ONE entry that is
// updated in place; the host shows at most MAX_VISIBLE_ERROR_NOTICES and folds
// the rest behind a "+N" expander; once the underlying condition recovers the
// entry reads "recovered" and auto-dismisses after RECOVERED_DISMISS_MS.
//
// Kind key: callers pass a stable `kind` of the form `<source>:<code>`
// (e.g. "agent-chat:CONNECTION_FAILED", "extension:notion:AUTH_EXPIRED"),
// derived from the existing error source and error code, never from the
// message text, so a changing message updates the entry instead of stacking.
//
// Closing a notice only hides it; it does not mean the condition recovered and
// never triggers a retry. `onRetry` is invoked solely by the user's click, so
// external-write retries keep following the "unknown result -> verify" rule.
// Transient notices (saved, connected) stay on sonner at bottom-right.

import { useSyncExternalStore } from "react";

export const MAX_VISIBLE_ERROR_NOTICES = 3;
export const RECOVERED_DISMISS_MS = 4000;

export type ErrorNoticeStatus = "active" | "recovered";

export interface ErrorNoticeInput {
  kind: string;
  title: string;
  message?: string;
  /** Pre-sanitized detail text (no credentials); shown behind "Details". */
  details?: string;
  /** User-initiated retry only; never called automatically. */
  onRetry?: () => void;
  /** Link to an existing reconnect / settings page (user click only). */
  action?: { label: string; href: string };
}

export interface ErrorNotice extends ErrorNoticeInput {
  status: ErrorNoticeStatus;
  /** How many times this kind has been reported since it appeared. */
  count: number;
  firstAt: number;
  lastAt: number;
}

let notices: ErrorNotice[] = [];
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();

function emit(next: ErrorNotice[]) {
  notices = next;
  listeners.forEach((l) => l());
}

function clearTimer(kind: string) {
  const t = timers.get(kind);
  if (t !== undefined) clearTimeout(t);
  timers.delete(kind);
}

export function reportErrorNotice(input: ErrorNoticeInput): void {
  const now = Date.now();
  clearTimer(input.kind); // a recurrence cancels a pending recovered-dismiss
  const existing = notices.find((n) => n.kind === input.kind);
  if (existing) {
    emit(
      notices.map((n) =>
        n.kind === input.kind
          ? { ...n, ...input, status: "active", count: n.count + 1, lastAt: now }
          : n,
      ),
    );
    return;
  }
  emit([
    ...notices,
    { ...input, status: "active", count: 1, firstAt: now, lastAt: now },
  ]);
}

export function resolveErrorNotice(kind: string): void {
  const existing = notices.find((n) => n.kind === kind);
  if (!existing || existing.status === "recovered") return;
  emit(notices.map((n) => (n.kind === kind ? { ...n, status: "recovered" } : n)));
  clearTimer(kind);
  timers.set(
    kind,
    setTimeout(() => dismissErrorNotice(kind), RECOVERED_DISMISS_MS),
  );
}

export function dismissErrorNotice(kind: string): void {
  clearTimer(kind);
  if (!notices.some((n) => n.kind === kind)) return;
  emit(notices.filter((n) => n.kind !== kind));
}

export function resetErrorNoticesForTests(): void {
  timers.forEach((t) => clearTimeout(t));
  timers.clear();
  emit([]);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => notices;
const getServerSnapshot = (): ErrorNotice[] => [];

export function useErrorNotices(): ErrorNotice[] {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

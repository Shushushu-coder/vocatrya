"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useI18n } from "@/i18n";

const AUTOSAVE_DEBOUNCE_MS = 700;
const SAVED_STATUS_MS = 1600;

type SaveStatus = "idle" | "saving" | "saved" | "error";

type UseAutosaveOptions<T> = {
  /** Last value the server confirmed (already normalized for comparison). */
  committed: T;
  /**
   * Persist one normalized draft. Resolve true only when the write landed;
   * false (or a rejection) keeps the draft for manual retry.
   */
  onSave: (value: T) => Promise<boolean>;
  /** Collapse display-only differences before comparing/committing. */
  normalize?: (draft: T) => T;
  /** Refuse to commit a draft (e.g. required title left empty). */
  committable?: (target: T) => boolean;
};

type AutosaveController<T> = {
  draft: T;
  status: SaveStatus;
  /** Update the draft and schedule a debounced commit. */
  change: (value: T) => void;
  /** Update the draft without scheduling (IME composition in progress). */
  draftOnly: (value: T) => void;
  /** Commit the current draft immediately (blur, toggle, retry). */
  commitNow: () => void;
};

/**
 * Serialized per-field autosave (same contract as ApplicationProfileField):
 * debounced commits on change, immediate commit on blur, at most one request
 * in flight — later commits only replace the queued latest draft. On success
 * the queue drains; on failure the draft is kept untouched for retry, and a
 * stale response can never roll back newer input. Record panels stay mounted
 * across tab switches, so unmount only means the field is gone for good —
 * cleanup clears timers and never fires a save.
 */
function useAutosave<T>({
  committed,
  onSave,
  normalize,
  committable,
}: UseAutosaveOptions<T>): AutosaveController<T> {
  const [draft, setDraft] = useState(committed);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const committedRef = useRef(committed);
  const draftRef = useRef(committed);
  const inFlightRef = useRef(false);
  const pendingRef = useRef<T | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);
  const normalizeRef = useRef(normalize ?? ((v: T) => v));
  const committableRef = useRef(committable);
  useEffect(() => {
    onSaveRef.current = onSave;
    normalizeRef.current = normalize ?? ((v: T) => v);
    committableRef.current = committable;
  });

  // Fold an external value change into the draft only when the user has not
  // diverged and no write is in flight — a read racing our own save must
  // never roll the input back.
  useEffect(() => {
    if (committed === committedRef.current) return;
    if (inFlightRef.current) return;
    const prev = committedRef.current;
    committedRef.current = committed;
    setDraft((d) => {
      if (d !== prev) return d;
      draftRef.current = committed;
      return committed;
    });
  }, [committed]);

  // Snap the visible draft to the stored value when it only differs by
  // normalization (e.g. trailing whitespace); a diverged draft is untouched.
  const syncDraftToCommitted = useCallback(() => {
    if (
      draftRef.current !== committedRef.current &&
      normalizeRef.current(draftRef.current) === committedRef.current
    ) {
      draftRef.current = committedRef.current;
      setDraft(committedRef.current);
    }
  }, []);

  const commit = useCallback(async () => {
    const save = onSaveRef.current;
    const target = normalizeRef.current(draftRef.current);
    if (committableRef.current && !committableRef.current(target)) return;
    if (inFlightRef.current) {
      pendingRef.current = target;
      return;
    }
    if (target === committedRef.current) {
      syncDraftToCommitted();
      setStatus((s) => (s === "error" ? "idle" : s));
      return;
    }
    inFlightRef.current = true;
    setStatus("saving");
    let current = target;
    try {
      for (;;) {
        const ok = await save(current).catch(() => false);
        if (!ok) {
          pendingRef.current = null;
          setStatus("error");
          return;
        }
        committedRef.current = current;
        const next = pendingRef.current;
        pendingRef.current = null;
        if (next === null || next === committedRef.current) break;
        current = next;
      }
      syncDraftToCommitted();
      setStatus("saved");
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
      savedTimerRef.current = setTimeout(() => {
        setStatus((s) => (s === "saved" ? "idle" : s));
      }, SAVED_STATUS_MS);
    } finally {
      inFlightRef.current = false;
    }
  }, [syncDraftToCommitted]);

  const commitRef = useRef(commit);
  useEffect(() => {
    commitRef.current = commit;
  });

  const draftOnly = useCallback((value: T) => {
    draftRef.current = value;
    setDraft(value);
    setStatus((s) => (s === "saving" ? s : "idle"));
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);

  const change = useCallback(
    (value: T) => {
      draftOnly(value);
      debounceRef.current = setTimeout(
        () => void commitRef.current(),
        AUTOSAVE_DEBOUNCE_MS,
      );
    },
    [draftOnly],
  );

  const commitNow = useCallback(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void commitRef.current();
  }, []);

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    },
    [],
  );

  return { draft, status, change, draftOnly, commitNow };
}

function SaveStatusChip({
  status,
  onRetry,
  testId,
}: {
  status: SaveStatus;
  onRetry: () => void;
  testId?: string;
}) {
  const { t } = useI18n();
  return (
    <span
      className="flex items-center gap-1 text-xs"
      aria-live="polite"
      data-testid={testId ? `${testId}-status` : undefined}
    >
      {status === "saving" && (
        <span className="text-muted-foreground">{t("common.saving")}</span>
      )}
      {status === "saved" && (
        <span className="text-muted-foreground">{t("common.saved")}</span>
      )}
      {status === "error" && (
        <>
          <span className="text-destructive">
            {t("applicationProfile.saveFailed")}
          </span>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2"
            onClick={onRetry}
            data-testid={testId ? `${testId}-retry` : undefined}
          >
            {t("common.retry")}
          </Button>
        </>
      )}
    </span>
  );
}

type FieldShellProps = {
  label: string;
  status: SaveStatus;
  onRetry: () => void;
  testId?: string;
  children: React.ReactNode;
};

function FieldShell({
  label,
  status,
  onRetry,
  testId,
  children,
}: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">{label}</span>
        <SaveStatusChip status={status} onRetry={onRetry} testId={testId} />
      </div>
      {children}
    </div>
  );
}

type TextFieldProps = {
  label: string;
  committed: string;
  onSave: (value: string) => Promise<boolean>;
  /** When true, an empty draft is kept locally instead of being persisted. */
  required?: boolean;
  testId?: string;
};

/** Single-line autosave input; IME composition Enter never commits. */
export function MaterialTextField({
  label,
  committed,
  onSave,
  required,
  testId,
}: TextFieldProps) {
  const { draft, status, change, draftOnly, commitNow } = useAutosave<string>({
    committed,
    onSave,
    normalize: (v) => v.trim(),
    committable: required ? (v) => v.length > 0 : undefined,
  });
  const composingRef = useRef(false);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    // While an IME composition is open the draft is intermediate text (e.g.
    // pinyin): committing it would store half-converted text.
    if ((e.nativeEvent as InputEvent).isComposing) {
      draftOnly(e.target.value);
      return;
    }
    change(e.target.value);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (
      composingRef.current ||
      e.nativeEvent.isComposing ||
      e.keyCode === 229
    )
      return;
    if (e.key === "Enter") e.currentTarget.blur();
  }

  return (
    <FieldShell
      label={label}
      status={status}
      onRetry={commitNow}
      testId={testId}
    >
      <Input
        aria-label={label}
        className="h-8"
        value={draft}
        onChange={handleChange}
        onBlur={commitNow}
        onKeyDown={handleKeyDown}
        onCompositionStart={() => {
          composingRef.current = true;
          // Cancel any pending debounce so a scheduled commit cannot fire
          // mid-composition with half-converted text.
          draftOnly(draft);
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          commitNow();
        }}
        data-testid={testId ? `${testId}-input` : undefined}
      />
    </FieldShell>
  );
}

/** Multi-line notes editor; Enter inserts a newline, blur commits. */
export function MaterialNotesField({
  label,
  committed,
  onSave,
  testId,
}: TextFieldProps) {
  const { draft, status, change, draftOnly, commitNow } = useAutosave<string>({
    committed,
    onSave,
    normalize: (v) => v.trim(),
  });
  const composingRef = useRef(false);

  return (
    <FieldShell
      label={label}
      status={status}
      onRetry={commitNow}
      testId={testId}
    >
      <Textarea
        aria-label={label}
        value={draft}
        onChange={(e) => {
          if ((e.nativeEvent as InputEvent).isComposing) {
            draftOnly(e.target.value);
            return;
          }
          change(e.target.value);
        }}
        onBlur={commitNow}
        onCompositionStart={() => {
          composingRef.current = true;
          draftOnly(draft);
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          commitNow();
        }}
        data-testid={testId ? `${testId}-input` : undefined}
      />
    </FieldShell>
  );
}

/** Date autosave input; the native picker needs no IME handling. */
export function MaterialDateField({
  label,
  committed,
  onSave,
  testId,
}: TextFieldProps) {
  const { draft, status, change, commitNow } = useAutosave<string>({
    committed,
    onSave,
    normalize: (v) => v.trim(),
  });
  return (
    <FieldShell
      label={label}
      status={status}
      onRetry={commitNow}
      testId={testId}
    >
      <Input
        type="date"
        aria-label={label}
        className="h-8"
        value={draft}
        onChange={(e) => change(e.target.value)}
        onBlur={commitNow}
        data-testid={testId ? `${testId}-input` : undefined}
      />
    </FieldShell>
  );
}

type CurrentCheckboxProps = {
  label: string;
  committed: boolean;
  onSave: (value: boolean) => Promise<boolean>;
  testId?: string;
};

/** Boolean toggle that commits immediately on change. */
export function MaterialCurrentCheckbox({
  label,
  committed,
  onSave,
  testId,
}: CurrentCheckboxProps) {
  const { draft, status, change, commitNow } = useAutosave<boolean>({
    committed,
    onSave,
  });
  return (
    <div className="flex items-end gap-2" data-testid={testId}>
      <label className="text-sm">
        <input
          type="checkbox"
          checked={draft}
          onChange={(e) => {
            change(e.target.checked);
            commitNow();
          }}
          data-testid={testId ? `${testId}-input` : undefined}
        />{" "}
        {label}
      </label>
      <SaveStatusChip status={status} onRetry={commitNow} testId={testId} />
    </div>
  );
}

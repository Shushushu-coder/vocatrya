"use client";
import { ProfileCopyButton } from "./ProfileCopyButton";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useI18n } from "@/i18n";
import { toastError, toastSuccess } from "@/lib/toast";
import { useStructuredField } from "@/lib/inputPreferences";

type ApplicationProfileFieldProps = {
  label: string;
  value?: string | null;
  emptyText?: string;
  helper?: string;
  onCopyValue?: () => Promise<string | null>;
  /**
   * When provided the row is directly editable: every committed change is
   * auto-saved through this single-field callback. Resolve true only when
   * the value was actually persisted; false keeps the draft for retry.
   */
  onSave?: (value: string | null) => Promise<boolean>;
  validate?: (value: string) => boolean;
  revealSlot?: React.ReactNode;
  editSlot?: React.ReactNode;
  testId?: string;
};

const AUTOSAVE_DEBOUNCE_MS = 700;
const SAVED_STATUS_MS = 1600;

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function ApplicationProfileField({
  label,
  value,
  emptyText,
  helper,
  onCopyValue,
  onSave,
  validate,
  revealSlot,
  editSlot,
  testId,
}: ApplicationProfileFieldProps) {
  const { t } = useI18n();
  const [copying, setCopying] = useState(false);
  const editable = typeof onSave === "function";
  // SET-INPUT-PREFERENCES: enter-behavior / edit-entry / hint prefs apply to
  // this direct-edit field only — no global key handling.
  const [validationBlocked, setValidationBlocked] = useState(false);
  const structured = useStructuredField({
    canLeave: () => !validate || validate(draftRef.current),
    onLeaveBlocked: () => setValidationBlocked(true),
  });
  // `committed` is the last value the server confirmed; the input shows it
  // verbatim until the user types (the service already stores trimmed text).
  const committed = value?.trim() ?? "";
  const [draft, setDraft] = useState(committed);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const committedRef = useRef(committed);
  const draftRef = useRef(draft);
  const inFlightRef = useRef(false);
  const composingRef = useRef(false);
  const pendingRef = useRef<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSaveRef = useRef(onSave);
  useEffect(() => {
    onSaveRef.current = onSave;
  });

  // Fold an external value change (initial load, reload) into the draft only
  // when the user has not diverged and no write is in flight — a read that
  // raced our own save must never roll the input back.
  useEffect(() => {
    if (!editable) return;
    if (committed === committedRef.current) return;
    if (inFlightRef.current) return;
    const prev = committedRef.current;
    committedRef.current = committed;
    setDraft((d) => {
      if (d !== prev) return d;
      draftRef.current = committed;
      return committed;
    });
  }, [committed, editable]);

  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  // Snap the visible draft to the stored value when it only differs by
  // whitespace (e.g. clearing a field shows "" instead of leftover spaces);
  // a draft that diverged in content is never touched.
  const syncDraftToCommitted = useCallback(() => {
    if (
      draftRef.current !== committedRef.current &&
      draftRef.current.trim() === committedRef.current
    ) {
      draftRef.current = committedRef.current;
      setDraft(committedRef.current);
    }
  }, []);

  // Saves are serialized per field: while one request is in flight, later
  // commits only replace the queued latest value. On success the queue
  // drains; on failure the draft is kept untouched for manual retry.
  const commit = useCallback(async () => {
    const save = onSaveRef.current;
    if (!save) return;
    if (validate && !validate(draftRef.current)) {
      setValidationBlocked(true);
      return;
    }
    setValidationBlocked(false);
    const target = draftRef.current.trim();
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
        // A rejected save is reported the same as a false result: keep the
        // draft, surface the error, and never leak an unhandled rejection.
        const ok = await save(current === "" ? null : current).catch(
          () => false,
        );
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
  }, [syncDraftToCommitted, validate]);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    draftRef.current = v;
    setDraft(v);
    setValidationBlocked(false);
    setStatus((s) => (s === "saving" ? s : "idle"));
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // While an IME composition is open the draft is intermediate text (e.g.
    // pinyin): committing it would flash validation errors on enum fields.
    if ((e.nativeEvent as InputEvent).isComposing) return;
    debounceRef.current = setTimeout(() => void commit(), AUTOSAVE_DEBOUNCE_MS);
  }

  function handleCompositionEnd() {
    composingRef.current = false;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void commit(), AUTOSAVE_DEBOUNCE_MS);
  }

  function handleBlur() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    void commit();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      e.currentTarget.blur();
    }
  }

  const shownText = editable ? draft.trim() : committed;
  const isEmpty = shownText.length === 0;

  async function handleCopy() {
    const text = onCopyValue ? await onCopyValue() : shownText;
    const copyText = (text ?? "").trim();
    if (!copyText) return;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(copyText);
      toastSuccess(t("common.copied"));
    } catch {
      toastError(t("applicationProfile.copyFailed"));
    } finally {
      setCopying(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 py-2" data-testid={testId}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <div className="flex items-center gap-1">
          {editable && (
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
                    onClick={() => void commit()}
                    data-testid={testId ? `${testId}-retry` : undefined}
                  >
                    {t("common.retry")}
                  </Button>
                </>
              )}
            </span>
          )}
          {revealSlot}
          {!isEmpty && (
            <ProfileCopyButton label={t("common.copy")} variant="ghost" onClick={handleCopy} disabled={copying} />
          )}
          {editSlot}
        </div>
      </div>
      <div className="text-sm text-foreground">
        {editable ? (
          <>
            <Input
              {...structured.bind}
              aria-label={label}
              value={draft}
              placeholder={emptyText ?? t("applicationProfile.emptyValue")}
              onChange={handleChange}
              onBlur={(e) => {
                structured.bind.onBlur(e);
                handleBlur();
              }}
              onKeyDown={(e) => {
                if (composingRef.current) return;
                if (!structured.bind.onKeyDown(e)) handleKeyDown(e);
              }}
              onCompositionStart={() => {
                composingRef.current = true;
                if (debounceRef.current) clearTimeout(debounceRef.current);
              }}
              onCompositionEnd={handleCompositionEnd}
              className="h-8"
              data-testid={testId ? `${testId}-input` : undefined}
            />
            {validationBlocked && (
              <div role="alert" className="text-xs text-destructive">
                {t("inputPrefs.invalidField")}
              </div>
            )}
          </>
        ) : isEmpty ? (
          <span className="text-muted-foreground">{emptyText ?? t("applicationProfile.emptyValue")}</span>
        ) : (
          <span>{committed}</span>
        )}
      </div>
      {helper && <div className="text-xs text-muted-foreground">{helper}</div>}
    </div>
  );
}

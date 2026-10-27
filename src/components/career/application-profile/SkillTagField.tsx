"use client";
import { useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader, X } from "lucide-react";
import { useI18n } from "@/i18n";
import { toastError } from "@/lib/toast";
import { getAllTags } from "@/actions/tag.actions";
import { setApplicationSkillTag } from "@/actions/applicationProfile.actions";
import { TagInput } from "@/components/myjobs/TagInput";
import { MaterialTextField } from "./MaterialAutosaveField";
import type { Tag } from "@/models/job.model";

type SkillTagFieldProps = {
  materialId: string;
  /** Live tag relation when linked; null/undefined means plain-text skill. */
  tag?: { id?: string | null; label?: string | null } | null;
  /** Stored fallback text, editable only while unlinked. */
  skillName: string;
  label: string;
  testId?: string;
  /** Text-field save handler (same single-key detail patch as other fields). */
  onSaveSkillName: (value: string) => Promise<boolean>;
  /** Reload callback after a successful link/unlink. */
  onChanged: () => Promise<void> | void;
};

/**
 * Single name source for a SKILL record (BD-LINKS): linked state shows only
 * the live Tag label plus an unlink control — no parallel text input — while
 * unlinked state keeps the normal skillName text editor and offers at most
 * one Tag via the shared dedup selector (TagInput max=1).
 */
export function SkillTagField({
  materialId,
  tag,
  skillName,
  label,
  testId,
  onSaveSkillName,
  onChanged,
}: SkillTagFieldProps) {
  const { t } = useI18n();
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [isPending, startTransition] = useTransition();
  const mutationPending = useRef(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [saveFailed, setSaveFailed] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  // The selector list is only needed while unlinked; linking flips the card
  // to the chip view and the query is skipped entirely.
  useEffect(() => {
    if (tag) return;
    let cancelled = false;
    setLoadFailed(false);
    void getAllTags().then((result) => {
      if (cancelled) return;
      if (!Array.isArray(result)) {
        setLoadFailed(true);
        return;
      }
      setAvailableTags(result as Tag[]);
    }).catch(() => {
      if (!cancelled) setLoadFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [tag, loadAttempt]);

  function applyTag(tagId: string | null) {
    if (mutationPending.current) return;
    mutationPending.current = true;
    setSaveFailed(false);
    startTransition(async () => {
      try {
        const res = await setApplicationSkillTag({ id: materialId, tagId });
        if (!res?.success) throw new Error("Skill tag save failed");
        await onChanged();
        setSelectedIds([]);
      } catch {
        setSaveFailed(true);
        toastError(t("applicationProfile.saveFailed"), undefined, { sticky: true });
      } finally {
        mutationPending.current = false;
      }
    });
  }

  if (tag?.id) {
    return (
      <div className="flex flex-col gap-1" data-testid={testId}>
        <span className="text-sm">{label}</span>
        <div className="flex h-8 items-center gap-2">
          <Badge variant="secondary" className="gap-1 pr-1">
            {tag.label}
            <button
              type="button"
              onClick={() => applyTag(null)}
              disabled={isPending}
              className="ml-1 rounded-full p-0.5 hover:bg-muted-foreground/20 disabled:opacity-50"
              aria-label={t("jobs.removeNamed", { name: tag.label ?? "" })}
              data-testid={testId ? `${testId}-unlink` : undefined}
            >
              <X className="h-3 w-3" />
            </button>
          </Badge>
          {isPending && <Loader className="h-3 w-3 spinner" />}
          {saveFailed && <Button type="button" onClick={() => applyTag(null)}>{t("common.retry")}</Button>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <fieldset disabled={isPending} className="flex min-w-0 flex-col gap-2">
      <MaterialTextField
        label={label}
        committed={skillName}
        onSave={onSaveSkillName}
        testId={testId}
      />
      <div aria-label={t("jobs.skillsNoun")}>
        <TagInput
          availableTags={availableTags}
          selectedTagIds={selectedIds}
          max={1}
          onChange={(ids) => {
            if (mutationPending.current) return;
            setSelectedIds(ids.slice(0, 1));
            setSaveFailed(false);
            const id = ids[0];
            if (id) applyTag(id);
          }}
          onTagCreated={(created) =>
            setAvailableTags((prev) =>
              prev.some((item) => item.id === created.id)
                ? prev
                : [...prev, created],
            )
          }
        />
      </div>
      </fieldset>
      {saveFailed && selectedIds[0] && (
        <Button type="button" disabled={isPending} onClick={() => applyTag(selectedIds[0])}>
          {t("common.retry")}
        </Button>
      )}
      {loadFailed && (
        <Button type="button" disabled={isPending} onClick={() => setLoadAttempt((n) => n + 1)}>
          {t("common.retry")}
        </Button>
      )}
    </div>
  );
}

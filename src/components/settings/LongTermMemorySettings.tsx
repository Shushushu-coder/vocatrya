"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { getAgentPreferences } from "@/actions/agentPreferences.actions";
import {
  clearAllUserMemory,
  editUserMemoryEntry,
  getUserMemoryEntries,
  removeUserMemoryEntry,
  saveUserMemoryEntry,
  setLongTermMemoryEnabled,
} from "@/actions/userMemory.actions";
import {
  USER_MEMORY_CATEGORIES,
  USER_MEMORY_CONTENT_MAX_CHARS,
  USER_MEMORY_MAX_ENTRIES,
  type UserMemoryCategory,
  type UserMemoryEntryDTO,
} from "@/lib/agent/longTermMemory";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type Draft = {
  id?: string;
  category: UserMemoryCategory;
  key: string;
  content: string;
};

const emptyDraft = (): Draft => ({ category: "career_goal", key: "", content: "" });

function groupEntries(entries: UserMemoryEntryDTO[]): Map<UserMemoryCategory, UserMemoryEntryDTO[]> {
  const grouped = new Map<UserMemoryCategory, UserMemoryEntryDTO[]>();
  for (const category of USER_MEMORY_CATEGORIES) grouped.set(category, []);
  for (const entry of entries) grouped.get(entry.category)?.push(entry);
  return grouped;
}

export default function LongTermMemorySettings() {
  const { t, formatDateTime } = useI18n();
  const label = useCallback(
    (key: string, params?: Record<string, string | number>) => t(`agent.longTermMemory.${key}`, params),
    [t],
  );

  const [enabled, setEnabled] = useState(true);
  const [entries, setEntries] = useState<UserMemoryEntryDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    setEntries(await getUserMemoryEntries());
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.all([getAgentPreferences(), getUserMemoryEntries()])
      .then(([preferences, rows]) => {
        if (!live) return;
        setEnabled(preferences.longTermMemoryEnabled);
        setEntries(rows);
        setLoaded(true);
      })
      .catch(() => {
        if (live) setStatus(label("loadFailed"));
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const run = useCallback(
    async (action: () => Promise<{ success: boolean; message?: string }>, okStatus: string) => {
      setBusy(true);
      setStatus("");
      let ok = false;
      try {
        const result = await action();
        ok = result.success;
        if (ok) {
          setStatus(okStatus);
          await refresh();
        } else {
          setStatus(
            result.message === "conflict"
              ? label("conflict")
              : result.message === "not_found"
                ? label("notFound")
                : result.message === "store_full"
                  ? label("storeFull")
                  : label("saveFailed"),
          );
        }
      } catch {
        setStatus(label("saveFailed"));
      } finally {
        setBusy(false);
      }
      return ok;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [refresh],
  );

  const toggle = useCallback(
    (next: boolean) => {
      setEnabled(next);
      void run(() => setLongTermMemoryEnabled(next), label("saved")).then((ok) => {
        if (!ok) setEnabled(!next);
      });
    },
    [run, label],
  );

  const submitDraft = useCallback(() => {
    if (!draft) return;
    const action = draft.id
      ? () => editUserMemoryEntry({ id: draft.id!, category: draft.category, key: draft.key, content: draft.content })
      : () => saveUserMemoryEntry({ category: draft.category, key: draft.key, content: draft.content });
    void run(action, label("saved")).then((ok) => {
      // Keep the editor open on failure so the user can fix the input.
      if (ok) setDraft(null);
    });
  }, [draft, run, label]);

  const grouped = useMemo(() => groupEntries(entries), [entries]);
  const draftChars = draft ? Array.from(draft.content).length : 0;

  return (
    <fieldset disabled={!loaded || busy} className="min-w-0 space-y-5 border-t pt-5" data-testid="long-term-memory-settings">
      <legend className="text-base font-medium">{label("title")}</legend>
      <p className="text-sm text-muted-foreground">{label("description")}</p>

      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <label htmlFor="long-term-memory-enabled" className="text-sm font-medium">
            {label("enabled")}
          </label>
          {!enabled ? (
            <p className="text-sm text-muted-foreground" data-testid="memory-disabled-hint">
              {label("disabledHint")}
            </p>
          ) : null}
        </div>
        <Switch id="long-term-memory-enabled" checked={enabled} onCheckedChange={toggle} />
      </div>

      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-muted-foreground" data-testid="memory-count">
          {label("entries", { count: entries.length, max: USER_MEMORY_MAX_ENTRIES })}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => { setDraft(emptyDraft()); setConfirmClear(false); }}>
            {label("addEntry")}
          </Button>
          <Button
            type="button"
            variant={confirmClear ? "destructive" : "outline"}
            size="sm"
            disabled={entries.length === 0}
            onClick={() => {
              if (!confirmClear) {
                setConfirmClear(true);
                return;
              }
              setConfirmClear(false);
              void run(clearAllUserMemory, label("cleared"));
            }}
          >
            {confirmClear ? label("clearAllConfirm") : label("clearAll")}
          </Button>
        </div>
      </div>

      {draft ? (
        <div className="space-y-3 rounded-md border p-3" data-testid="memory-editor">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label htmlFor="memory-category" className="text-sm font-medium">{label("categoryLabel")}</label>
              <select
                id="memory-category"
                value={draft.category}
                onChange={(event) => setDraft({ ...draft, category: event.target.value as UserMemoryCategory })}
                className="w-full rounded-md border bg-background p-2 text-sm"
              >
                {USER_MEMORY_CATEGORIES.map((category) => (
                  <option key={category} value={category}>{label(`categories.${category}`)}</option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label htmlFor="memory-key" className="text-sm font-medium">{label("keyLabel")}</label>
              <Input
                id="memory-key"
                value={draft.key}
                onChange={(event) => setDraft({ ...draft, key: event.target.value })}
                placeholder="target_cities"
                aria-describedby="memory-key-hint"
              />
              <p id="memory-key-hint" className="text-xs text-muted-foreground">{label("keyHint")}</p>
            </div>
          </div>
          <div className="space-y-1">
            <label htmlFor="memory-content" className="text-sm font-medium">{label("contentLabel")}</label>
            <Textarea
              id="memory-content"
              value={draft.content}
              onChange={(event) => setDraft({ ...draft, content: event.target.value })}
              rows={3}
            />
            <p className={draftChars > USER_MEMORY_CONTENT_MAX_CHARS ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {label("contentCount", { count: draftChars, max: USER_MEMORY_CONTENT_MAX_CHARS })}
            </p>
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!draft.key.trim() || !draft.content.trim() || draftChars > USER_MEMORY_CONTENT_MAX_CHARS}
              onClick={submitDraft}
            >
              {label("saveEntry")}
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => setDraft(null)}>
              {label("cancelEdit")}
            </Button>
          </div>
        </div>
      ) : null}

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="memory-empty">{label("empty")}</p>
      ) : (
        <div className="space-y-4" data-testid="memory-list">
          {USER_MEMORY_CATEGORIES.map((category) => {
            const rows = grouped.get(category) ?? [];
            if (rows.length === 0) return null;
            return (
              <div key={category} className="space-y-2" data-testid={`memory-category-${category}`}>
                <p className="text-sm font-medium">{label(`categories.${category}`)}</p>
                <ul className="space-y-2">
                  {rows.map((entry) => (
                    <li
                      key={entry.id}
                      className="flex items-start justify-between gap-3 rounded-md border p-3"
                      data-testid={`memory-entry-${entry.id}`}
                    >
                      <div className="min-w-0 space-y-1">
                        <p className="text-xs font-medium text-muted-foreground">
                          {entry.key}
                          <span
                            className="ml-2 rounded-sm border px-1 py-0.5 text-[10px] font-normal"
                            data-testid={`memory-source-${entry.id}`}
                          >
                            {label(entry.source === "USER_MANUAL" ? "sourceManual" : "sourceAi")}
                          </span>
                        </p>
                        <p className="text-sm break-words">{entry.content}</p>
                        <p className="text-xs text-muted-foreground">
                          {label("updatedAt", { date: formatDateTime(entry.updatedAt) })}
                        </p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setConfirmClear(false);
                            setDraft({ id: entry.id, category: entry.category, key: entry.key, content: entry.content });
                          }}
                        >
                          {label("editEntry")}
                        </Button>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => void run(() => removeUserMemoryEntry({ id: entry.id }), label("deleted"))}
                        >
                          {label("deleteEntry")}
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <p role="status" aria-live="polite" className="text-sm text-muted-foreground">{status}</p>
    </fieldset>
  );
}

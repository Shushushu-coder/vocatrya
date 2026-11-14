/**
 * Draft insertion for dictation (D7): transcript text lands in the draft
 * the recording was started from, at the cursor when the mount site can
 * supply one, appended otherwise. Never replaces existing text, never
 * sends — the user edits and sends manually.
 */
export interface DraftSelection {
  start: number;
  end: number;
}

export interface InsertedDraft {
  text: string;
  /** Cursor position after the inserted transcript. */
  cursor: number;
}

function needsLeadingSpace(draft: string, at: number): boolean {
  if (at <= 0) return false;
  return !/\s/.test(draft[at - 1]);
}

export function insertDictationText(
  draft: string,
  transcript: string,
  selection?: DraftSelection | null,
): InsertedDraft {
  const text = transcript.trim();
  if (!text) return { text: draft, cursor: draft.length };

  let start = draft.length;
  let end = draft.length;
  if (
    selection &&
    Number.isFinite(selection.start) &&
    Number.isFinite(selection.end)
  ) {
    start = Math.max(0, Math.min(draft.length, Math.min(selection.start, selection.end)));
    end = Math.max(0, Math.min(draft.length, Math.max(selection.start, selection.end)));
  }

  const before = draft.slice(0, start);
  const after = draft.slice(end);
  const leading = needsLeadingSpace(draft, start) ? " " : "";
  const trailing = after.length > 0 && !/^\s/.test(after) ? " " : "";
  const inserted = `${leading}${text}${trailing}`;
  return {
    text: `${before}${inserted}${after}`,
    cursor: before.length + inserted.length,
  };
}

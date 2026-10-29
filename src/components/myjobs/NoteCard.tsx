"use client";
import { NoteResponse } from "@/models/note.model";
import { TipTapContentViewer } from "../TipTapContentViewer";
import { Button } from "../ui/button";
import { Pencil, Trash } from "lucide-react";
import { useI18n } from "@/i18n";
import { useCareerSurfaces } from "@/context/CareerSurfacesContext";

type NoteCardProps = {
  note: NoteResponse;
  onEdit: (note: NoteResponse) => void;
  onDelete: (noteId: string) => void;
  readOnly?: boolean;
};

export function NoteCard({ note, onEdit, onDelete, readOnly }: NoteCardProps) {
  const { t, formatDateTime } = useI18n();
  const { jobMutationsEnabled } = useCareerSurfaces();

  return (
    <div className="border rounded-lg p-4 space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-sm text-muted-foreground">
          {formatDateTime(note.createdAt)}
          {note.isEdited && (
            <span className="ml-2 text-xs text-muted-foreground">
              {t("jobs.edited")}
            </span>
          )}
        </div>
        {!readOnly && <div className="flex gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={() => onEdit(note)}
            disabled={!jobMutationsEnabled}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            onClick={() => onDelete(note.id)}
            disabled={!jobMutationsEnabled}
          >
            <Trash className="h-3.5 w-3.5" />
          </Button>
        </div>}
      </div>
      <TipTapContentViewer content={note.content} />
    </div>
  );
}

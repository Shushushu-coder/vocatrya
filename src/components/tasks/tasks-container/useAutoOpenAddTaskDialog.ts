"use client";
import { useQueryDialog } from "@/hooks/useQueryDialog";

// Opens the task dialog once when the page is reached via a `?add-task=true`
// deep link, then strips the param so a refresh doesn't reopen it.
export function useAutoOpenAddTaskDialog(
  setDialogOpen: (open: boolean) => void,
) {
  useQueryDialog("add-task", () => setDialogOpen(true));
}

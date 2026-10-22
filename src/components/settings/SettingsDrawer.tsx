"use client";

import * as React from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { cn } from "@/lib/utils";
import { useSettingsText } from "./SettingsSidebar";

// Local Settings detail drawer, per the V1 spec a right-side panel of about
// 420-480px that keeps the calling list mounted underneath. Downstream
// packages (e.g. connection details, assignment editing) compose this shell
// inside their own files; the props below are the frozen seam.
export interface SettingsDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** True while the drawer holds edits that are not yet persisted. Closing it
   *  then — via Esc, the overlay, or the X button — first asks the user to
   *  confirm discarding the changes instead of losing them silently. */
  hasUnsavedChanges?: boolean;
  /** Called after the user confirms discarding unsaved changes, right before
   *  onOpenChange(false) is emitted. */
  onDiscard?: () => void;
  footer?: React.ReactNode;
  contentClassName?: string;
  children: React.ReactNode;
}

export default function SettingsDrawer({
  open,
  onOpenChange,
  title,
  description,
  hasUnsavedChanges = false,
  onDiscard,
  footer,
  contentClassName,
  children,
}: SettingsDrawerProps) {
  // Declared keys ship to INT-01 separately; until they land, use the frozen
  // English fallback text (same helper as the sidebar/page).
  const text = useSettingsText();
  const [confirmingDiscard, setConfirmingDiscard] = React.useState(false);

  const requestOpenChange = (next: boolean) => {
    if (next === open) return;
    if (!next && hasUnsavedChanges) {
      setConfirmingDiscard(true);
      return;
    }
    onOpenChange(next);
  };

  const confirmDiscard = () => {
    setConfirmingDiscard(false);
    onDiscard?.();
    onOpenChange(false);
  };

  return (
    <>
      <Sheet open={open} onOpenChange={requestOpenChange}>
        <SheetContent
          side="right"
          className={cn("flex w-full flex-col sm:max-w-md", contentClassName)}
        >
          <SheetHeader className="text-left">
            <SheetTitle>{title}</SheetTitle>
            {description ? (
              <SheetDescription>{description}</SheetDescription>
            ) : null}
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
          {footer ? <SheetFooter>{footer}</SheetFooter> : null}
        </SheetContent>
      </Sheet>
      <AlertDialog
        open={confirmingDiscard}
        onOpenChange={setConfirmingDiscard}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {text("settings.drawer.discardTitle", "Discard unsaved changes?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {text(
                "settings.drawer.discardDescription",
                "This panel has unsaved changes. Closing it will discard them.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {text("settings.drawer.keepEditing", "Keep editing")}
            </AlertDialogCancel>
            <AlertDialogAction onClick={confirmDiscard}>
              {text("settings.drawer.discardAction", "Discard changes")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

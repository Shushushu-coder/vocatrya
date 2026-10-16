import { toast } from "sonner";
import type { ActionResult } from "@/models/action.model";

export interface ToastOptions {
  // A sticky toast does not auto-dismiss; the close button stays available.
  sticky?: boolean;
}

// Identical notifications share one sonner id, so a repeat updates the
// existing toast in place instead of stacking another copy on top of it.
function dedupeId(kind: string, title: string | undefined, message: string) {
  return `vocatrya:${kind}:${title ?? ""}:${message}`;
}

export function toastSuccess(message: string, title?: string, opts?: ToastOptions) {
  const id = dedupeId("success", title, message);
  if (title) toast.success(title, { id, description: message, duration: opts?.sticky ? Infinity : undefined });
  else toast.success(message, { id, duration: opts?.sticky ? Infinity : undefined });
}

export function toastError(message?: string, title?: string, opts?: ToastOptions) {
  const text = message ?? "Something went wrong. Please try again.";
  const id = dedupeId("error", title, text);
  if (title) toast.error(title, { id, description: text, duration: opts?.sticky ? Infinity : undefined });
  else toast.error(text, { id, duration: opts?.sticky ? Infinity : undefined });
}

// For outcomes that are neither: a deliberate interruption is not an error.
export function toastInfo(message: string, title?: string, opts?: ToastOptions) {
  const id = dedupeId("info", title, message);
  if (title) toast.info(title, { id, description: message, duration: opts?.sticky ? Infinity : undefined });
  else toast.info(message, { id, duration: opts?.sticky ? Infinity : undefined });
}

// Collapses the repeated success/error branch into one call.
export function toastActionResult<T>(
  result: ActionResult<T> | undefined,
  opts: { success: string; onSuccess?: (data: T | undefined) => void; error?: string },
) {
  if (result?.success) {
    toastSuccess(opts.success);
    opts.onSuccess?.(result.data);
  } else {
    toastError(result?.message ?? opts.error);
  }
}

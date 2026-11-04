"use client";
import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

export type TaskDialogPrefill = {
  title?: string;
  description?: string;
};

// Opens the task dialog once when the page is reached via a `?add-task=true`
// deep link, then strips the param so a refresh doesn't reopen it. Optional
// `prefillTitle`/`prefillDescription` params seed the new-task form (the
// reflection-to-task handoff uses them) and are stripped alongside.
export function useAutoOpenAddTaskDialog(
  onOpen: (prefill: TaskDialogPrefill | null) => void,
) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const handled = useRef(false);

  useEffect(() => {
    if (searchParams.get("add-task") !== "true") {
      handled.current = false;
      return;
    }
    if (handled.current) return;
    handled.current = true;
    const title = searchParams.get("prefillTitle");
    const description = searchParams.get("prefillDescription");
    onOpen(title || description ? { title: title ?? undefined, description: description ?? undefined } : null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("add-task");
    params.delete("prefillTitle");
    params.delete("prefillDescription");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [onOpen, pathname, router, searchParams]);
}

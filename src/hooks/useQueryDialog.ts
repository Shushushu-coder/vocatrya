"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Consume each toolbar deep link once, then allow a later click on the same
// page to open the form again. Preserve unrelated filters in the URL.
export function useQueryDialog(
  parameter: string,
  onOpen: () => void,
  enabled = true,
) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const handled = useRef(false);

  useEffect(() => {
    if (searchParams.get(parameter) !== "true") {
      handled.current = false;
      return;
    }
    if (!enabled || handled.current) return;
    handled.current = true;
    onOpen();
    const params = new URLSearchParams(searchParams.toString());
    params.delete(parameter);
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [enabled, onOpen, parameter, pathname, router, searchParams]);
}

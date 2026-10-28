"use client";

import type { ComponentProps } from "react";
import { CopyIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function ProfileCopyButton({
  label,
  className,
  ...props
}: Omit<ComponentProps<typeof Button>, "children"> & { label: string }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      {...props}
      className={cn("size-7 shrink-0", className)}
      aria-label={label}
      title={label}
    >
      <CopyIcon className="size-3.5" aria-hidden="true" />
    </Button>
  );
}

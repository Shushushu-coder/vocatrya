"use client";

import { useTheme } from "next-themes";
import { Toaster as Sonner } from "sonner";

export function Toaster() {
  const { resolvedTheme } = useTheme();

  return (
    <Sonner
      theme={resolvedTheme as "light" | "dark" | undefined}
      position="bottom-right"
      style={{
        "--success-bg": "color-mix(in srgb, hsl(var(--success)) 10%, hsl(var(--popover)))",
        "--success-border": "hsl(var(--success) / 0.4)",
        "--success-text": "hsl(var(--success))",
        "--warning-bg": "color-mix(in srgb, hsl(var(--warning)) 10%, hsl(var(--popover)))",
        "--warning-border": "hsl(var(--warning) / 0.4)",
        "--warning-text": "hsl(var(--warning))",
        "--error-bg": "color-mix(in srgb, hsl(var(--destructive-text)) 10%, hsl(var(--popover)))",
        "--error-border": "hsl(var(--destructive-text) / 0.4)",
        "--error-text": "hsl(var(--destructive-text))",
      } as React.CSSProperties}
      richColors
      closeButton
    />
  );
}
